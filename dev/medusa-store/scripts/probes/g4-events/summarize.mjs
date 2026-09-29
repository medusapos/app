import { readFile } from "node:fs/promises"

const { bus, startedAt, records } = JSON.parse(await readFile(process.argv[2], "utf8"))
const scenarios = new Map()
const eventNames = new Map()
for (const record of records) {
  if (!scenarios.has(record.scenario)) scenarios.set(record.scenario, [])
  scenarios.get(record.scenario).push(record)
  for (const event of record.events) {
    if (!eventNames.has(event.name)) eventNames.set(event.name, [])
    eventNames.get(event.name).push(event)
  }
}

function latency(events, key) {
  if (!events.length) return "— | —"
  const values = events.map(event => event[key]).sort((a, b) => a - b)
  return [0.5, 0.95].map(p => Math.round(values[Math.ceil(p * values.length) - 1])).join(" | ")
}

console.log(`# G4 events — ${bus}\n\nRun start: ${new Date(startedAt).toISOString()}\n`)
console.log("| Scenario | Iterations | IDs covered / expected | Events (total counts) | fromStart p50 ms | fromStart p95 ms | fromResponse p50 ms | fromResponse p95 ms |")
console.log("| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |")
for (const [scenario, iterations] of scenarios) {
  const events = iterations.flatMap(record => record.events)
  let covered = 0
  let total = 0
  for (const record of iterations) {
    const seen = new Set(record.events.flatMap(event => event.ids))
    covered += record.expectedIds.filter(id => seen.has(id)).length
    total += record.expectedIds.length
  }
  const counts = new Map()
  for (const event of events) counts.set(event.name, (counts.get(event.name) ?? 0) + 1)
  let names = [...counts].map(([name, count]) => `${name}: ${count}`).join(", ") || "—"
  if (scenario === "direct.module.writes.child-probe") {
    const childCounts = new Map()
    for (const event of iterations.flatMap(record => record.childEvents)) childCounts.set(event.name, (childCounts.get(event.name) ?? 0) + 1)
    const childNames = [...childCounts].map(([name, count]) => `${name}: ${count}`).join(", ") || "—"
    names = `server: ${names}; child: ${childNames}`
  }
  console.log(`| ${scenario} | ${iterations.length} | ${covered}/${total} | ${names} | ${latency(events, "fromStart")} | ${latency(events, "fromResponse")} |`)
}

console.log("\n| Event | Count | fromStart p50 ms | fromStart p95 ms | fromResponse p50 ms | fromResponse p95 ms |")
console.log("| --- | ---: | ---: | ---: | ---: | ---: |")
for (const [name, events] of eventNames) {
  console.log(`| ${name} | ${events.length} | ${latency(events, "fromStart")} | ${latency(events, "fromResponse")} |`)
}
const burst = (scenarios.get("price-list.burst.delete") ?? []).flatMap(record => record.events)
const drain = burst.length ? `${Math.round(Math.max(...burst.map(event => event.fromResponse)))} ms` : "—"
console.log(`\nprice-list.burst.delete: ${burst.length} events; drain time (max fromResponse): ${drain}`)
