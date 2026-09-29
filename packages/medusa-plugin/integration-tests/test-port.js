const { createHash } = require("node:crypto")
// Each checkout (packageDir) gets its own block of 4 ports in 40000–47999, one per jest worker,
// clear of the e2e ranges in e2e/ports.ts (8100–8499, 9100–9499), the dev store and Postgres.
// 2000 blocks, because with 500 two of this machine's 31 worktrees already shared one (2026-09-30).
function integrationTestPort(packageDir, workerId) {
  if (workerId > 4) throw new Error(`integration tests use at most 4 jest workers per checkout (worker ${workerId}); run with --maxWorkers=4 or fewer, or set PORT`)
  const block = Number(BigInt("0x" + createHash("sha1").update(packageDir).digest("hex")) % 2000n)
  return 40000 + block * 4 + (workerId - 1)
}
// CI=false, CI=0 and an empty CI are not CI (e2e/ports.ts restates this rule).
function isCI(env = process.env) {
  return env.CI != null && !["", "0", "false"].includes(String(env.CI).toLowerCase())
}
// The PORT setup.js sets for a jest worker: none when PORT is explicit, or in CI, where get-port picks.
function resolveTestPort(env, packageDir, workerId) {
  return env.PORT || isCI(env) ? undefined : String(integrationTestPort(packageDir, workerId))
}
// Node binds `::` by default, which on macOS can succeed while another process holds
// 127.0.0.1:<port>, so a `localhost` request could reach it: probe both hosts and fail loudly.
async function assertPortsFree(ports) {
  const busy = []
  for (const port of ports) {
    for (const host of ["127.0.0.1", "::"]) {
      const err = await new Promise(resolve => {
        const server = require("node:net").createServer().once("error", resolve)
        server.listen(port, host, () => server.close(() => resolve(null)))
      })
      if (err && !(host === "::" && err.code === "EADDRNOTAVAIL")) busy.push(`${port} busy on ${host}`) // no IPv6 is free
    }
  }
  if (busy.length) throw new Error(`integration test port(s) ${busy.join(", ")}; stop the process holding it, or set PORT to a free port`)
}

module.exports = { integrationTestPort, isCI, resolveTestPort, assertPortsFree }
