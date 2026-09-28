import { readFile, writeFile } from "node:fs/promises"
import { setTimeout } from "node:timers/promises"

const [baseUrl, probeFile, resultsFile] = process.argv.slice(2)
const startedAt = Date.now()
const records = []
const bus = process.env.G4_EVENT_BUS

function ids(value) {
  if (Array.isArray(value)) {
    return value.flatMap(item => typeof item === "string" ? [item] : ids(item))
  }
  if (!value || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, item]) =>
    key === "id" && typeof item === "string" ? [item] : ids(item))
}

async function measure(scenario, iteration, write, expectedIds) {
  const t0 = Date.now()
  const response = await write()
  await response.text()
  const t1 = Date.now()
  let quietSince = t1
  let previousLines = -1
  let lines
  while (true) {
    const text = await readFile(probeFile, "utf8")
    lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean)
    const now = Date.now()
    if (lines.length !== previousLines) {
      previousLines = lines.length
      quietSince = now
    }
    if (now - quietSince >= 1000 || now - t1 >= 10000) break
    await setTimeout(50)
  }
  const events = lines.map(line => JSON.parse(line))
    .filter(event => event.receivedAt >= t0)
    .map(event => ({ name: event.name, receivedAt: event.receivedAt, ids: ids(event.data) }))
  records.push({ scenario, iteration, t0, t1, status: response.status, expectedIds, events })
  if (!response.ok) throw new Error(`${scenario} ${iteration} failed: ${response.status}`)
}

try {
  const login = await fetch(`${baseUrl}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "g4@tally.test", password: "g4-probe-password" }),
  })
  if (!login.ok) throw new Error(`Login failed: ${login.status}`)
  const { token } = await login.json()
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  const listing = await fetch(`${baseUrl}/admin/products?limit=1`, { headers })
  if (!listing.ok) throw new Error(`Product listing failed: ${listing.status}`)
  const { products: [product] } = await listing.json()
  for (let iteration = 1; iteration <= 5; iteration++) {
    await measure("product.update", iteration, () => fetch(`${baseUrl}/admin/products/${product.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ description: `g4 probe ${iteration}` }),
    }), [product.id])
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await writeFile(resultsFile, JSON.stringify({ bus, startedAt, records }, null, 2) + "\n")
}
