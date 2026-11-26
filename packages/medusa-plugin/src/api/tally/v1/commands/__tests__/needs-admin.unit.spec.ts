import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { TALLY_LEDGER_MODULE } from '../../../../../modules/tally-ledger'
import { NEEDS_ADMIN_REFUND_MESSAGES as messages, NEEDS_ADMIN_SALE_MESSAGE, loadNeedsAdminAnswer, needsAdminWire } from '../needs-admin'
import { batchFailure } from '../process'

describe('N-U1: fixed wire reasons and messages', () => {
  it.each([
    ['money_unconfirmed', 'The store could not confirm whether this refund went through. A manager must check it in the store admin.'],
    ['refund_unrecorded', "This order's refunds do not match the till's records. A manager must check them in the store admin."],
    ['park_unrecorded', 'The store could not finish recording this refund. A manager must check it in the store admin.'],
    ['payment_provider', "This sale's payment needs a manager to handle the refund in the store admin."],
    ['session_closed', 'The register session closed before this refund finished, so no money was refunded. A manager can finish it in the store admin.'],
  ])('returns the public refund message for %s', (reason, message) => {
    expect(needsAdminWire({ type: 'order.refund', storedReason: reason, sessionClosedProven: true })).toEqual({ reason, message })
  })

  it.each([undefined, null, 42, {}, 'brand_new_reason', 'constructor', '__proto__', 'admin_check'])('defaults %p to admin_check', storedReason => {
    expect(needsAdminWire({ type: 'order.refund', storedReason, sessionClosedProven: true })).toEqual({
      reason: 'admin_check', message: 'A manager must check this refund in the store admin.',
    })
  })

  it('uses only the sale message for sales and does not handle registers', () => {
    const input = { storedReason: 'session_closed', sessionClosedProven: true }
    expect(needsAdminWire({ type: 'order.create', ...input })).toEqual({ reason: 'admin_check', message: 'A manager must check this sale in the store admin.' })
    expect(needsAdminWire({ type: 'register.session.open', ...input })).toBeNull()
  })

  it('keeps every notice till-safe and reserves the no-money statement for session_closed', () => {
    expect(Object.isFrozen(messages)).toBe(true)
    for (const [reason, message] of [...Object.entries(messages), ['admin_check', NEEDS_ADMIN_SALE_MESSAGE]]) {
      expect(reason).toMatch(/^[a-z][a-z0-9_]{0,39}$/)
      expect(message.length).toBeLessThanOrEqual(500)
      expect(message).not.toMatch(/\d|tally-|resolve|_id|ledger|Medusa/i)
      expect(/no money|refunded|not paid|moved/i.test(message)).toBe(reason === 'session_closed')
    }
  })
})

const id = 'refund-command'
const clearRow = { order_id: 'sale', money_started_at: null, medusa_refund_id: null }
const command = { type: 'order.refund', status: 'needs_admin', needs_admin_reason: { reason: 'session_closed' } }
const uncertain = { reason: 'money_unconfirmed', message: messages.money_unconfirmed }

function proofContainer(row: unknown, refunded: string | null, recorded: number) {
  const knex = (table: string) => ({
    where() { return this }, whereNotNull() { return this }, whereNull() { return this },
    whereIn() { return this }, whereNotIn() { return this }, select: () => [], sum: () => [{ sum: recorded }],
    first: () => table === 'order' ? { metadata: {} } : row,
  })
  const services = {
    [TALLY_LEDGER_MODULE]: { listTallyCommands: () => [command] },
    [ContainerRegistrationKeys.PG_CONNECTION]: knex,
    [ContainerRegistrationKeys.QUERY]: { graph: () => ({ data: [{ id: 'sale', currency_code: 'eur',
      payment_collections: [{ payments: refunded === null ? [] : [{ id: 'payment', raw_amount: { value: '10' },
        refunds: [{ raw_amount: { value: refunded } }] }] }],
    }] }) },
  }
  return { resolve: (key: string) => services[key] } as unknown as MedusaContainer
}

describe('N-U2: session_closed requires current refund and payment proof', () => {
  it('downgrades an unproven session_closed', () => {
    expect(needsAdminWire({ type: 'order.refund', storedReason: 'session_closed', sessionClosedProven: false })).toEqual(uncertain)
  })

  it.each([
    { row: undefined, refunded: '0', recorded: 0 },
    { row: clearRow, refunded: null, recorded: 0 },
    { row: clearRow, refunded: '1.01', recorded: 100 },
    { row: { ...clearRow, money_started_at: new Date() }, refunded: '0', recorded: 0 },
    { row: { ...clearRow, medusa_refund_id: 'refund' }, refunded: '1', recorded: 100 },
  ])('does not claim no money moved for %p', async ({ row, refunded, recorded }) => {
    expect(await loadNeedsAdminAnswer(proofContainer(row, refunded, recorded), id)).toEqual(uncertain)
  })

  it('accepts payment refunds fully accounted for by till records', async () => {
    expect(await loadNeedsAdminAnswer(proofContainer(clearRow, '1', 100), id)).toEqual({ reason: 'session_closed', message: messages.session_closed })
  })
})

describe('N-U3: read failures', () => {
  it('keeps the in_progress response when the command read throws', async () => {
    const container = { resolve: () => ({ listTallyCommands: () => { throw new Error('ledger read') } }) } as unknown as MedusaContainer
    expect(await loadNeedsAdminAnswer(container, id)).toBeNull()
    expect(await batchFailure(container, { kind: 'in_progress', id })).toEqual({ status: 409, body: { code: 'in_progress', id } })
  })

  it('keeps the manager notice when the proof read throws', async () => {
    const container = { resolve: (key: string) => key === TALLY_LEDGER_MODULE ? { listTallyCommands: () => [command] }
      : () => { throw new Error('refund read') } } as unknown as MedusaContainer
    expect(await loadNeedsAdminAnswer(container, id)).toEqual(uncertain)
  })
})
