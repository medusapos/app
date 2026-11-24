import type { MedusaRequest as Req, MedusaResponse as Res } from '@medusajs/framework/http'
import { answered, displaySide, fields, text } from '../../display-errors'

/** claim: no login; failed claims are limited per source (req.ip) and store-wide. */
export const POST = (req: Req, res: Res) => answered(res, 201, async () => {
  const body = fields(req)
  const request = { code: text(body.code, 'code', 32), displayName: text(body.displayName, 'displayName', 100),
    token: text(body.token, 'token', 128, true) }
  const { service, source } = displaySide(req)
  return service.claim(source, request)
})
