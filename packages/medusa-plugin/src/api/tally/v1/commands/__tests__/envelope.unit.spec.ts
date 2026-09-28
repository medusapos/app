import type { MedusaContainer } from '@medusajs/framework/types'
import { processBatch, validateBatch } from '../process'

const command = {
  id: 'sale-1', type: 'order.create', version: 1, payload: {},
  createdAt: '2026-09-23T10:00:00Z', deviceId: 'register-1', attempt: 1,
}

describe('validateBatch', () => {
  it('accepts a valid batch and leaves payload validation to the workflow', () => {
    expect(validateBatch({ commands: [command] })).toEqual({ ok: true, commands: [command] })
    expect(validateBatch({ commands: Array(50).fill(command) }).ok).toBe(true)
  })

  it('rejects more than 50 commands', () => {
    expect(validateBatch({ commands: Array(51).fill(command) })).toMatchObject({ ok: false, status: 413 })
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

  it('rejects an unsupported version before any payload rule or ledger claim', async () => {
    const outcome = await processBatch({} as MedusaContainer, [{ ...command, version: 4, payload: { display: {} } } as never], {})
    expect(outcome).toEqual({ status: 200, body: { results: [{ id: command.id, status: 'rejected', error: {
      code: 'unsupported_version', message: 'order.create version 4 is not supported; this server supports 1, 2, 3',
    } }] } })
  })

  it('a malformed v3 is rejected with the v1/v2 shape message and never throws', async () => {
    const payload = { clientOrderId: 'order_1', createdAt: command.createdAt, currency: 'EUR', pricesIncludeTax: true,
      lines: 'abc', payments: [], subtotalMinor: 0, taxMinor: 0, totalMinor: 0 }
    const outcomes = []
    for (const version of [1, 2, 3]) {
      const fields = version === 2 ? { discountMinor: 1 } : version === 3 ? { display: {}, taxByRate: [] } : {}
      outcomes.push(await processBatch({} as MedusaContainer, [{ ...command, version, payload: { ...payload, ...fields } } as never], {}))
    }
    for (const outcome of outcomes) expect(outcome).toEqual({ status: 200, body: { results: [{
      id: command.id, status: 'rejected', error: { code: 'invalid_payload', message: 'lines: expected a non-empty array' },
    }] } })
  })

  it('does not require discountMinor for version 3', async () => {
    const outcome = await processBatch({} as MedusaContainer, [{ ...command, version: 3 } as never], {})
    expect(outcome).toMatchObject({ status: 200, body: { results: [{ error: {
      code: 'invalid_payload', message: expect.stringContaining('clientOrderId: expected'),
    } }] } })
    expect(JSON.stringify(outcome)).not.toContain('requires discountMinor')
  })

  it.each([
    [1, { display: {} }, 'display and taxByRate require version 3'],
    [2, { display: {}, discountMinor: 1 }, 'display and taxByRate require version 3'],
    [2, { taxByRate: [], discountMinor: 1 }, 'display and taxByRate require version 3'],
    [3, { display: {} }, 'display and taxByRate must both be present or both absent'],
    [3, { taxByRate: [] }, 'display and taxByRate must both be present or both absent'],
    [1, { sessionId: 'session' }, 'sessionId requires version 3'],
    [2, { sessionId: 'session', discountMinor: 1 }, 'sessionId requires version 3'],
    [1, { customer: { customerId: 'customer' } }, 'customerId requires version 3'],
    [2, { customer: { customerId: 'customer' }, discountMinor: 1 }, 'customerId requires version 3'],
  ])('rejects version %s fields %j before touching the container', async (version, payload, message) => {
    const outcome = await processBatch({} as MedusaContainer, [{ ...command, version, payload } as never], {})
    expect(outcome).toEqual({ status: 200, body: { results: [{ id: command.id, status: 'rejected', error: {
      code: 'invalid_payload', message,
    } }] } })
  })

  it('rejects a version 2 command without a discount before touching the container', async () => {
    const outcome = await processBatch({} as MedusaContainer, [{ ...command, id: 'sale-2', version: 2 } as never], {})
    expect(outcome).toEqual({ status: 200, body: { results: [{ id: 'sale-2', status: 'rejected', error: {
      code: 'invalid_payload', message: 'version 2 requires discountMinor',
    } }] } })
  })

  it.each([
    ['on a line', { lines: [{ clientLineId: 'line_1' }, { clientLineId: 'line_2', discountMinor: 100 }] }],
    ['on the payload', { lines: [{ clientLineId: 'line_1' }], discountMinor: 100 }],
  ])('rejects a version 1 command carrying discountMinor %s before touching the container', async (_where, payload) => {
    const outcome = await processBatch({} as MedusaContainer, [{ ...command, id: 'sale-1', payload } as never], {})
    expect(outcome).toEqual({ status: 200, body: { results: [{ id: 'sale-1', status: 'rejected', error: {
      code: 'invalid_payload', message: 'discountMinor requires version 2',
    } }] } })
  })

  it('rejects a non-object envelope', () => {
    expect(validateBatch({ commands: [null] })).toEqual({
      ok: false, status: 400, message: expect.stringContaining('commands[0]'),
    })
  })
})
