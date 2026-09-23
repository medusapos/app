import { Module } from '@medusajs/framework/utils'
import TallyLedgerModuleService from './service'

export const TALLY_LEDGER_MODULE = 'tally_ledger'

export default Module(TALLY_LEDGER_MODULE, { service: TallyLedgerModuleService })
