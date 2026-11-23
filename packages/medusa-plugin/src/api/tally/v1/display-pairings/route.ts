import type { AuthenticatedMedusaRequest as Req, MedusaResponse as Res } from '@medusajs/framework/http'
import { answered, tillSide } from '../display-errors'

/** pending */
export const GET = (req: Req, res: Res) => answered(res, 200, async () => {
  const { service, device } = await tillSide(req)
  return { pairings: await service.pending(device) }
})
