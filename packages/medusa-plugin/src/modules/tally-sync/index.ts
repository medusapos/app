import { Module } from '@medusajs/framework/utils'
import TallySyncModuleService from './service'

export const TALLY_SYNC_MODULE = 'tally_sync'
// Retention is deferred to P3 (ADR 0020).
export const HORIZON = 0

export default Module(TALLY_SYNC_MODULE, { service: TallySyncModuleService })
