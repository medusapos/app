import { authenticate, defineMiddlewares, errorHandler } from '@medusajs/framework/http'
import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import type { ConfigModule } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, parseCorsOrigins } from '@medusajs/framework/utils'
import cors from 'cors'
import { MAX_BODY_BYTES } from './tally/v1/commands/process'

const medusaErrorHandler = errorHandler()

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
      method: 'POST',
      bodyParser: { sizeLimit: MAX_BODY_BYTES },
      middlewares: [authenticate('user', ['bearer', 'session'])],
    },
    { matcher: '/tally/v1/info', middlewares: [tallyCors('GET')] },
    { matcher: '/tally/v1/info', method: 'GET', middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/registers/:id', middlewares: [tallyCors('GET')] },
    { matcher: '/tally/v1/registers/:id', method: 'GET', middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/changes', middlewares: [tallyCors('GET')] },
    { matcher: '/tally/v1/changes', method: 'GET', middlewares: [authenticate('user', ['bearer', 'session'])] },
    { matcher: '/tally/v1/changes/tick', middlewares: [tallyCors('GET')] },
    { matcher: '/tally/v1/changes/tick', method: 'GET', middlewares: [authenticate('user', ['bearer', 'session'])] },
  ],
  // Medusa wraps route middlewares as 3-argument handlers, so only this app-wide hook sees body-parser
  // errors. It gives the commands endpoint's oversized body a code and leaves every other error to Medusa.
  errorHandler: (err, req, res, next) => {
    if (req.path === '/tally/v1/commands' && err?.type === 'entity.too.large') {
      return void res.status(413).json({ code: 'body_too_large', maxBytes: MAX_BODY_BYTES, message: 'Request body over 1 MB' })
    }
    return medusaErrorHandler(err, req, res, next)
  },
})
