import { Module } from '@medusajs/framework/utils'
import TallyRegisterModuleService from './service'

export const TALLY_REGISTER_MODULE = 'tally_register'

export default Module(TALLY_REGISTER_MODULE, { service: TallyRegisterModuleService })
