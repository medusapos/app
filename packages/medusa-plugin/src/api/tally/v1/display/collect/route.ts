import type { MedusaRequest as Req, MedusaResponse as Res } from '@medusajs/framework/http'
import { answered, displaySide, fields, text } from '../../display-errors'

/** collect: pending with the check code, then the token once. */
export const POST = (req: Req, res: Res) => answered(res, 200, async () => {
  const claimSecret = text(fields(req).claimSecret, 'claimSecret', 128)
  const { service, source } = displaySide(req)
  return service.collect(claimSecret, source)
})
