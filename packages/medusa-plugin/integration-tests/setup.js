const { MetadataStorage } = require("@medusajs/framework/mikro-orm/core")
const { resolveTestPort } = require("./test-port")

MetadataStorage.clear()
// get-port checks then binds, so two checkouts raced to one port (EADDRINUSE :::53786, 2026-09-29).
// Only the HTTP suite gets a derived port; every other TEST_TYPE is left as before (see resolveTestPort).
const port = resolveTestPort(process.env, require("node:path").resolve(__dirname, ".."), Number(process.env.JEST_WORKER_ID || 1))
if (port) process.env.PORT = port
