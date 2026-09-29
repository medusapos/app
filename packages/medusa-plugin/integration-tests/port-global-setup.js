const { integrationTestPort, isCI, assertPortsFree } = require("./test-port")
// Runs once before any test file, so a busy port stops the run here rather than in a test against another server.
module.exports = async () => {
  if (isCI()) return
  const block = [1, 2, 3, 4].map(w => integrationTestPort(require("node:path").resolve(__dirname, ".."), w))
  const { PORT } = process.env
  console.log(PORT ? `integration tests: PORT=${PORT}` : `integration tests: checkout port block ${block[0]}-${block[3]} (override with PORT)`)
  await assertPortsFree(PORT ? [Number(PORT)] : block)
}
