import { defineConfig } from '@medusajs/framework/utils'

module.exports = defineConfig({
  projectConfig: {
    http: {
      storeCors: 'http://localhost', adminCors: 'http://localhost', authCors: 'http://localhost',
      jwtSecret: 'integration-test-jwt-secret', cookieSecret: 'integration-test-cookie-secret',
    },
  },
})
