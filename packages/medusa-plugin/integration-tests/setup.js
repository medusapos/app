const { MetadataStorage } = require("@medusajs/framework/mikro-orm/core")
const { integrationTestPort } = require("./test-port")

MetadataStorage.clear()
// get-port checks then binds, so two checkouts raced to one port (EADDRINUSE :::53786, 2026-09-29).
if (!process.env.PORT && !process.env.CI) {
  process.env.PORT = String(integrationTestPort(require("node:path").resolve(__dirname, ".."), Number(process.env.JEST_WORKER_ID || 1)))
  if (process.env.TALLY_TEST_PORT_DEBUG === "1") console.log(`integration test PORT=${process.env.PORT}`)
}
