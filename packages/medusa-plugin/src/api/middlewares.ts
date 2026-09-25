import { authenticate, defineMiddlewares } from '@medusajs/framework/http'
import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import type { ConfigModule } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, parseCorsOrigins } from '@medusajs/framework/utils'
import cors from 'cors'

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
      // Allow 50 commands of up to ~20 kB each.
      bodyParser: { sizeLimit: '1mb' },
      middlewares: [authenticate('user', ['bearer', 'session'])],
    },
    { matcher: '/tally/v1/info', middlewares: [tallyCors('GET')] },
    { matcher: '/tally/v1/info', method: 'GET', middlewares: [authenticate('user', ['bearer', 'session'])] },
  ],
})
