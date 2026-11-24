import type { AuthenticatedMedusaRequest as Req, MedusaResponse as Res } from '@medusajs/framework/http'
import { answered, snapshot, tillSide } from '../../../display-errors'

/** postSnapshot: `{ snapshot: <any JSON> }` (Express's parser refuses a bare primitive); the 204 800-byte cap is on `snapshot`. */
export const PUT = (req: Req, res: Res) => answered(res, 204, async () => {
  const { service, device } = await tillSide(req)
  await service.postSnapshot(device, req.params.displayId, snapshot(req))
})
