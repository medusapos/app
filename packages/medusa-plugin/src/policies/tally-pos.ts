import { definePolicies } from '@medusajs/framework/utils'

export const TallyPosPolicies = definePolicies([
  {
    name: 'UseTallyPos', resource: 'tally_pos', operation: 'use',
    description: 'Sign in to the POS and send its commands',
  },
  {
    name: 'ApproveTallyPosVariance', resource: 'tally_pos', operation: 'approve_variance',
    description: 'Approve a register close over the variance threshold',
  },
  {
    name: 'ClearTallyPosDevice', resource: 'tally_pos', operation: 'clear_device',
    description: "Approve clearing all of a POS device's local data",
  },
])

export const TALLY_POS_USE = { resource: 'tally_pos', operation: 'use' }
