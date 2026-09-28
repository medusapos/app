import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

module.exports = defineConfig({
  // G4 event probe (scripts/probes/g4-events).
  ...(process.env.G4_EVENT_BUS === "redis" ? {
    modules: [{
      resolve: "@medusajs/medusa/event-bus-redis",
      options: { redisUrl: process.env.G4_REDIS_URL },
    }],
  } : {}),
  plugins: process.env.TALLY_E2E_PLUGIN === '1' ? [{ resolve: '@medusapos/medusa-plugin', options: {} }] : [],
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    }
  }
})
