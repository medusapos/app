import type { ExecArgs, Logger } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { TALLY_LEDGER_MODULE } from '../modules/tally-ledger'
import type TallyLedgerModuleService from '../modules/tally-ledger/service'
import { TALLY_SYNC_MODULE } from '../modules/tally-sync'
import type TallySyncModuleService from '../modules/tally-sync/service'

// A since without an explicit Z or ±hh:mm offset is ambiguous (the server's local zone), so it is rejected below.
const SINCE_TIMEZONE_RE = /(?:Z|[+-]\d{2}:\d{2})$/

/** Journals products changed outside the server since args[0] (a required ISO timestamp with an explicit timezone). */
export default async function tallySyncRescan({ container, args }: ExecArgs) {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
  if (!container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE).getPluginOptions().experimentalSync) {
    logger.info('tally_sync rescan: experimentalSync is off, nothing to do')
    return
  }
  if (!args[0]) {
    logger.error('tally_sync rescan: usage: medusa exec <script> <since ISO timestamp with a timezone, e.g. the time your import started>')
    process.exitCode = 1
    return
  }
  if (!SINCE_TIMEZONE_RE.test(args[0]) || Number.isNaN(Date.parse(args[0]))) {
    logger.error('tally_sync rescan: since must include a timezone, e.g. 2026-09-29T10:00:00Z or 2026-09-29T20:00:00+10:00')
    process.exitCode = 1
    return
  }
  try {
    const result = await container.resolve<TallySyncModuleService>(TALLY_SYNC_MODULE).rescan(args[0])
    logger.info(result ? `tally_sync rescan: ${result.rows} products journaled since ${result.since}` : 'tally_sync rescan: journal not initialized')
  } catch (error) {
    logger.error(`tally_sync rescan: failed: ${error}`)
    process.exitCode = 1
  }
}
