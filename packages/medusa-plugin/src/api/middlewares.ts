import { authenticate, defineMiddlewares } from '@medusajs/framework/http'
import type { MedusaNextFunction, MedusaRequest, MedusaResponse, MiddlewareRoute } from '@medusajs/framework/http'
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

// Customer display (TallyUI ADR-085): the till side carries its device in two headers; the display side has no
// login and carries its token in one header, so its routes take CORS only.
type Verb = 'GET' | 'POST' | 'PUT' | 'DELETE'
const displayCors = (method: Verb, headers: string[]) => (req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) => {
  const config = req.scope.resolve<ConfigModule>(ContainerRegistrationKeys.CONFIG_MODULE)
  return cors({
    origin: parseCorsOrigins(config.projectConfig.http.adminCors),
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-Tally-Protocol', ...headers],
    methods: [method, 'OPTIONS'],
  })(req, res, next)
}
// Every display entry names its methods, so its matcher is exact, never a prefix of another route.
const tillDisplayRoute = (matcher: string, method: Verb, bodyParser?: { sizeLimit: string }): MiddlewareRoute[] => [
  { matcher, methods: [method, 'OPTIONS'], middlewares: [displayCors(method, ['Authorization', 'X-Tally-Device-Id', 'X-Tally-Device-Key'])] },
  { matcher, methods: [method], ...(bodyParser ? { bodyParser } : {}), middlewares: [authenticate('user', ['bearer', 'session'])] },
  { matcher, methods: [method], policies: [TALLY_POS_USE] },
]
const displaySideRoute = (matcher: string, method: Verb): MiddlewareRoute =>
  ({ matcher, methods: [method, 'OPTIONS'], middlewares: [displayCors(method, ['X-Tally-Display-Token'])] })

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
    { matcher: '/tally/v1/payment-providers', middlewares: [tallyCors('GET')] },
    { matcher: '/tally/v1/payment-providers', methods: ['GET'], middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/payment-providers', methods: ['GET'], policies: [TALLY_POS_USE] },
    { matcher: '/tally/v1/register-approvals', middlewares: [tallyCors('POST')] },
    { matcher: '/tally/v1/register-approvals', methods: ['POST'], middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/register-approvals', methods: ['POST'], policies: [TALLY_POS_USE] },
    { matcher: '/tally/v1/device-clear-approvals', middlewares: [tallyCors('POST')] },
    { matcher: '/tally/v1/device-clear-approvals', methods: ['POST'], middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/device-clear-approvals', methods: ['POST'], policies: [TALLY_POS_USE] },
    { matcher: '/tally/v1/promotions/preview', middlewares: [tallyCors('POST')] },
    { matcher: '/tally/v1/promotions/preview', methods: ['POST'], middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/promotions/preview', methods: ['POST'], policies: [TALLY_POS_USE] },
    { matcher: '/tally/v1/registers/:id', middlewares: [tallyCors('GET')] },
    { matcher: '/tally/v1/registers/:id', methods: ['GET'], middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/registers/:id', methods: ['GET'], policies: [TALLY_POS_USE] },
    { matcher: '/tally/v1/registers/:id/closures', middlewares: [tallyCors('GET')] },
    { matcher: '/tally/v1/registers/:id/closures', methods: ['GET'], middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/registers/:id/closures', methods: ['GET'], policies: [TALLY_POS_USE] },
    // A matcher without methods is a prefix, so this CORS entry names its methods to stay off /orders/:id/receipt-email.
    { matcher: '/tally/v1/orders', methods: ['GET', 'OPTIONS'], middlewares: [tallyCors('GET')] },
    { matcher: '/tally/v1/orders', methods: ['GET'], middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/orders', methods: ['GET'], policies: [TALLY_POS_USE] },
    { matcher: '/tally/v1/orders/:id/receipt-email', middlewares: [tallyCors('POST')] },
    { matcher: '/tally/v1/orders/:id/receipt-email', methods: ['POST'], middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/orders/:id/receipt-email', methods: ['POST'], policies: [TALLY_POS_USE] },
    { matcher: '/tally/v1/changes', middlewares: [tallyCors('GET')] },
    { matcher: '/tally/v1/changes', methods: ['GET'], middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/changes', methods: ['GET'], policies: [TALLY_POS_USE] },
    { matcher: '/tally/v1/changes/tick', middlewares: [tallyCors('GET')] },
    { matcher: '/tally/v1/changes/tick', methods: ['GET'], middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/changes/tick', methods: ['GET'], policies: [TALLY_POS_USE] },
    ...tillDisplayRoute('/tally/v1/display-devices', 'POST'),
    ...tillDisplayRoute('/tally/v1/display-codes', 'POST'),
    ...tillDisplayRoute('/tally/v1/display-pairings', 'GET'),
    ...tillDisplayRoute('/tally/v1/display-pairings/:claimId/confirm', 'POST'),
    ...tillDisplayRoute('/tally/v1/display-pairings/:claimId/decline', 'POST'),
    ...tillDisplayRoute('/tally/v1/displays', 'GET'),
    ...tillDisplayRoute('/tally/v1/displays/:displayId', 'DELETE'),
    ...tillDisplayRoute('/tally/v1/displays/:displayId/signals', 'POST'),
    // Over the snapshot cap (204 800 bytes of JSON), so an over-cap body reaches the handler and answers too_large.
    ...tillDisplayRoute('/tally/v1/displays/:displayId/snapshot', 'PUT', { sizeLimit: '256kb' }),
    ...tillDisplayRoute('/tally/v1/display-signals/drain', 'POST'),
    displaySideRoute('/tally/v1/display/claim', 'POST'),
    displaySideRoute('/tally/v1/display/collect', 'POST'),
    displaySideRoute('/tally/v1/display/signals', 'POST'),
    displaySideRoute('/tally/v1/display/signals/drain', 'POST'),
    displaySideRoute('/tally/v1/display/snapshot', 'GET'),
  ],
})
