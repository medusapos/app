import type { MedusaRequest as Req, MedusaResponse as Res } from '@medusajs/framework/http'
import { answered, displaySide } from '../../../display-errors'

/** displayReceiveSignals */
export const POST = (req: Req, res: Res) => answered(res, 200, async () => {
  const { service, token } = displaySide(req)
  return { signals: await service.displayReceiveSignals(token) }
})
