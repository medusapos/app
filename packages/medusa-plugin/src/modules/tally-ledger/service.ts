import type { EntityManager } from '@medusajs/framework/mikro-orm/postgresql'
import type { Context, InferTypeOf } from '@medusajs/framework/types'
import {
  InjectManager,
  MedusaContext,
  MedusaError,
  MedusaService,
} from '@medusajs/framework/utils'
import { TallyCommand } from './models/tally-command'

export type TallyCommandRecord = InferTypeOf<typeof TallyCommand>
export type FinishedStatus = 'applied' | 'rejected'

export default class TallyLedgerModuleService extends MedusaService({ TallyCommand }) {
  @InjectManager()
  async claim(
    input: { id: string; type: string; fingerprint: string },
    @MedusaContext() sharedContext: Context = {}
  ): Promise<{ claimed: boolean; command: TallyCommandRecord }> {
    const inserted = await (sharedContext.manager as EntityManager).execute(
      `insert into "tally_command" ("id", "type", "fingerprint") values (?, ?, ?) on conflict ("id") do nothing returning "id"`,
      [input.id, input.type, input.fingerprint]
    )
    const command = await this.retrieveTallyCommand(input.id, {}, sharedContext)
    return { claimed: inserted.length > 0, command }
  }

  @InjectManager()
  async complete(
    id: string,
    status: FinishedStatus,
    result: Record<string, unknown>,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<TallyCommandRecord> {
    const command = await this.retrieveTallyCommand(id, {}, sharedContext)
    if (command.status !== 'in_progress') {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Tally command ${id} is already finished`
      )
    }
    return await this.updateTallyCommands({ id, status, result }, sharedContext)
  }

  @InjectManager()
  async release(
    id: string,
    @MedusaContext() sharedContext: Context = {}
  ): Promise<void> {
    await (sharedContext.manager as EntityManager).execute(
      `delete from "tally_command" where "id" = ? and "status" = 'in_progress'`,
      [id]
    )
  }
}
