import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

module.exports = defineConfig({
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
