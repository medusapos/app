import {
  APPROVAL_FAILURE_WINDOW_MS, MAX_APPROVAL_FAILURES_PER_ACTOR, MAX_APPROVAL_FAILURES_PER_EMAIL,
} from '../../../../modules/tally-register/service'

// Failed device-clear approvals, counted in this process's memory. They share one budget with register approvals:
// each route adds the other's count before its limit check. This in-memory half resets on restart and is per server
// instance. No stored row, because tally_register_approval binds each approval to a register session and a device
// clear has none.
export type DeviceClearAttempt = { succeed(): void }

type Entry = { actor: string; email: string; at: number }

export function createDeviceClearAttempts(now: () => number = Date.now) {
  const recent = new Set<Entry>() // insertion order is time order, so expired entries sit at the front
  const byActor = new Map<string, Set<Entry>>()
  const byEmail = new Map<string, Set<Entry>>()
  const add = (map: Map<string, Set<Entry>>, key: string, entry: Entry) => {
    const entries = map.get(key) ?? new Set<Entry>()
    map.set(key, entries.add(entry))
  }
  const remove = (map: Map<string, Set<Entry>>, key: string, entry: Entry) => {
    const entries = map.get(key)
    if (entries?.delete(entry) && entries.size === 0) map.delete(key)
  }
  const drop = (entry: Entry) => {
    recent.delete(entry)
    remove(byActor, entry.actor, entry)
    remove(byEmail, entry.email, entry)
  }
  const expire = (at: number) => {
    for (const entry of recent) {
      if (at - entry.at < APPROVAL_FAILURE_WINDOW_MS) break
      drop(entry)
    }
  }
  return {
    // An admitted attempt counts as a failure until succeed(), as a pending register approval row does until issued.
    // `stored` is the register approvals' failures for the same actor and email.
    admit(actor: string, rawEmail: string, stored: { actor: number; email: number } = { actor: 0, email: 0 }):
      DeviceClearAttempt | undefined {
      const at = now()
      expire(at)
      const email = rawEmail.trim().toLowerCase()
      if ((byActor.get(actor)?.size ?? 0) + stored.actor >= MAX_APPROVAL_FAILURES_PER_ACTOR
        || (byEmail.get(email)?.size ?? 0) + stored.email >= MAX_APPROVAL_FAILURES_PER_EMAIL) return undefined
      const entry = { actor, email, at }
      recent.add(entry)
      add(byActor, actor, entry)
      add(byEmail, email, entry)
      return { succeed: () => drop(entry) }
    },
    // The in-memory failures in the window, for the register-approval route's limit check.
    counts(actor: string, rawEmail: string): { actor: number; email: number } {
      expire(now())
      const email = rawEmail.trim().toLowerCase()
      return { actor: byActor.get(actor)?.size ?? 0, email: byEmail.get(email)?.size ?? 0 }
    },
  }
}

// The route's shared instance.
export const deviceClearAttempts = createDeviceClearAttempts()
