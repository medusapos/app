import { authenticate, defineMiddlewares } from '@medusajs/framework/http'
import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import type { ConfigModule } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, parseCorsOrigins } from '@medusajs/framework/utils'
import cors from 'cors'

export default defineMiddlewares({
  routes: [
    {
      matcher: '/tally/v1/commands',
      middlewares: [(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) => {
        const config = req.scope.resolve<ConfigModule>(ContainerRegistrationKeys.CONFIG_MODULE)
        return cors({
          origin: parseCorsOrigins(config.projectConfig.http.adminCors),
          credentials: true,
          allowedHeaders: ['Authorization', 'Content-Type', 'X-Tally-Protocol'],
          methods: ['POST', 'OPTIONS'],
        })(req, res, next)
      }],
    },
    {
      matcher: '/tally/v1/commands',
      method: 'POST',
      // Allow 50 commands of up to ~20 kB each.
      bodyParser: { sizeLimit: '1mb' },
      middlewares: [authenticate('user', ['bearer', 'session'])],
    },
  ],
})
