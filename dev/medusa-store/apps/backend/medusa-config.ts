import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

module.exports = defineConfig({
  ...(process.env.G4_EVENT_BUS === "redis" || process.env.MEDUSA_FF_RBAC === "true" ? {
    modules: [
      // G4 event probe (scripts/probes/g4-events).
      ...(process.env.G4_EVENT_BUS === "redis" ? [{
        resolve: "@medusajs/medusa/event-bus-redis",
        options: { redisUrl: process.env.G4_REDIS_URL },
      }] : []),
      // defineConfig drops the RBAC module unless Medusa's rbac flag is registered when this file runs, and Medusa registers it only after reading the config.
      ...(process.env.MEDUSA_FF_RBAC === "true" ? [{ resolve: "@medusajs/medusa/rbac" }] : []),
    ],
  } : {}),
  // Experimental G4 sync (plugin README, "Experimental sync"): off unless TALLY_EXPERIMENTAL_SYNC=1.
  plugins: process.env.TALLY_E2E_PLUGIN === '1' ? [{ resolve: '@medusapos/medusa-plugin', options: { experimentalSync: process.env.TALLY_EXPERIMENTAL_SYNC === '1' } }] : [],
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
