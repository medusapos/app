import type { AuthenticatedMedusaRequest as Req, MedusaResponse as Res } from '@medusajs/framework/http'
import { answered, tillSide } from '../../display-errors'

/** receiveSignals */
export const POST = (req: Req, res: Res) => answered(res, 200, async () => {
  const { service, device } = await tillSide(req)
  return { signals: await service.receiveSignals(device) }
})
