import type { EntityManager } from '@medusajs/framework/mikro-orm/postgresql'
import type { Context, InferTypeOf } from '@medusajs/framework/types'
import type { CommandResult } from '@tallyui/core'
import { randomUUID } from 'node:crypto'
import {
  InjectManager,
  MedusaContext,
  MedusaError,
  MedusaService,
} from '@medusajs/framework/utils'
import { TallyCommand } from './models/tally-command'
import { parseCommandResult } from './command-result'
import type { TallyPluginOptions } from '../../workflows/tally-order-create'

export type TallyCommandRecord = InferTypeOf<typeof TallyCommand>

/** A claim left in_progress this long is presumed abandoned (worker crash);
 *  the same command may then be claimed again. An order.create runs in
 *  seconds; two minutes keeps a retrying register waiting briefly while
 *  staying far above a slow run. See docs/adr/0001-command-ledger-lease.md. */
export const CLAIM_LEASE_SECONDS = 120

export default class TallyLedgerModuleService extends MedusaService({ TallyCommand }) {
  private readonly options: TallyPluginOptions

  constructor(container: Record<string, unknown>, options: TallyPluginOptions = {}) {
    super(...arguments)
    this.options = options
  }

  getPluginOptions(): TallyPluginOptions {
    return this.options
  }

  @InjectManager()
  async assertClaim(
    id: string,
    claimToken: string,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    const rows = await (sharedContext.manager as EntityManager).execute(
      `select "id" from "tally_command" where "id" = ? and "status" = 'in_progress' and "claim_token" = ?`,
      [id, claimToken]
    )
    if (rows.length === 0) throw new MedusaError(MedusaError.Types.CONFLICT, 'claim lost')
  }

  @InjectManager()
  async claim(
    input: { id: string; type: string; fingerprint: string },
    @MedusaContext() sharedContext: Context = {}
  ): Promise<
    | { claimed: true; claimToken: string; command: TallyCommandRecord }
    | { claimed: false; command: TallyCommandRecord }
  > {
    const claimToken = randomUUID()
    const inserted = await (sharedContext.manager as EntityManager).execute(
      `insert into "tally_command" ("id", "type", "fingerprint", "claim_token") values (?, ?, ?, ?)
       on conflict ("id") do update set "claim_token" = excluded."claim_token", "updated_at" = now()
         where "tally_command"."status" = 'in_progress'
           and "tally_command"."fingerprint" = excluded."fingerprint"
           and "tally_command"."updated_at" < now() - make_interval(secs => ?)
       returning "id"`,
      [input.id, input.type, input.fingerprint, claimToken, CLAIM_LEASE_SECONDS]
    )
    let command: TallyCommandRecord
    try {
      command = await this.retrieveTallyCommand(input.id, {}, sharedContext)
    } catch (error) {
      if (error instanceof MedusaError && error.type === MedusaError.Types.NOT_FOUND) {
        throw new MedusaError(MedusaError.Types.CONFLICT, `Tally command ${input.id} was released; retry the claim`)
      }
      throw error
    }
    if (command.result !== null) command.result = { ...parseCommandResult(command.result) }
    return inserted.length > 0 ? { claimed: true, claimToken, command } : { claimed: false, command }
  }

  @InjectManager()
  async complete(
    id: string,
    claimToken: string,
    result: CommandResult,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<TallyCommandRecord> {
    const parsed = parseCommandResult(result)
    if (parsed.id !== id || parsed.status === 'duplicate') {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, parsed.id !== id ? 'Invalid result.id' : 'Invalid result.status')
    }
    const updated = await (sharedContext.manager as EntityManager).execute(
      `update "tally_command" set "status" = ?, "result" = ?::jsonb, "updated_at" = now()
       where "id" = ? and "status" = 'in_progress' and "claim_token" = ?
       returning "id"`,
      [parsed.status, JSON.stringify(parsed), id, claimToken]
    )
    const command = await this.retrieveTallyCommand(id, {}, sharedContext)
    if (updated.length === 0) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Tally command ${id} is already finished or its claim was lost`
      )
    }
    command.result = { ...parseCommandResult(command.result) }
    return command
  }

  @InjectManager()
  async release(
    id: string,
    claimToken: string,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    await (sharedContext.manager as EntityManager).execute(
      `delete from "tally_command" where "id" = ? and "status" = 'in_progress' and "claim_token" = ?`,
      [id, claimToken]
    )
  }
}
