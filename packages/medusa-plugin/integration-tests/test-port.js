const { createHash } = require("node:crypto")
// Each checkout (packageDir) gets its own block of 8 ports in 40000–43999, one per jest worker,
// clear of the e2e ranges in e2e/ports.ts (8100–8499, 9100–9499), the dev store and Postgres.
function integrationTestPort(packageDir, workerId) {
  const block = Number(BigInt("0x" + createHash("sha1").update(packageDir).digest("hex")) % 500n)
  return 40000 + block * 8 + ((workerId - 1) % 8)
}

module.exports = { integrationTestPort }
