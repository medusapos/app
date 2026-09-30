import type { CommandEnvelope } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { clientTimeParseErrors, clientTimeStageErrors, clientTimeUpperBound } from '../client-time'

const now = Date.parse('2026-09-30T14:05:00.789Z')
const upperBound = clientTimeUpperBound(now)
const bounds = 'must be a time from 2020-01-01T00:00:00Z to 2026-10-01T14:05:00Z'
const command: CommandEnvelope<unknown> = { id: 'time-test', type: 'order.create', version: 1, payload: {},
  createdAt: new Date(now).toISOString(), deviceId: 'register-1', attempt: 1 }

it.each([
  ['2020-01-01T00:00:00Z', []],
  ['2019-12-31T23:59:59.999Z', [`createdAt ${bounds}`]],
  [new Date(now + 24 * 60 * 60 * 1000).toISOString(), []],
  [new Date(now + 24 * 60 * 60 * 1000 + 1).toISOString(), [`createdAt ${bounds}`]],
])('compares %s against exact millisecond bounds, displaying the upper bound truncated to seconds', (value, expected) => {
  expect(clientTimeStageErrors({ ...command, createdAt: value as string }, upperBound)).toEqual(expected)
  expect(clientTimeParseErrors(value, 'createdAt')).toEqual([])
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

it.each(['not a date', ''])('leaves unparseable %p to the shape stage', value => {
  expect(clientTimeStageErrors({ ...command, createdAt: value, payload: { createdAt: value } }, upperBound)).toEqual([])
  expect(clientTimeParseErrors(value, 'createdAt')).toEqual(['createdAt: expected a valid date'])
  expect(clientTimeParseErrors(value, 'payload.createdAt')).toEqual(['payload.createdAt: expected a valid date'])
})

it.each([undefined, null, 1, now, {}])('leaves a non-string (%p) to the type checks', value => {
  expect(clientTimeParseErrors(value, 'at')).toEqual([])
  expect(clientTimeStageErrors({ ...command, payload: { createdAt: value } }, upperBound)).toEqual([])
})

it("defaults to the server's clock", () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now)
  try {
    expect(clientTimeUpperBound()).toBe(now + 24 * 60 * 60 * 1000)
  } finally { clock.mockRestore() }
})
