import type { MedusaRequest as Req, MedusaResponse as Res } from '@medusajs/framework/http'
import { answered, displaySide, signal } from '../../display-errors'

/** displaySendSignal */
export const POST = (req: Req, res: Res) => answered(res, 204, async () => {
  const { service, token, source } = displaySide(req)
  await service.displaySendSignal(token, signal(req), source)
})
