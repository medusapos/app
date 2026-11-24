import type { MedusaRequest as Req, MedusaResponse as Res } from '@medusajs/framework/http'
import { answered, displaySide } from '../../display-errors'

/** readSnapshot: gated by the token like every display call. */
export const GET = (req: Req, res: Res) => answered(res, 200, async () => {
  const { service, token } = displaySide(req)
  return { snapshot: await service.readSnapshot(token) }
})
