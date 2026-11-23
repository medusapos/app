import type { AuthenticatedMedusaRequest as Req, MedusaResponse as Res } from '@medusajs/framework/http'
import { answered, tillSide } from '../../../display-errors'

/** confirm */
export const POST = (req: Req, res: Res) => answered(res, 204, async () => {
  const { service, device, cashierId } = await tillSide(req)
  await service.confirm(device, cashierId, req.params.claimId)
})
