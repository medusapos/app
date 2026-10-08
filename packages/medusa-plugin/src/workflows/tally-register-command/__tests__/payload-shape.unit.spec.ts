import batchFixture from '../../tally-order-create/__fixtures__/register-envelopes-2026-09-30/main-batch.json'
import closureFixture from '../../tally-order-create/__fixtures__/register-envelopes-2026-09-30/main-register.closure.submit.json'
import transitionFixture from '../../tally-order-create/__fixtures__/register-envelopes-2026-09-30/main-register.session.transition-closed.json'
import type { PaymentMethodKind } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { registerPayloadErrors } from '../payload-shape'
import { clientTimeStageErrors } from '../../client-time'

const at = '2026-01-01T08:00:00.000Z'
const open = { sessionId: 's', registerId: 'r', openedAt: at, countedFloatMinor: 100 }
const transition = { sessionId: 's', status: 'closed', at, counted: { cash: 50 }, closedBy: 'cashier', approvedBy: 'manager' }
const movement = { movementId: 'm', sessionId: 's', type: 'paid_in', amountMinor: 50, reason: 'float', createdAt: at }
const voidMovement = { movementId: 'v', sessionId: 's', voids: 'm', createdAt: at }
const closure = {
  closureId: 'c', sessionId: 's', registerId: 'r', number: 1, openedAt: at, closedAt: at, softwareVersion: '1.0',
  periodSalesTotalMinor: 50, periodRefundsTotalMinor: 0, perpetualSalesTotalMinor: 50, perpetualRefundsTotalMinor: 0,
  unsyncedCount: 0, unsyncedTotalMinor: 0, tillExpected: { cash: 150 }, counted: { cash: 150 }, orderIds: ['o'], movementIds: ['m'],
}

it('accepts an optional approval only on a v3 closure', () => {
  expect(registerPayloadErrors('register.closure.submit', closure, 3)).toEqual([])
  for (const approval of ['proof', 'p'.repeat(128)]) {
    expect(registerPayloadErrors('register.closure.submit', { ...closure, approval }, 3)).toEqual([])
    for (const version of [1, 2]) expect(registerPayloadErrors('register.closure.submit', { ...closure, approval }, version))
      .toEqual([`payload.approval: unknown field for register.closure.submit version ${version}`])
  }
  for (const approval of ['', 'p'.repeat(129), null, 1]) {
    expect(registerPayloadErrors('register.closure.submit', { ...closure, approval }, 3))
      .toEqual(['payload.approval: expected a non-empty string of at most 128 characters'])
  }
})

it('a v2 open accepts deviceName and supersedes; a v1 open refuses them as unknown fields for version 1', () => {
  const payload = { ...open, deviceName: '  Till 1  ', supersedes: 'previous-session' }
  expect(registerPayloadErrors('register.session.open', payload, 2)).toEqual([])
  expect(registerPayloadErrors('register.session.open', open, 2)).toEqual([])
  expect(registerPayloadErrors('register.session.open', { ...open, deviceName: ` ${'t'.repeat(64)} `, supersedes: 's'.repeat(64) }, 2)).toEqual([])
  for (const version of [undefined, 1]) expect(registerPayloadErrors('register.session.open', payload, version)).toEqual([
    'payload.deviceName: unknown field for register.session.open version 1',
    'payload.supersedes: unknown field for register.session.open version 1',
  ])
})

it('a v2 open refuses a deviceName that is blank after trim, longer than 64, or holds NUL, and an empty or over-long supersedes', () => {
  for (const deviceName of ['', ' \t ', 't'.repeat(65), 'Till\u0000', null, 1]) {
    expect(registerPayloadErrors('register.session.open', { ...open, deviceName }, 2))
      .toEqual(['payload.deviceName: expected a string of 1 to 64 characters after trim'])
  }
  for (const supersedes of ['', 's'.repeat(65), null, 1]) {
    expect(registerPayloadErrors('register.session.open', { ...open, supersedes }, 2))
      .toEqual(['payload.supersedes: expected a non-empty string of at most 64 characters'])
  }
})

it('the unknown-field message names the command version', () => {
  for (const version of [1, 2, 3]) {
    expect(registerPayloadErrors('register.session.open', { ...open, extra: true }, version))
      .toEqual([`payload.extra: unknown field for register.session.open version ${version}`])
    for (const [type, payload] of [['register.session.transition', transition], ['register.movement.record', movement],
      ['register.movement.void', voidMovement], ['register.closure.submit', closure]] as const) {
      expect(registerPayloadErrors(type, payload, version)).toEqual([])
      expect(registerPayloadErrors(type, { ...payload, deviceName: 'Till', supersedes: 's' }, version)).toEqual([
        `payload.deviceName: unknown field for ${type} version ${version}`,
        `payload.supersedes: unknown field for ${type} version ${version}`,
      ])
    }
  }
})

it.each<[string, Record<string, unknown>]>([
  ['register.session.open', open],
  ['register.session.transition', transition],
  ['register.movement.record', movement],
  ['register.movement.void', voidMovement],
  ['register.closure.submit', closure],
])('accepts a valid %s payload and refuses an unknown field, naming it (ruling 17)', (type, payload) => {
  expect(registerPayloadErrors(type, payload)).toEqual([])
  expect(registerPayloadErrors(type, { ...payload, extra: true })).toEqual([`payload.extra: unknown field for ${type} version 1`])
})

it.each<[string, string, Record<string, unknown>]>([
  ['register.session.transition', 'counted', transition],
  ['register.closure.submit', 'counted', closure],
  ['register.closure.submit', 'tillExpected', closure],
])('%s %s takes cash and external keys, and refuses card', (type, map, payload) => {
  expect(registerPayloadErrors(type, { ...payload, [map]: { cash: 1, external: 2 } })).toEqual([])
  expect(registerPayloadErrors(type, { ...payload, [map]: { cash: 1, card: 2 } }))
    .toEqual([`payload.${map}.card: expected a payment method (cash or external)`])
})

it('the payment-method keys are exhaustive: a Record<PaymentMethodKind, true> without external does not compile', () => {
  // @ts-expect-error external is missing, so the set in payload-shape.ts cannot fall behind the contract
  const missing: Record<PaymentMethodKind, true> = { cash: true }
  expect(Object.keys(missing)).toEqual(['cash'])
})

it('an unknown command type allows no keys', () => {
  expect(registerPayloadErrors('register.unknown', { sessionId: 's' }))
    .toEqual(['payload.sessionId: unknown field for register.unknown version 1', 'type: expected a register command type'])
})

type Recorded = [string, { type: string; payload: unknown }]
it.each<Recorded>([
  ['main-register.session.transition-closed', transitionFixture],
  ['main-register.closure.submit', closureFixture],
  ...batchFixture.requests[0].body.commands.map((command, index): Recorded => [`main-batch commands[${index}] ${command.type}`, command]),
])('the recorded envelope %s passes unchanged', (_name, envelope) => {
  expect(registerPayloadErrors(envelope.type, envelope.payload)).toEqual([])
})

it.each<[string, Record<string, unknown>, string]>([
  ['register.session.open', { ...open, sessionId: undefined }, 'sessionId'],
  ['register.session.open', { ...open, sessionId: '' }, 'sessionId'],
  ['register.session.open', { ...open, registerId: 'r'.repeat(65) }, 'registerId'],
  ['register.session.open', { ...open, openedAt: 'not a date' }, 'openedAt'],
  ['register.session.open', { ...open, countedFloatMinor: -1 }, 'countedFloatMinor'],
  ['register.session.open', { ...open, expectedFloatMinor: 0.5 }, 'expectedFloatMinor'],
  ['register.session.open', { ...open, openingVarianceMinor: Number.MAX_SAFE_INTEGER + 1 }, 'openingVarianceMinor'],
  ['register.session.open', { ...open, openedBy: null }, 'openedBy'],
  ['register.movement.record', { ...movement, amountMinor: 0 }, 'amountMinor'],
  ['register.movement.record', { ...movement, type: 'paid_out', amountMinor: -5 }, 'amountMinor'],
  ['register.movement.record', { ...movement, type: 'no_sale', amountMinor: 5 }, 'amountMinor'],
  ['register.movement.record', { ...movement, type: 'invalid' }, 'type'],
  ['register.movement.record', { ...movement, createdAt: '' }, 'createdAt'],
  ['register.movement.void', { ...voidMovement, voids: 'm'.repeat(65) }, 'voids'],
  ['register.session.transition', { sessionId: 's', status: 'counting', at, counted: {} }, 'counted'],
  ['register.session.transition', { sessionId: 's', status: 'open', at, closedBy: 'cashier' }, 'closedBy'],
  ['register.session.transition', { sessionId: 's', status: 'open', at, approvedBy: 'manager' }, 'approvedBy'],
  ['register.session.transition', { ...transition, at: 'invalid' }, 'at'],
  ['register.session.transition', { ...transition, status: 'invalid' }, 'status'],
  ['register.session.transition', { ...transition, counted: [] }, 'counted'],
  ['register.closure.submit', { ...closure, tillExpected: { cash: 0.5 } }, 'tillExpected'],
  ['register.closure.submit', { ...closure, counted: { '': 1 } }, 'counted'],
  ['register.closure.submit', { ...closure, counted: new Date(at) }, 'counted'],
  ['register.closure.submit', { ...closure, number: 0 }, 'number'],
  ['register.closure.submit', { ...closure, number: 2147483648 }, 'number'],
  ['register.closure.submit', { ...closure, unsyncedCount: 2147483648 }, 'unsyncedCount'],
  ['register.closure.submit', { ...closure, closedAt: 'invalid' }, 'closedAt'],
  ['register.closure.submit', { ...closure, unsyncedTotalMinor: -1 }, 'unsyncedTotalMinor'],
  ['register.closure.submit', { ...closure, orderIds: [''] }, 'orderIds'],
  ['register.closure.submit', { ...closure, movementIds: ['m'.repeat(65)] }, 'movementIds'],
])('rejects %s with invalid %s naming %s', (type, payload, field) => {
  expect(registerPayloadErrors(type as string, payload)).toEqual(expect.arrayContaining([expect.stringContaining(field as string)]))
})

it.each<[string, string, Record<string, unknown>]>([
  ['register.session.open', 'openedAt', open],
  ['register.session.transition', 'at', transition],
  ['register.movement.record', 'createdAt', movement],
  ['register.movement.void', 'createdAt', voidMovement],
  ['register.closure.submit', 'openedAt', closure],
  ['register.closure.submit', 'closedAt', closure],
])('%s checks payload.%s parsing, leaving RFC format and bounds to the client-time stage', (type, field, payload) => {
  const late = new Date(Date.now() + 24 * 60 * 60 * 1000 + 60000).toISOString()
  for (const value of ['2019-12-31T23:59:59.999Z', late]) expect(registerPayloadErrors(type, { ...payload, [field]: value }))
    .toEqual([])
  for (const value of ['invalid', 'not a date']) {
    const invalid = { ...payload, [field]: value }
    expect(registerPayloadErrors(type, invalid)).toEqual([`payload.${field}: expected a valid date`])
  }
  const zoneLess = { ...payload, [field]: '2026-09-30T12:00:00' }
  expect(registerPayloadErrors(type, zoneLess)).toEqual([])
  expect(clientTimeStageErrors({ type, payload: zoneLess } as never, Date.now()))
    .toEqual([`payload.${field} must be an RFC 3339 time with Z or an offset`])
})

it('accepts positive paid_out amounts, zero no_sale amounts and signed safe integer records', () => {
  expect(registerPayloadErrors('register.movement.record', { ...movement, type: 'paid_out' })).toEqual([])
  expect(registerPayloadErrors('register.movement.record', { ...movement, type: 'no_sale', amountMinor: 0 })).toEqual([])
  expect(registerPayloadErrors('register.session.open', { ...open, expectedFloatMinor: -1, openingVarianceMinor: -1 })).toEqual([])
  expect(registerPayloadErrors('register.closure.submit', { ...closure, tillExpected: { cash: -1 }, counted: {} })).toEqual([])
})

it.each(['paid_in', 'paid_out', 'no_sale'])('rejects blank and 501-character reasons but accepts 500 characters for %s', type => {
  const payload = { ...movement, type, amountMinor: type === 'no_sale' ? 0 : 50 }
  for (const reason of ['   ', 'r'.repeat(501)]) {
    expect(registerPayloadErrors('register.movement.record', { ...payload, reason })).toEqual([expect.stringContaining('reason')])
  }
  expect(registerPayloadErrors('register.movement.record', { ...payload, reason: 'r'.repeat(500) })).toEqual([])
})

it('accepts the maximum Postgres integer for closure number and unsyncedCount', () => {
  expect(registerPayloadErrors('register.closure.submit', { ...closure, number: 2147483647, unsyncedCount: 2147483647 })).toEqual([])
})

it('limits errors to ten and rejects non-object payloads', () => {
  expect(registerPayloadErrors('register.closure.submit', {})).toHaveLength(10)
  for (const payload of [null, [], 1]) expect(registerPayloadErrors('register.session.open', payload)).toEqual(['payload: expected an object'])
})
