import { Module } from '@medusajs/framework/utils'
import TallyDisplayModuleService from './service'

export const TALLY_DISPLAY_MODULE = 'tally_display'

export default Module(TALLY_DISPLAY_MODULE, { service: TallyDisplayModuleService })
