import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { appendFile } from "node:fs/promises"

export default async function g4EventProbe({ event, container }: SubscriberArgs<unknown>) {
  const file = process.env.G4_EVENT_PROBE_FILE
  if (!file) return

  const { name, data, metadata } = event
  try {
    await appendFile(file, JSON.stringify({ name, receivedAt: Date.now(), data, metadata }) + "\n")
  } catch (error) {
    container.resolve("logger").error(`G4 event probe write failed: ${error}`)
  }
}

export const config: SubscriberConfig = {
  event: process.env.G4_EVENT_PROBE_FILE ? "*" : "g4-event-probe.disabled",
}
