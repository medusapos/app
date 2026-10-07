import { authenticate, defineMiddlewares } from '@medusajs/framework/http'
import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import type { ConfigModule } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, parseCorsOrigins } from '@medusajs/framework/utils'
import cors from 'cors'
import { json } from 'express'
import { TALLY_POS_USE } from '../policies/tally-pos'
import { MAX_BODY_BYTES } from './tally/v1/commands/process'

// The commands route skips Medusa's body parsers and parses here, so its over-size answer stays on this
// route: Medusa's errorHandler hook is app-wide and would take over the host store's own error handling.
const parseCommandsJson = json({ limit: MAX_BODY_BYTES })
const commandsBody = (req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) =>
  parseCommandsJson(req, res, (err?: { type?: string }) => {
    if (err?.type !== 'entity.too.large') return next(err)
    res.status(413).json({ code: 'body_too_large', maxBytes: MAX_BODY_BYTES, message: `Request body over ${MAX_BODY_BYTES} bytes` })
  })

const tallyCors = (method: 'GET' | 'POST') => (req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) => {
  const config = req.scope.resolve<ConfigModule>(ContainerRegistrationKeys.CONFIG_MODULE)
  return cors({
    origin: parseCorsOrigins(config.projectConfig.http.adminCors),
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Tally-Protocol'],
    methods: [method, 'OPTIONS'],
  })(req, res, next)
}

export default defineMiddlewares({
  routes: [
    { matcher: '/tally/v1/commands', middlewares: [tallyCors('POST')] },
    {
      matcher: '/tally/v1/commands',
      methods: ['POST'],
      bodyParser: false,
      middlewares: [authenticate('user', ['bearer', 'session']), commandsBody],
    },
    // Policies need a separate entry: sharing one would run the check before authenticate.
    { matcher: '/tally/v1/commands', methods: ['POST'], policies: [TALLY_POS_USE] },
    { matcher: '/tally/v1/info', middlewares: [tallyCors('GET')] },
    { matcher: '/tally/v1/info', methods: ['GET'], middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/info', methods: ['GET'], policies: [TALLY_POS_USE] },
    { matcher: '/tally/v1/registers/:id', middlewares: [tallyCors('GET')] },
    { matcher: '/tally/v1/registers/:id', methods: ['GET'], middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/registers/:id', methods: ['GET'], policies: [TALLY_POS_USE] },
    { matcher: '/tally/v1/changes', middlewares: [tallyCors('GET')] },
    { matcher: '/tally/v1/changes', methods: ['GET'], middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/changes', methods: ['GET'], policies: [TALLY_POS_USE] },
    { matcher: '/tally/v1/changes/tick', middlewares: [tallyCors('GET')] },
    { matcher: '/tally/v1/changes/tick', methods: ['GET'], middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/changes/tick', methods: ['GET'], policies: [TALLY_POS_USE] },
  ],
})
