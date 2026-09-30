import type { CommandEnvelope } from '@tallyui/core' with { 'resolution-mode': 'import' }

// docs/contract/field-kinds.md, "Malformed commands": client-time format and bounds run after shape, before claim.
export const CLIENT_TIME_EARLIEST = Date.parse('2020-01-01T00:00:00Z')
export const CLIENT_TIME_MAX_AHEAD_MS = 24 * 60 * 60 * 1000

export const clientTimeUpperBound = (now = Date.now()): number => now + CLIENT_TIME_MAX_AHEAD_MS

export function parseClientTime(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value)
  if (!match || match[0] !== value) return null
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : time
}

export function clientTimeStageErrors(command: CommandEnvelope<unknown>, upperBound: number): string[] {
  const fields: Record<string, string[]> = {
    'order.create': ['createdAt'],
    'register.session.open': ['openedAt'],
    'register.session.transition': ['at'],
    'register.movement.record': ['createdAt'],
    'register.movement.void': ['createdAt'],
    'register.closure.submit': ['openedAt', 'closedAt'],
  }
  const values = [['createdAt', command.createdAt], ...(fields[command.type] ?? [])
    .map(field => [`payload.${field}`, (command.payload as Record<string, unknown>)[field]])]
  const bound = new Date(upperBound).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return values.flatMap(([path, value]) => {
    if (typeof value !== 'string') return []
    const time = parseClientTime(value)
    // Front desk ruling 2026-09-30 (matching Vendure #73), docs/contract/field-kinds.md.
    if (time === null) return [`${path} must be an RFC 3339 time with Z or an offset`]
    return time < CLIENT_TIME_EARLIEST || time > upperBound
      ? [`${path} must be a time from 2020-01-01T00:00:00Z to ${bound}`] : []
  }).slice(0, 10)
}
