import type { CommandEnvelope } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { parseClientTime, clientTimeStageErrors, clientTimeUpperBound } from '../client-time'

const now = Date.parse('2026-09-30T14:05:00.789Z')
const upperBound = clientTimeUpperBound(now)
const bounds = 'must be a time from 2020-01-01T00:00:00Z to 2026-10-01T14:05:00Z'
const command: CommandEnvelope<unknown> = { id: 'time-test', type: 'order.create', version: 1, payload: {},
  createdAt: new Date(now).toISOString(), deviceId: 'register-1', attempt: 1 }
const format = 'must be an RFC 3339 time with Z or an offset'

it.each([
  ['2026-09-30T12:00:00Z', '2026-09-30T12:00:00Z'],
  ['2026-09-30T12:00:00.000Z', '2026-09-30T12:00:00Z'],
  ['2026-09-30T12:00:00.123Z', '2026-09-30T12:00:00.123Z'],
  ['2026-09-30T12:00:00.123456789Z', '2026-09-30T12:00:00.123Z'],
  ['2026-09-30T12:00:00.1234567890Z', '2026-09-30T12:00:00.123Z'],
  ['2026-09-30T12:00:00.1234567890123Z', '2026-09-30T12:00:00.123Z'],
  ['2026-09-30T14:00:00+02:00', '2026-09-30T12:00:00Z'],
  ['2026-09-30T07:00:00-05:00', '2026-09-30T12:00:00Z'],
  ['2026-09-30T12:00:00-00:00', '2026-09-30T12:00:00Z'],
  ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00Z'],
  ['2000-02-29T00:00:00Z', '2000-02-29T00:00:00Z'],
])('parseClientTime accepts %s as the instant %s', (value, expected) => {
  expect(parseClientTime(value)).toBe(Date.parse(expected))
})

it.each([
  '2026-09-30 12:00', '2026-09-30T12:00', '2026-09-30T12:00:00',
  '2026-09-30', '2026-09-30t12:00:00z', '2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z',
  '2026-13-01T00:00:00Z', '2026-09-30T24:00:00Z', '2026-09-30T12:60:00Z', '2026-09-30T12:00:60Z',
  '2026-09-30T12:00:00+24:00', '2026-09-30T12:00:00+0200', 'Tue, 30 Sep 2026 12:00:00 GMT', '',
  '2026-09-32T00:00:00Z', '2026-00-01T00:00:00Z', '2026-09-00T00:00:00Z', '1900-02-29T00:00:00Z',
  '2026-09-30T12:00:00+02:60', '2026-09-30T12:00:00.Z',
  '2026-09-30T12:00:00Z\n',
])('parseClientTime refuses %p', value => {
  expect(parseClientTime(value)).toBeNull()
})

it.each([
  ['2020-01-01T00:00:00Z', []],
  ['2019-12-31T23:59:59.999Z', [`createdAt ${bounds}`]],
  [new Date(now + 24 * 60 * 60 * 1000).toISOString(), []],
  [new Date(now + 24 * 60 * 60 * 1000 + 1).toISOString(), [`createdAt ${bounds}`]],
])('compares %s against exact millisecond bounds, displaying the upper bound truncated to seconds', (value, expected) => {
  expect(clientTimeStageErrors({ ...command, createdAt: value as string }, upperBound)).toEqual(expected)
  expect(parseClientTime(value as string)).toBe(Date.parse(value as string))
})

it.each([
  ['order.create', 'createdAt'],
  ['register.session.open', 'openedAt'],
  ['register.session.transition', 'at'],
  ['register.movement.record', 'createdAt'],
  ['register.movement.void', 'createdAt'],
  ['register.closure.submit', 'openedAt'],
  ['register.closure.submit', 'closedAt'],
])('%s names its out-of-bounds payload.%s verbatim', (type, field) => {
  expect(clientTimeStageErrors({ ...command, type, payload: { [field]: '2019-12-31T23:59:59.999Z' } } as CommandEnvelope<unknown>, upperBound))
    .toEqual([`payload.${field} ${bounds}`])
})

it('orders closure bounds as envelope, openedAt, closedAt', () => {
  const value = '2019-12-31T23:59:59.999Z'
  expect(clientTimeStageErrors({ ...command, type: 'register.closure.submit', createdAt: value,
    payload: { closedAt: value, openedAt: value } } as never, upperBound)).toEqual([
    `createdAt ${bounds}`, `payload.openedAt ${bounds}`, `payload.closedAt ${bounds}`,
  ])
})

it('orders closure format and bounds errors by field', () => {
  expect(clientTimeStageErrors({ ...command, type: 'register.closure.submit',
    payload: { closedAt: '2019-12-31T23:59:59Z', openedAt: '2026-09-30 12:00' } } as never, upperBound))
    .toEqual([`payload.openedAt ${format}`, `payload.closedAt ${bounds}`])
})

it.each(['not a date', '', '2019-12-31 23:00'])('reports only format errors for %p, envelope first', value => {
  expect(clientTimeStageErrors({ ...command, createdAt: value, payload: { createdAt: value } }, upperBound))
    .toEqual([`createdAt ${format}`, `payload.createdAt ${format}`])
})

it.each([undefined, null, 1, now, {}])('leaves a non-string (%p) to the type checks', value => {
  expect(clientTimeStageErrors({ ...command, createdAt: value, payload: { createdAt: value } } as never, upperBound)).toEqual([])
})

it("defaults to the server's clock", () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now)
  try {
    expect(clientTimeUpperBound()).toBe(now + 24 * 60 * 60 * 1000)
  } finally { clock.mockRestore() }
})
