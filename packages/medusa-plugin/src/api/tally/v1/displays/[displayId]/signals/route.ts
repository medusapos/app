import type { AuthenticatedMedusaRequest as Req, MedusaResponse as Res } from '@medusajs/framework/http'
import { answered, signal, tillSide } from '../../../display-errors'

/** sendSignal */
export const POST = (req: Req, res: Res) => answered(res, 204, async () => {
  const { service, device } = await tillSide(req)
  await service.sendSignal(device, req.params.displayId, signal(req))
})
