import { clientTimeErrors } from '../client-time'

const now = Date.parse('2026-09-30T12:00:00.000Z')
const bounds = "at: expected a time from 2020-01-01T00:00:00Z to 24 hours after the server's clock"

it.each([
  ['2020-01-01T00:00:00Z', []],
  ['2019-12-31T23:59:59.999Z', [bounds]],
  [new Date(now + 24 * 60 * 60 * 1000).toISOString(), []],
  [new Date(now + 24 * 60 * 60 * 1000 + 1).toISOString(), [bounds]],
  ['not a date', ['at: expected a valid date']],
  ['', ['at: expected a valid date']],
])('%p gives %j, never clamped (TallyUI #325)', (value, expected) => {
  expect(clientTimeErrors(value, 'at', now)).toEqual(expected)
})

it.each([undefined, null, 1, now, {}])('leaves a non-string (%p) to the type checks', value => {
  expect(clientTimeErrors(value, 'at', now)).toEqual([])
})

it("defaults to the server's clock", () => {
  expect(clientTimeErrors(new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString(), 'at')).toEqual([])
  expect(clientTimeErrors(new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(), 'at')).toEqual([bounds])
})
