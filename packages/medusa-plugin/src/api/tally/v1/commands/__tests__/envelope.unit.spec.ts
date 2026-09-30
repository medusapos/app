import type { MedusaContainer } from '@medusajs/framework/types'
import mainV1 from '../../../../../workflows/tally-order-create/__fixtures__/order-create-envelopes-2026-09-30/main-v1.json'
import mainV2 from '../../../../../workflows/tally-order-create/__fixtures__/order-create-envelopes-2026-09-30/main-v2.json'
import mainV3 from '../../../../../workflows/tally-order-create/__fixtures__/order-create-envelopes-2026-09-30/main-v3.json'
import posV1 from '../../../../../workflows/tally-order-create/__fixtures__/order-create-envelopes-2026-09-30/pos-2.0.0-v1.json'
import posV2 from '../../../../../workflows/tally-order-create/__fixtures__/order-create-envelopes-2026-09-30/pos-2.0.0-v2.json'
import batch from '../../../../../workflows/tally-order-create/__fixtures__/register-envelopes-2026-09-30/main-batch.json'
import closure from '../../../../../workflows/tally-order-create/__fixtures__/register-envelopes-2026-09-30/main-register.closure.submit.json'
import { payloadShapeErrors } from '../../../../../workflows/tally-order-create/payload-shape'
import { processBatch, validateBatch, type BatchOutcome } from '../process'

const command = {
  id: 'sale-1', type: 'order.create', version: 1, payload: {},
  createdAt: '2026-09-23T10:00:00Z', deviceId: 'register-1', attempt: 1,
}

const container = { resolve: () => ({ listTallyCommands: async () => [] }) } as unknown as MedusaContainer

describe('validateBatch', () => {
  it('accepts a valid batch and leaves payload validation to the workflow', () => {
    expect(validateBatch({ commands: [command] })).toEqual({ ok: true, commands: [command] })
    expect(validateBatch({ commands: Array(50).fill(command) }).ok).toBe(true)
  })

  it('rejects a NUL in the envelope id', () => {
    expect(validateBatch({ commands: [{ ...command, id: 'sale\0id' }] })).toEqual({
      ok: false, status: 400, message: 'Invalid commands[0].id',
    })
  })

  it('rejects NUL before replay and version rules without touching the container', async () => {
    const outcome = await processBatch({} as MedusaContainer, [{ ...command, version: 4, payload: { clientOrderId: '\0' } } as never], {})
    expect(outcome).toEqual({ status: 200, body: { results: [{ id: command.id, status: 'rejected', error: {
      code: 'invalid_payload', message: 'clientOrderId: expected no NUL character',
    } }] } })
  })

  it('rejects more than 50 commands', () => {
    expect(validateBatch({ commands: Array(51).fill(command) })).toEqual({
      ok: false, status: 413, code: 'batch_too_large', maxCommands: 50, message: expect.any(String),
    })
  })

  it.each([null, [], 'batch', 1, {}, { commands: {} }, { commands: [] }])('rejects invalid body %p', body => {
    expect(validateBatch(body)).toMatchObject({ ok: false, status: 400 })
  })

  it.each([
    ['id', ''], ['id', 'x'.repeat(65)], ['id', 1],
    ['type', 'order.cancel'], ['version', '2'],
    ['deviceId', undefined], ['createdAt', undefined],
    ['payload', null], ['payload', []], ['payload', 'sale'],
    ['attempt', 0], ['attempt', 1.5], ['attempt', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects invalid %s (%p), naming the index and field', (field, value) => {
    const result = validateBatch({ commands: [command, { ...command, [field as string]: value }] })
    expect(result).toEqual({ ok: false, status: 400, message: expect.stringContaining(`commands[1].${field}`) })
  })

  it('accepts version 2 (ADR-062)', () => {
    expect(validateBatch({ commands: [{ ...command, version: 2 }] })).toEqual({ ok: true, commands: [{ ...command, version: 2 }] })
  })

  it('accepts version 3', () => {
    expect(validateBatch({ commands: [{ ...command, version: 3 }] })).toEqual({ ok: true, commands: [{ ...command, version: 3 }] })
  })

  it("validateBatch accepts a positive integer version it doesn't support", () => {
    for (const version of [4, Number.MAX_SAFE_INTEGER]) {
      const commands = [{ ...command, version }]
      expect(validateBatch({ commands })).toEqual({ ok: true, commands })
    }
  })

  it.each([1.5, 0, -1, undefined, Number.MAX_SAFE_INTEGER + 1])('still rejects a non-integer or zero version with 400 (%p)', version => {
    expect(validateBatch({ commands: [{ ...command, version }] })).toEqual({
      ok: false, status: 400, message: 'Invalid commands[0].version',
    })
  })

  it('rejects an unsupported version after the replay read and before shape checks or ledger claim', async () => {
    const outcome = await processBatch(container, [{ ...command, version: 4, payload: { display: {} } } as never], {})
    expect(outcome).toEqual({ status: 200, body: { results: [{ id: command.id, status: 'rejected', error: {
      code: 'unsupported_version', message: 'order.create version 4 is not supported; this server supports 1, 2, 3',
      data: { orderCreate: 3 },
    } }] } })
  })

  it('a malformed v3 is rejected with the v1/v2 shape message and never throws', async () => {
    const payload = { clientOrderId: 'order_1', createdAt: command.createdAt, currency: 'EUR', pricesIncludeTax: true,
      lines: 'abc', payments: [], subtotalMinor: 0, taxMinor: 0, totalMinor: 0 }
    const outcomes: BatchOutcome[] = []
    for (const version of [1, 2, 3]) {
      const fields = version === 2 ? { discountMinor: 1 } : version === 3 ? { display: {}, taxByRate: [] } : {}
      outcomes.push(await processBatch(container, [{ ...command, version, payload: { ...payload, ...fields } } as never], {}))
    }
    for (const outcome of outcomes) expect(outcome).toEqual({ status: 200, body: { results: [{
      id: command.id, status: 'rejected', error: { code: 'invalid_payload', message: 'lines: expected a non-empty array' },
    }] } })
  })

  it('does not require discountMinor for version 3', async () => {
    const outcome = await processBatch(container, [{ ...command, version: 3 } as never], {})
    expect(outcome).toMatchObject({ status: 200, body: { results: [{ error: {
      code: 'invalid_payload', message: expect.stringContaining('clientOrderId: expected'),
    } }] } })
    expect(JSON.stringify(outcome)).not.toContain('requires discountMinor')
  })

  it.each([
    [1, { display: {} }, 'display: requires version 3'],
    [2, { display: {} }, 'display: requires version 3'],
    [2, { taxByRate: [] }, 'taxByRate: requires version 3'],
    [3, { display: {} }, 'display and taxByRate must both be present or both absent'],
    [3, { taxByRate: [] }, 'display and taxByRate must both be present or both absent'],
    [1, { sessionId: 'session' }, 'sessionId: requires version 3'],
    [2, { sessionId: 'session' }, 'sessionId: requires version 3'],
    [1, { customer: { customerId: 'customer' } }, 'customer.customerId: requires version 3'],
    [2, { customer: { customerId: 'customer' } }, 'customer.customerId: requires version 3'],
  ])('rejects version %s fields %j after the replay read', async (version, fields, message) => {
    const payload = { ...(version === 2 ? mainV2 : mainV1).payload, ...fields }
    const outcome = await processBatch(container, [{ ...command, version, payload } as never], {})
    expect(outcome).toEqual({ status: 200, body: { results: [{ id: command.id, status: 'rejected', error: {
      code: 'invalid_payload', message,
    } }] } })
  })

  it('rejects a version 2 command without a discount after the replay read', async () => {
    const outcome = await processBatch(container, [{ ...command, id: 'sale-2', version: 2 } as never], {})
    expect(outcome).toEqual({ status: 200, body: { results: [{ id: 'sale-2', status: 'rejected', error: {
      code: 'invalid_payload', message: 'version 2 requires discountMinor',
    } }] } })
  })

  it.each([
    ['on a line', { lines: [mainV1.payload.lines[0], { ...mainV1.payload.lines[1], discountMinor: 100 }] }, 'lines[1].discountMinor'],
    ['on the payload', { discountMinor: 100 }, 'discountMinor'],
  ])('rejects a version 1 command carrying discountMinor %s after the replay read', async (_where, fields, path) => {
    const payload = { ...mainV1.payload, ...fields }
    const outcome = await processBatch(container, [{ ...command, id: 'sale-1', payload } as never], {})
    expect(outcome).toEqual({ status: 200, body: { results: [{ id: 'sale-1', status: 'rejected', error: {
      code: 'invalid_payload', message: `${path}: requires version 2`,
    } }] } })
  })

  it('rejects a non-object envelope', () => {
    expect(validateBatch({ commands: [null] })).toEqual({
      ok: false, status: 400, message: expect.stringContaining('commands[0]'),
    })
  })
})

describe('recorded TallyUI envelopes, 2026-09-30 (ruling 17)', () => {
  type Recorded = { id: string; version: number; payload: unknown }
  it.each<[string, Recorded]>([['pos 2.0.0 v1', posV1], ['pos 2.0.0 v2', posV2], ['main v1', mainV1], ['main v2', mainV2], ['main v3', mainV3]])(
    '%s passes the shape and version rules unchanged and reaches the claim', async (_name, fixture) => {
      expect(payloadShapeErrors(fixture.payload, fixture.version)).toEqual([])
      const claim = jest.fn(async () => { throw new Error('reached the claim') })
      const claiming = { resolve: () => ({ listTallyCommands: async () => [], claim, error: () => undefined }) } as unknown as MedusaContainer
      const outcome = await processBatch(claiming, [structuredClone(fixture)] as never, {})
      expect(outcome).toEqual({ status: 503, body: { code: 'transient', id: fixture.id, message: 'Temporary failure, retry later.' } })
      expect(claim).toHaveBeenCalledTimes(1)
    })

  it('the recorded register batch passes validateBatch unchanged', () => {
    const { body } = batch.requests[0]
    expect(validateBatch(body)).toEqual({ ok: true, commands: body.commands })
  })

  it.each<[string, Recorded, string]>([
    ['a v2 field in v1', { ...mainV1, payload: { ...mainV1.payload, discountMinor: 1,
      lines: [{ ...mainV1.payload.lines[0], discountMinor: 1 }, mainV1.payload.lines[1]] } },
      'discountMinor: requires version 2; lines[0].discountMinor: requires version 2'],
    ['a v3 field in v2', { ...mainV2, payload: { ...mainV2.payload, sessionId: 'session' } }, 'sessionId: requires version 3'],
    ['a v3 customer field in v2', { ...mainV2, payload: { ...mainV2.payload, customer: { email: 'buyer@example.com', customerId: 'c' } } },
      'customer.customerId: requires version 3'],
  ])('%s names the version it needs, not an unknown field', async (_name, fixture, message) => {
    const outcome = await processBatch(container, [fixture] as never, {})
    expect(outcome).toEqual({ status: 200, body: { results: [{ id: fixture.id, status: 'rejected', error: {
      code: 'invalid_payload', message,
    } }] } })
  })
})

describe('envelope fields (ruling 17)', () => {
  it.each<[string, { id: string }]>([['order.create', mainV1], ['register.closure.submit', closure]])(
    'refuses priority on a recorded %s envelope as invalid_payload, before the claim', async (type, fixture) => {
      const claim = jest.fn()
      const replaying = { resolve: () => ({ listTallyCommands: async () => [], claim }) } as unknown as MedusaContainer
      const outcome = await processBatch(replaying, [{ ...fixture, priority: 1 }] as never, {})
      expect(outcome).toEqual({ status: 200, body: { results: [{ id: fixture.id, status: 'rejected', error: {
        code: 'invalid_payload', message: `envelope.priority: unknown field for ${type} version 1`,
      } }] } })
      expect(claim).not.toHaveBeenCalled()
    })

  it.each<[string, { id: string }]>([['order.create', mainV1], ['register.closure.submit', closure]])(
    'refuses a %s createdAt before 2020 as invalid_payload, before the claim (TallyUI #325)', async (_type, fixture) => {
      const claim = jest.fn()
      const replaying = { resolve: () => ({ listTallyCommands: async () => [], claim }) } as unknown as MedusaContainer
      const outcome = await processBatch(replaying, [{ ...fixture, createdAt: '2019-12-31T23:59:59.999Z' }] as never, {})
      expect(outcome).toEqual({ status: 200, body: { results: [{ id: fixture.id, status: 'rejected', error: { code: 'invalid_payload',
        message: "createdAt: expected a time from 2020-01-01T00:00:00Z to 24 hours after the server's clock" } }] } })
      expect(claim).not.toHaveBeenCalled()
    })
})
