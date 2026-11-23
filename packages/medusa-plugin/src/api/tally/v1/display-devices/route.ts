import type { AuthenticatedMedusaRequest as Req, MedusaResponse as Res } from '@medusajs/framework/http'
import { answered, fields, text, tillSide } from '../display-errors'

/** registerDevice: the device id is in the body, and the key is answered once, here only. */
export const POST = (req: Req, res: Res) => answered(res, 201, async () => {
  const { service, cashierId } = await tillSide(req)
  return service.registerDevice(cashierId, text(fields(req).deviceId, 'deviceId', 128))
})
