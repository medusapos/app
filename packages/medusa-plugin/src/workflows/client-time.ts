// Client time (TallyUI #325, docs/contract/field-kinds.md): a till's clock may run ahead of the server's by at most a day
// (ADR-038), and no till sent a time before 2020. Outside either bound the command is refused, never clamped.
export const CLIENT_TIME_EARLIEST = Date.parse('2020-01-01T00:00:00Z')
export const CLIENT_TIME_MAX_AHEAD_MS = 24 * 60 * 60 * 1000

/** The error for a client-time field, e.g. ['openedAt: expected a valid date']; [] when in bounds. A non-string is left to the type checks. */
export function clientTimeErrors(value: unknown, path: string, now = Date.now()): string[] {
  if (typeof value !== 'string') return []
  const time = Date.parse(value)
  if (Number.isNaN(time)) return [`${path}: expected a valid date`]
  if (time < CLIENT_TIME_EARLIEST || time > now + CLIENT_TIME_MAX_AHEAD_MS) {
    return [`${path}: expected a time from 2020-01-01T00:00:00Z to 24 hours after the server's clock`]
  }
  return []
}
