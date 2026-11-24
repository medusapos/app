import type { AuthenticatedMedusaRequest as Req, MedusaResponse as Res } from '@medusajs/framework/http'
import { answered, tillSide } from '../../../display-errors'

/** decline */
export const POST = (req: Req, res: Res) => answered(res, 204, async () => {
  const { service, device } = await tillSide(req)
  await service.decline(device, req.params.claimId)
})
