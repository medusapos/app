import type { CommandEnvelope } from '@tallyui/core' with { 'resolution-mode': 'import' }

// docs/contract/field-kinds.md, "Malformed commands" (TallyUI b65c8ff): client-time bounds run after shape, before claim.
export const CLIENT_TIME_EARLIEST = Date.parse('2020-01-01T00:00:00Z')
export const CLIENT_TIME_MAX_AHEAD_MS = 24 * 60 * 60 * 1000

export const clientTimeUpperBound = (now = Date.now()): number => now + CLIENT_TIME_MAX_AHEAD_MS

export function clientTimeParseErrors(value: unknown, path: string): string[] {
  return typeof value === 'string' && Number.isNaN(Date.parse(value)) ? [`${path}: expected a valid date`] : []
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
    const time = typeof value === 'string' ? Date.parse(value) : NaN
    return time < CLIENT_TIME_EARLIEST || time > upperBound
      ? [`${path} must be a time from 2020-01-01T00:00:00Z to ${bound}`] : []
  }).slice(0, 10)
}
