import type { ExecArgs, Logger } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { TALLY_LEDGER_MODULE } from '../modules/tally-ledger'
import type TallyLedgerModuleService from '../modules/tally-ledger/service'
import { TALLY_SYNC_MODULE } from '../modules/tally-sync'
import type TallySyncModuleService from '../modules/tally-sync/service'

/** Journals products changed outside the server since args[0] (an ISO timestamp) or the latest journal row. */
export default async function tallySyncRescan({ container, args }: ExecArgs) {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER)
  if (!container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE).getPluginOptions().experimentalSync) {
    logger.info('tally_sync rescan: experimentalSync is off, nothing to do')
    return
  }
  if (!args[0]) {
    logger.info('tally_sync rescan: usage: medusa exec <script> <since ISO timestamp, e.g. the time your import started>')
    return
  }
  const result = await container.resolve<TallySyncModuleService>(TALLY_SYNC_MODULE).rescan(args[0])
  logger.info(result ? `tally_sync rescan: ${result.rows} products journaled since ${result.since}` : 'tally_sync rescan: journal not initialized')
}
