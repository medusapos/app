import type { AuthenticatedMedusaRequest as Req, MedusaResponse as Res } from '@medusajs/framework/http'
import { answered, tillSide } from '../../display-errors'

/** forget */
export const DELETE = (req: Req, res: Res) => answered(res, 204, async () => {
  const { service, device } = await tillSide(req)
  await service.forget(device, req.params.displayId)
})
