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
])

export const TALLY_POS_USE = { resource: 'tally_pos', operation: 'use' }
