import type { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { TALLY_DISPLAY_MODULE } from '../modules/tally-display'
import type TallyDisplayModuleService from '../modules/tally-display/service'

// npx medusa exec <built path>/tally-display-reset.js <deviceId>
// Deletes one till device with every display, token, snapshot, code, pending pairing and signal it owns, so the id
// registers as a new device (never back to the keyless pre-migration state). See the plugin README.
export default async function tallyDisplayReset({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const [deviceId] = args
  if (!deviceId) {
    logger.error('Usage: medusa exec tally-display-reset.js <deviceId>')
    process.exitCode = 1
    return
  }
  const gone = await container.resolve<TallyDisplayModuleService>(TALLY_DISPLAY_MODULE).resetDevice(deviceId)
  logger.info(`tally_display_reset: device ${gone.device ? 'deleted' : 'not found'}, ` +
    `${gone.displays} displays, ${gone.codes} codes, ${gone.pending} pending pairings deleted`)
}
