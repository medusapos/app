import path from 'node:path'
import { defineConfig } from '@medusajs/framework/utils'

module.exports = defineConfig({
  projectConfig: {
    http: {
      storeCors: 'http://localhost', adminCors: 'http://localhost', authCors: 'http://localhost',
      jwtSecret: 'integration-test-jwt-secret', cookieSecret: 'integration-test-cookie-secret',
    },
  },
  // The receipt-email suite needs an email provider; the local one logs instead of sending.
  modules: [{
    resolve: '@medusajs/medusa/notification',
    options: { providers: [{
      resolve: '@medusajs/medusa/notification-local', id: 'local',
      options: { name: 'Local Notification Provider', channels: ['email'] },
    }] },
  }],
  plugins: [{ resolve: path.resolve(__dirname, '../..'), options: { experimentalSync: true } }],
})
