import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, FeatureFlag, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import tallyPosRoles from '../../src/scripts/tally-pos-roles'
import { loadSessionFigures } from '../../src/workflows/tally-register-command/figures'
import { seed } from './seed'

jest.setTimeout(240000)
const openedAt = '2026-01-01T08:00:00.000Z'
const closedAt = '2026-01-01T10:00:00.000Z'
const built = '../../.medusa/server/src'
// query.graph rows, read loosely: the assertions check their shape.
type Row = Record<string, any>
type Rows = { data: Row[] }

// RBAC on, so the manager check (ADR 0026 decision 7) runs for real; registered before the runner reads medusa-config.
FeatureFlag.setFlag('rbac', true)

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  env: { MEDUSA_FF_RBAC: 'true' },
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer
    let headers: Record<string, string>
    let data: Awaited<ReturnType<typeof seed>>

    async function login(roleId?: string) {
      const email = `refund-${randomUUID()}@example.com`
      const password = 'integration-test-password'
      const user = await container.resolve(Modules.USER).createUsers({ email })
      const auth = container.resolve(Modules.AUTH)
      const { authIdentity, error } = await auth.register('emailpass', { body: { email, password } })
      expect(error).toBeUndefined()
      await auth.updateAuthIdentities({ id: authIdentity!.id, app_metadata: { user_id: user.id } })
      if (roleId) await container.resolve(ContainerRegistrationKeys.LINK).create({
        [Modules.USER]: { user_id: user.id }, [Modules.RBAC]: { rbac_role_id: roleId } })
      const response = await api.post('/auth/user/emailpass', { email, password })
      expect(response.status).toBe(200)
      return { Authorization: `Bearer ${response.data.token}`, 'X-Tally-Protocol': '1' }
    }
    beforeEach(async () => {
      container = getContainer()
      data = await seed(container)
      headers = await login('role_super_admin')
    })
    afterEach(() => jest.restoreAllMocks())

    function command<P>(type: string, payload: P, version = 1) {
      return { id: randomUUID(), type, version, payload, createdAt: openedAt, deviceId: 'test-refund', attempt: 1 }
    }
    function post(commands: unknown[], as = headers) {
      return api.post('/tally/v1/commands', { commands }, { headers: as, validateStatus: () => true })
    }
    async function applied(commands: unknown[]) {
      const response = await post(commands)
      expect(response.data.results?.map(result => result.status)).toEqual(commands.map(() => 'applied'))
      return response.data.results
    }
    /**
     * An open session and a 10.00 EUR sale of variant A in it, paid card 6.00 + cash 4.00 (or all cash). A till discount
     * (gross, as v3 sends it) comes off the line and the cash, with the sale's tax after it.
     */
    async function tillSale(cashOnly = false, discount?: { minor: number; taxMinor: number }) {
      const session = { sessionId: randomUUID(), registerId: randomUUID() }
      const cardId = randomUUID()
      const cashId = randomUUID()
      const clientLineId = randomUUID()
      const d = discount?.minor ?? 0, totalMinor = 1000 - d, taxMinor = discount?.taxMinor ?? 160
      const payments = cashOnly ? [{ clientPaymentId: cashId, method: 'cash', amountMinor: totalMinor, tenderedMinor: 1200, changeMinor: 1200 - totalMinor }]
        : [{ clientPaymentId: cardId, method: 'card', amountMinor: 600 },
          { clientPaymentId: cashId, method: 'cash', amountMinor: totalMinor - 600, tenderedMinor: 500, changeMinor: 1100 - totalMinor }]
      const sale = command('order.create', {
        clientOrderId: randomUUID(), createdAt: openedAt, currency: 'EUR', pricesIncludeTax: true, sessionId: session.sessionId,
        lines: [{ clientLineId, variantId: data.variantA, quantity: 1, unitPriceMinor: 1000, ...(d ? { discountMinor: d } : {}) }],
        ...(d ? { discountMinor: d } : {}), subtotalMinor: totalMinor - taxMinor, taxMinor, totalMinor, payments,
        display: { currency: 'EUR', exponent: 2, taxInclusive: true, subtotalMinor: 1000, discountMinor: d, taxMinor,
          totalMinor, orderDiscountMinor: 0, lines: [{ clientLineId, amountMinor: totalMinor,
            discounts: d ? [{ discountId: 'd', label: 'Till discount', amountMinor: d }] : [] }] },
        taxByRate: [{ ratePpm: 190000, code: 'VAT', netMinor: totalMinor - taxMinor, taxMinor, grossMinor: totalMinor }],
      }, 3)
      const [, created] = await applied([command('register.session.open', { ...session, openedAt, countedFloatMinor: 100 }), sale])
      const orderId = created.serverRefs.orderId as string
      const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: 'order', fields: ['items.id'], filters: { id: orderId } }) as unknown as Rows
      return { ...session, sale, orderId, lineId: order.items[0].id as string, cardId, cashId }
    }
    function refund(till: Awaited<ReturnType<typeof tillSale>>, payload: Record<string, unknown> = {}) {
      return command('order.refund', { clientRefundId: randomUUID(), orderId: till.orderId, registerId: till.registerId,
        sessionId: till.sessionId, lines: [{ orderLineId: till.lineId, quantity: 1, restock: true }], shippingMinor: 0,
        adjustmentMinor: 0, totalMinor: 1000, destination: 'original_method', reason: 'Wrong size', createdAt: openedAt, ...payload })
    }
    async function medusaRefunds(orderId: string) {
      const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'order',
        fields: ['payment_collections.payments.id', 'payment_collections.payments.refunds.id', 'payment_collections.payments.refunds.amount'],
        filters: { id: orderId } }) as unknown as Rows
      return (order.payment_collections as Row[]).flatMap(collection => (collection.payments as Row[]).flatMap(payment =>
        (payment.refunds as Row[]).map(entry => ({ paymentId: payment.id, amount: Number(entry.amount) }))))
    }
    async function returns(orderId: string) {
      const { data: rows } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'return',
        fields: ['id', 'status', 'location_id', 'items.quantity', 'items.received_quantity', 'items.damaged_quantity'],
        filters: { order_id: orderId } }) as unknown as Rows
      return rows
    }
    async function stockA() {
      const { data: [level] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'inventory_level',
        fields: ['stocked_quantity'], filters: { inventory_item_id: data.inventoryA, location_id: data.berlinId } }) as unknown as Rows
      return Number(level.stocked_quantity)
    }
    const commandRow = (id: string) => container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('tally_command').where({ id }).first()
    const resolve = async (id: string, ...args: string[]) => {
      const script = require(`${built}/scripts/tally-ledger-resolve`) as typeof import('../../src/scripts/tally-ledger-resolve')
      await script.default({ container, args: [id, ...args] } as never)
    }

    /** The remainder order (ADR 0026 decision 5): three one-unit lines at 0.99 ex 19% (gross 1.1781 each), paid 3.53 cash. */
    async function remainderSale(charge?: 'fee' | 'shipping') {
      const session = { sessionId: randomUUID(), registerId: randomUUID() }
      const clientLineIds = [randomUUID(), randomUUID(), randomUUID()]
      const fees = charge === 'fee' ? [{ clientFeeId: randomUUID(), name: 'Bag', amountMinor: 100, taxStatus: 'taxable', taxMinor: 19 }] : []
      const shipping = charge === 'shipping' ? [{ clientShippingId: randomUUID(), name: 'Delivery', amountMinor: 500, taxStatus: 'taxable', taxMinor: 95 }] : []
      const netMinor = 297 + (charge === 'fee' ? 100 : charge === 'shipping' ? 500 : 0)
      const taxMinor = 56 + (charge === 'fee' ? 19 : charge === 'shipping' ? 95 : 0), totalMinor = netMinor + taxMinor
      const sale = command('order.create', {
        clientOrderId: randomUUID(), createdAt: openedAt, currency: 'EUR', pricesIncludeTax: false, sessionId: session.sessionId,
        lines: [data.variantA, data.variantB, data.variantC].map((variantId, index) =>
          ({ clientLineId: clientLineIds[index], variantId, quantity: 1, unitPriceMinor: 99 })),
        ...(fees.length ? { fees } : {}), ...(shipping.length ? { shipping } : {}),
        subtotalMinor: 297, taxMinor, totalMinor,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: totalMinor, tenderedMinor: totalMinor + 47, changeMinor: 47 }],
        display: { currency: 'EUR', exponent: 2, taxInclusive: false, subtotalMinor: 297, discountMinor: 0, taxMinor,
          totalMinor, orderDiscountMinor: 0, lines: clientLineIds.map(clientLineId => ({ clientLineId, amountMinor: 99, discounts: [] })),
          ...(fees.length ? { fees: fees.map(({ clientFeeId, amountMinor }) => ({ clientFeeId, amountMinor })) } : {}),
          ...(shipping.length ? { shipping: shipping.map(({ clientShippingId, amountMinor }) => ({ clientShippingId, amountMinor })) } : {}) },
        taxByRate: [{ ratePpm: 190000, code: 'VAT', netMinor, taxMinor, grossMinor: totalMinor }],
      }, charge ? 5 : 3)
      const [, created] = await applied([command('register.session.open', { ...session, openedAt, countedFloatMinor: 100 }), sale])
      const orderId = created.serverRefs.orderId as string
      const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'order',
        fields: ['total', 'items.id', 'items.metadata', 'payment_collections.payments.id', 'payment_collections.payments.amount'],
        filters: { id: orderId } }) as unknown as Rows
      const [payment] = (order.payment_collections as Row[]).flatMap(collection => collection.payments as Row[])
      expect([Number(payment.amount), order.items.length]).toEqual([totalMinor / 100, charge === 'fee' ? 4 : 3])
      const productLines = (order.items as Row[]).filter(item => !item.metadata?.tally_fee_uuid)
      const full = command('order.refund', { clientRefundId: randomUUID(), orderId, ...session,
        lines: productLines.map(item => ({ orderLineId: item.id, quantity: 1, restock: true })), shippingMinor: 0,
        adjustmentMinor: 0, totalMinor: 353, destination: 'original_method', reason: 'Wrong size', createdAt: openedAt })
      return { ...session, orderId, paymentId: payment.id as string, full,
        feeId: (order.items as Row[]).find(item => item.metadata?.tally_fee_uuid)?.id as string | undefined }
    }
    async function stockOf(inventoryItemId: string) {
      const { data: [level] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'inventory_level',
        fields: ['stocked_quantity'], filters: { inventory_item_id: inventoryItemId, location_id: data.berlinId } }) as unknown as Rows
      return Number(level.stocked_quantity)
    }

    it('I10: the remainder over HTTP: the 3.53 order refunded in full at 353 is applied with one Medusa refund of 3.53', async () => {
      const till = await remainderSale()
      expect((await post([till.full])).data.results).toEqual([{ id: till.full.id, status: 'applied', refund: { totalMinor: 353,
        byMethod: { cash: 353 }, refunds: [{ id: expect.stringMatching(/^tref_.+:0$/), paymentId: expect.any(String), totalMinor: 353,
          state: 'succeeded' }] } }])
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: till.paymentId, amount: 3.53 }])
    })

    it.each([
      ['F6-two-then-last', 2, 236, 117], ['F6-one-then-two', 1, 118, 235],
    ] as const)('%s: sequential partial returns refund exactly 353', async (_tag, count, firstMinor, lastMinor) => {
      const till = await remainderSale()
      const first = { ...till.full, payload: { ...till.full.payload, lines: till.full.payload.lines.slice(0, count), totalMinor: firstMinor } }
      expect((await applied([first]))[0].refund.totalMinor).toBe(firstMinor)
      const last = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID(),
        lines: till.full.payload.lines.slice(count), totalMinor: lastMinor })
      expect((await applied([last]))[0].refund.totalMinor).toBe(lastMinor)
      expect((await medusaRefunds(till.orderId)).map(entry => entry.amount).sort((a, b) => b - a))
        .toEqual([firstMinor / 100, lastMinor / 100].sort((a, b) => b - a))
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ status: 'received' }), expect.objectContaining({ status: 'received' })])
    })

    it('F6-fee: product lines refund 353 of a 472 payment; the gross 119 fee is not a line', async () => {
      const till = await remainderSale('fee')
      expect(till.feeId).toEqual(expect.any(String))
      const fee = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID(),
        lines: [{ orderLineId: till.feeId!, quantity: 1, restock: true }], totalMinor: 119 })
      expect((await post([fee])).data.results).toEqual([{ id: fee.id, status: 'rejected', error: { code: 'quantity_exceeds',
        message: expect.any(String), data: { lines: [{ orderLineId: till.feeId, quantity: 1, refundableQuantity: 0 }] } } }])
      expect((await applied([till.full]))[0].refund.totalMinor).toBe(353)
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: till.paymentId, amount: 3.53 }])
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ status: 'received' })])
    })

    it('F6-adjustment-then-last: goodwill of 1 on an order with 5.00 net shipping leaves the lines at 353', async () => {
      const till = await remainderSale('shipping')
      const goodwill = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID(),
        lines: [], adjustmentMinor: 1, totalMinor: 1 })
      expect((await applied([goodwill]))[0].refund.totalMinor).toBe(1)
      expect((await applied([till.full]))[0].refund.totalMinor).toBe(353)
      expect((await medusaRefunds(till.orderId)).map(entry => entry.amount).sort((a, b) => a - b)).toEqual([0.01, 3.53])
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ status: 'received' })])
    })

    it('F3-parked: a received row holds back 118 from the cap and its line money leaves 235 for the last two', async () => {
      const till = await remainderSale()
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      jest.spyOn(workflow, 'moneyStep').mockRejectedValueOnce(new Error('money probe'))
      const first = { ...till.full, payload: { ...till.full.payload, lines: [till.full.payload.lines[0]], totalMinor: 118 } }
      expect((await post([first])).data).toEqual({ code: 'in_progress', id: first.id })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const row = await knex('tally_refund').where({ command_id: first.id }).first()
      expect(row).toMatchObject({ status: 'needs_admin', medusa_refund_id: null })
      expect(row.received_at).not.toBeNull()
      expect(Number(row.total_minor)).toBe(118)
      const over = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID(),
        lines: till.full.payload.lines.slice(1), adjustmentMinor: 118, totalMinor: 353 })
      expect((await post([over])).data.results).toEqual([{ id: over.id, status: 'rejected', error: { code: 'amount_mismatch',
        message: expect.any(String), data: { expectedMinor: 353, serverMinor: 235 } } }])
      const last = command('order.refund', { ...over.payload, clientRefundId: randomUUID(), adjustmentMinor: 0, totalMinor: 235 })
      expect((await applied([last]))[0].refund.totalMinor).toBe(235)
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: till.paymentId, amount: 2.35 }])
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ status: 'received' }), expect.objectContaining({ status: 'received' })])
    })

    it('A-no-row: a failure before beginning the return deletes its row; all three lines still refund 353', async () => {
      const till = await remainderSale()
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      jest.spyOn(workflow, 'beginReturn').mockRejectedValueOnce(new TypeError('begin probe'))
      const first = { ...till.full, payload: { ...till.full.payload, lines: [till.full.payload.lines[0]], totalMinor: 118 } }
      expect((await post([first])).data.results[0]).toMatchObject({ status: 'rejected', error: { code: 'internal_error' } })
      expect(await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('tally_refund').where({ command_id: first.id }).first()).toBeUndefined()
      expect(await returns(till.orderId)).toEqual([])
      expect(await medusaRefunds(till.orderId)).toEqual([])
      const full = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID() })
      expect((await applied([full]))[0].refund.totalMinor).toBe(353)
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: till.paymentId, amount: 3.53 }])
    })

    it('I9: a Medusa refund made outside the plugin parks refund_unrecorded before the receive: no stock moves, no refund', async () => {
      const till = await remainderSale()
      const stock = [await stockOf(data.inventoryA), await stockOf(data.inventoryC)]
      const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
      await refundPaymentWorkflow(container).run({ input: { payment_id: till.paymentId, amount: 0.01, note: 'by hand' } })
      // All lines still cost 353 and exceed the 352 cap; one line at 118 reaches the unrecorded-refund receive guard.
      const order = { ...till.full, payload: { ...till.full.payload, lines: [till.full.payload.lines[0]], totalMinor: 118 } }
      const response = await post([order])
      expect(response.status).toBe(409)
      expect(response.data).toEqual({ code: 'in_progress', id: order.id })
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin',
        needs_admin_reason: { orderId: till.orderId, step: 'receive', reason: 'refund_unrecorded' } })
      const row = await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('tally_refund').where({ command_id: order.id }).first()
      expect(row).toMatchObject({ status: 'needs_admin', received_at: null, medusa_refund_id: null })
      expect([await stockOf(data.inventoryA), await stockOf(data.inventoryC)]).toEqual(stock)
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: till.paymentId, amount: 0.01 }])
    })

    it('I1: a card + cash sale refunded in full by a manager with restock: to the original methods, received, restocked', async () => {
      const before = await stockA()
      const till = await tillSale()
      expect(await stockA()).toBe(before - 1)
      expect((await loadSessionFigures(container, till.sessionId))?.expected).toEqual({ cash: 500, card: 600 })
      const order = refund(till)
      const response = await post([order])
      expect(response.status).toBe(200)
      expect(response.data.results).toEqual([{ id: order.id, status: 'applied', refund: { totalMinor: 1000,
        byMethod: { card: 600, cash: 400 }, refunds: [
          { id: expect.stringMatching(/^tref_.+:0$/), paymentId: till.cardId, totalMinor: 600, state: 'succeeded' },
          { id: expect.stringMatching(/^tref_.+:1$/), paymentId: till.cashId, totalMinor: 400, state: 'succeeded' },
        ] } }])
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ status: 'received', location_id: data.berlinId,
        items: [expect.objectContaining({ quantity: 1, received_quantity: 1, damaged_quantity: 0 })] })])
      expect(await stockA()).toBe(before)
      expect(await loadSessionFigures(container, till.sessionId)).toEqual({ expected: { cash: 100, card: 0 }, salesCount: 1,
        refundsTotalMinor: 1000 })

      // I2: a second refund of the refunded line refuses quantity_exceeds and writes nothing to Medusa.
      const again = refund(till)
      expect((await post([again])).data.results).toEqual([{ id: again.id, status: 'rejected', error: { code: 'quantity_exceeds',
        message: expect.any(String), data: { lines: [{ orderLineId: till.lineId, quantity: 1, refundableQuantity: 0 }] } } }])
      expect(await medusaRefunds(till.orderId)).toHaveLength(1)
      expect(await returns(till.orderId)).toHaveLength(1)

      // I3: a resend is a duplicate of the same result; a new command with I1's clientRefundId is Amendment 3's refusal.
      expect((await post([order])).data.results).toEqual([{ ...response.data.results[0], status: 'duplicate' }])
      const reused = { ...refund(till), payload: order.payload }
      const refundId = response.data.results[0].refund.refunds[0].id.split(':')[0]
      expect((await post([reused])).data.results).toEqual([{ id: reused.id, status: 'rejected', error: { code: 'invalid_payload',
        message: `clientRefundId: ${order.payload.clientRefundId} is already refund ${refundId}` } }])
      expect(await medusaRefunds(till.orderId)).toHaveLength(1)
    })

    it('I4: restock false records the item as damaged and leaves stock as the sale left it', async () => {
      const till = await tillSale()
      const after = await stockA()
      const order = refund(till, { lines: [{ orderLineId: till.lineId, quantity: 1, restock: false }] })
      expect((await post([order])).data.results[0]).toMatchObject({ status: 'applied', refund: { totalMinor: 1000 } })
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ status: 'received',
        items: [expect.objectContaining({ quantity: 1, received_quantity: 1, damaged_quantity: 1 })] })])
      expect(await stockA()).toBe(after)
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
    })

    it('D1: a line with a 2.00 till discount refunds 8.00, its discounted price; asking its 10.00 list price is amount_mismatch', async () => {
      // 8.00 gross at 19% inclusive: net round(8.00 / 1.19) = 6.72, tax 1.28.
      const till = await tillSale(true, { minor: 200, taxMinor: 128 })
      const listPrice = refund(till, { destination: 'cash' })
      expect((await post([listPrice])).data.results).toEqual([{ id: listPrice.id, status: 'rejected', error: { code: 'amount_mismatch',
        message: expect.any(String), data: { expectedMinor: 1000, serverMinor: 800 } } }])
      expect(await medusaRefunds(till.orderId)).toEqual([])
      const order = refund(till, { destination: 'cash', totalMinor: 800 })
      expect((await post([order])).data.results).toEqual([{ id: order.id, status: 'applied', refund: { totalMinor: 800,
        byMethod: { cash: 800 }, refunds: [{ id: expect.stringMatching(/^tref_.+:0$/), paymentId: till.cashId, totalMinor: 800,
          state: 'succeeded' }] } }])
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 8 }])
    })

    it('I5: a failure after the receive parks needs_admin; resend is in progress; resume applies with one refund and one restock', async () => {
      const before = await stockA()
      const till = await tillSale()
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      jest.spyOn(workflow, 'moneyStep').mockRejectedValueOnce(new Error('money probe'))
      const order = refund(till)
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      const parked = await commandRow(order.id)
      expect(parked).toMatchObject({ status: 'needs_admin', needs_admin_reason: { orderId: till.orderId,
        clientRefundId: order.payload.clientRefundId, step: 'refund', message: 'money probe' } })
      expect(await stockA()).toBe(before)
      expect(await medusaRefunds(till.orderId)).toEqual([])
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      // A new command id with the parked clientRefundId is in progress too, and starts no second workflow.
      const reused = { ...refund(till), payload: order.payload }
      expect((await post([reused])).data).toEqual({ code: 'in_progress', id: reused.id })
      expect(await commandRow(reused.id)).toBeUndefined()
      expect(await returns(till.orderId)).toHaveLength(1)
      await resolve(order.id, 'resume')
      expect(await commandRow(order.id)).toMatchObject({ status: 'applied', result: { status: 'applied',
        refund: { totalMinor: 1000, byMethod: { card: 600, cash: 400 } } } })
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ items: [expect.objectContaining({ received_quantity: 1 })] })])
      expect(await stockA()).toBe(before)
      expect((await post([order])).data.results[0]).toMatchObject({ status: 'duplicate', refund: { totalMinor: 1000 } })
    })

    it('C-session-closed / F4: closure figures are read under the lock; resume changes no money, stock or figures', async () => {
      const till = await tillSale(true)
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      jest.spyOn(workflow, 'moneyStep').mockRejectedValueOnce(new Error('money probe'))
      const order = refund(till)
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const row = await knex('tally_refund').where({ command_id: order.id }).first()
      expect(row.received_at).not.toBeNull()
      const submission = command('register.closure.submit', { closureId: randomUUID(), sessionId: till.sessionId,
        registerId: till.registerId, number: 1, openedAt, closedAt, tillExpected: { cash: 1100 }, counted: { cash: 1100 },
        periodSalesTotalMinor: 1000, periodRefundsTotalMinor: 0, perpetualSalesTotalMinor: 1000,
        perpetualRefundsTotalMinor: 0, unsyncedCount: 0, unsyncedTotalMinor: 0, softwareVersion: '1.0',
        orderIds: [till.sale.payload.clientOrderId], movementIds: [] }, 3)
      await applied([command('register.session.transition', { sessionId: till.sessionId, status: 'closed',
        at: closedAt, counted: { cash: 1100 } })])
      const figuresModule = require(`${built}/workflows/tally-register-command/figures`) as typeof import('../../src/workflows/tally-register-command/figures')
      const original = figuresModule.loadSessionFigures
      jest.spyOn(figuresModule, 'loadSessionFigures').mockImplementationOnce(async (...args) => {
        // A second transaction cannot lock this session while the closure computes its expected figures.
        await expect(knex.transaction(trx => trx('tally_register_session').where({ id: row.session_id }).forUpdate().noWait().first()))
          .rejects.toMatchObject({ code: '55P03' })
        return original(...args)
      })
      await applied([submission])
      const figures = await loadSessionFigures(container, till.sessionId), stock = await stockA()
      expect(figures?.expected).toEqual({ cash: 1100 })
      await resolve(order.id, 'resume')
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin',
        needs_admin_reason: { step: 'session', reason: 'session_closed',
          message: `session_closed: refund ${row.id} did not finish before its register session closed; this run moved no money and no stock. Check the order's refunds in Medusa Admin and finish it there.` } })
      expect(await knex('tally_refund').where({ id: row.id }).first()).toMatchObject({ status: 'needs_admin', medusa_refund_id: null })
      expect(await medusaRefunds(till.orderId)).toEqual([])
      expect(await stockA()).toBe(stock)
      expect(await loadSessionFigures(container, till.sessionId)).toEqual(figures)
    })

    it.each([true, false])('F1-apply-closed: apply refuses a filed closure without moving figures (closed=%s)', async closed => {
      const till = await tillSale(true)
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      jest.spyOn(workflow, 'moneyStep').mockRejectedValueOnce(new Error('money probe'))
      const order = refund(till)
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const row = await knex('tally_refund').where({ command_id: order.id }).first()
      expect(row.received_at).not.toBeNull()
      await applied([command('register.closure.submit', { closureId: randomUUID(), sessionId: till.sessionId,
        registerId: till.registerId, number: 1, openedAt, closedAt, tillExpected: { cash: 1100 }, counted: { cash: 1100 },
        periodSalesTotalMinor: 1000, periodRefundsTotalMinor: 0, perpetualSalesTotalMinor: 1000,
        perpetualRefundsTotalMinor: 0, unsyncedCount: 0, unsyncedTotalMinor: 0, softwareVersion: '1.0',
        orderIds: [till.sale.payload.clientOrderId], movementIds: [] }, 3)])
      if (closed) await applied([command('register.session.transition', { sessionId: till.sessionId, status: 'closed',
        at: closedAt, counted: { cash: 1100 } })])
      const { loadRefundOrder } = require(`${built}/workflows/tally-order-refund/execute`) as typeof import('../../src/workflows/tally-order-refund/execute')
      const paymentId = (await loadRefundOrder(container, till.orderId))!.payment!.id
      const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
      await refundPaymentWorkflow(container).run({ input: { payment_id: paymentId, amount: Number(row.total_minor) / 100, note: 'by hand' } })
      const medusa = await knex('refund').where({ payment_id: paymentId }).whereNull('deleted_at').first('id')
      const figures = await loadSessionFigures(container, till.sessionId), stock = await stockA()
      await expect(resolve(order.id, 'apply', medusa.id)).rejects.toThrow(/session is closed.*stays parked/)
      expect(await knex('tally_refund').where({ id: row.id }).first()).toEqual(row)
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: {
        step: 'session', reason: 'session_closed',
        message: `session_closed: refund ${row.id} did not finish before its register session closed; this run moved no money and no stock. Check the order's refunds in Medusa Admin and finish it there.` } })
      expect(await loadSessionFigures(container, till.sessionId)).toEqual(figures)
      expect(await stockA()).toBe(stock)
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId, amount: Number(row.total_minor) / 100 }])
    })

    it('F2-apply-twice: one Medusa refund can be recorded by only one till refund', async () => {
      const till = await remainderSale()
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      const orders = till.full.payload.lines.slice(0, 2).map(line => command('order.refund', {
        ...till.full.payload, clientRefundId: randomUUID(), lines: [line], totalMinor: 118 }))
      for (const order of orders) {
        jest.spyOn(workflow, 'moneyStep').mockRejectedValueOnce(new Error('money probe'))
        expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      }
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const first = await knex('tally_refund').where({ command_id: orders[0].id }).first()
      const second = await knex('tally_refund').where({ command_id: orders[1].id }).first(), parked = await commandRow(orders[1].id)
      expect(first.received_at).not.toBeNull()
      expect(second.received_at).not.toBeNull()
      const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
      await refundPaymentWorkflow(container).run({ input: { payment_id: till.paymentId, amount: 1.18, note: 'by hand' } })
      const medusa = await knex('refund').where({ payment_id: till.paymentId }).whereNull('deleted_at').first('id')
      await resolve(orders[0].id, 'apply', medusa.id)
      expect(await knex('tally_refund').where({ id: first.id }).first()).toMatchObject({ status: 'applied', medusa_refund_id: medusa.id })
      expect(await commandRow(orders[0].id)).toMatchObject({ status: 'applied', result: { status: 'applied', refund: { totalMinor: 118 } } })
      await expect(resolve(orders[1].id, 'apply', medusa.id)).rejects.toThrow(`Refund ${medusa.id} is already recorded by refund ${first.id}; nothing written`)
      expect(await knex('tally_refund').where({ id: second.id }).first()).toEqual(second)
      expect(await commandRow(orders[1].id)).toEqual(parked)
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: till.paymentId, amount: 1.18 }])
    })

    it('F3-filed-closure: a filed closure refuses new refunds and movements before the session transitions', async () => {
      const till = await tillSale(true)
      await applied([command('register.closure.submit', { closureId: randomUUID(), sessionId: till.sessionId,
        registerId: till.registerId, number: 1, openedAt, closedAt, tillExpected: { cash: 1100 }, counted: { cash: 1100 },
        periodSalesTotalMinor: 1000, periodRefundsTotalMinor: 0, perpetualSalesTotalMinor: 1000,
        perpetualRefundsTotalMinor: 0, unsyncedCount: 0, unsyncedTotalMinor: 0, softwareVersion: '1.0',
        orderIds: [till.sale.payload.clientOrderId], movementIds: [] }, 3)])
      const order = refund(till)
      expect((await post([order])).data.results).toEqual([{ id: order.id, status: 'rejected', error: {
        code: 'no_open_session', message: expect.any(String), data: { sessionId: till.sessionId } } }])
      const movement = command('register.movement.record', { movementId: randomUUID(), sessionId: till.sessionId,
        type: 'paid_out', amountMinor: 5, reason: 'payout', createdAt: closedAt })
      expect((await post([movement])).data.results[0]).toMatchObject({ id: movement.id, status: 'rejected', error: { code: 'register_session_closed' } })
    })

    it('F3-counting-resume: a counting session without a closure finishes a received refund and counts it', async () => {
      const till = await tillSale(true)
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      jest.spyOn(workflow, 'moneyStep').mockRejectedValueOnce(new Error('money probe'))
      const order = refund(till)
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const row = await knex('tally_refund').where({ command_id: order.id }).first()
      expect(row.received_at).not.toBeNull()
      await applied([command('register.session.transition', { sessionId: till.sessionId, status: 'counting', at: closedAt })])
      await resolve(order.id, 'resume')
      expect(await knex('tally_refund').where({ id: row.id }).first()).toMatchObject({ status: 'applied' })
      expect(await commandRow(order.id)).toMatchObject({ status: 'applied' })
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: Number(row.total_minor) / 100 }])
      expect(await loadSessionFigures(container, till.sessionId)).toEqual({ expected: { cash: 100 }, salesCount: 1, refundsTotalMinor: 1000 })
    })

    it.each([false, true])('F5-apply: an unreceived row or a different Medusa amount writes nothing (received=%s)', async received => {
      const till = await remainderSale()
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      if (received) jest.spyOn(workflow, 'moneyStep').mockRejectedValueOnce(new Error('money probe'))
      else await refundPaymentWorkflow(container).run({ input: { payment_id: till.paymentId, amount: 0.01, note: 'by hand' } })
      const order = { ...till.full, payload: { ...till.full.payload, lines: [till.full.payload.lines[0]], totalMinor: 118 } }
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      if (received) await refundPaymentWorkflow(container).run({ input: { payment_id: till.paymentId, amount: 0.01, note: 'by hand' } })
      const row = await knex('tally_refund').where({ command_id: order.id }).first(), parked = await commandRow(order.id)
      expect(row).toMatchObject({ status: 'needs_admin', medusa_refund_id: null })
      expect(row.received_at !== null).toBe(received)
      expect(Number(row.total_minor)).toBe(118)
      const medusa = await knex('refund').where({ payment_id: till.paymentId }).whereNull('deleted_at').first('id')
      const stock = [await stockOf(data.inventoryA), await stockOf(data.inventoryC)], beforeReturns = await returns(till.orderId)
      const figures = await loadSessionFigures(container, till.sessionId)
      await expect(resolve(order.id, 'apply', medusa.id)).rejects.toThrow(received
        ? `Refund ${medusa.id} is 1, refund ${row.id} is 118; nothing written`
        : `Refund ${row.id} has not been received; use resume`)
      expect(await knex('tally_refund').where({ id: row.id }).first()).toEqual(row)
      expect(await commandRow(order.id)).toEqual(parked)
      expect([await stockOf(data.inventoryA), await stockOf(data.inventoryC)]).toEqual(stock)
      expect(await returns(till.orderId)).toEqual(beforeReturns)
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: till.paymentId, amount: 0.01 }])
      expect(await loadSessionFigures(container, till.sessionId)).toEqual(figures)
    })

    it('S1-apply-own-id: apply keeps a row\'s own Medusa refund and refuses a different one', async () => {
      const till = await remainderSale()
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      jest.spyOn(workflow, 'moneyStep').mockRejectedValueOnce(new Error('money probe'))
      const order = { ...till.full, payload: { ...till.full.payload, lines: [till.full.payload.lines[0]], totalMinor: 118 } }
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
      await refundPaymentWorkflow(container).run({ input: { payment_id: till.paymentId, amount: 1.18, note: 'by hand' } })
      const r1 = await knex('refund').where({ payment_id: till.paymentId }).whereNull('deleted_at').first('id')
      await knex('tally_refund').where({ command_id: order.id }).update({ medusa_refund_id: r1.id })
      await refundPaymentWorkflow(container).run({ input: { payment_id: till.paymentId, amount: 1.18, note: 'by hand' } })
      const r2 = await knex('refund').where({ payment_id: till.paymentId }).whereNot({ id: r1.id }).whereNull('deleted_at').first('id')
      const row = await knex('tally_refund').where({ command_id: order.id }).first(), parked = await commandRow(order.id)
      expect(row).toMatchObject({ status: 'needs_admin', medusa_refund_id: r1.id })
      expect(row.received_at).not.toBeNull()
      expect(Number(row.total_minor)).toBe(118)
      await expect(resolve(order.id, 'apply', r2.id)).rejects.toThrow(
        `Refund ${row.id} already records Medusa refund ${r1.id}; use resume; nothing written`)
      expect(await knex('tally_refund').where({ id: row.id }).first()).toEqual(row)
      expect(await commandRow(order.id)).toEqual(parked)
      await expect(resolve(order.id, 'apply', r1.id)).resolves.toBeUndefined()
      expect(await knex('tally_refund').where({ id: row.id }).first()).toMatchObject({ status: 'applied', medusa_refund_id: r1.id })
      expect(await commandRow(order.id)).toMatchObject({ status: 'applied' })
    })

    it('I5b: a failure right after the return is begun parks with the return recorded; resume reuses it: one return, one refund', async () => {
      const before = await stockA()
      const till = await tillSale()
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      jest.spyOn(workflow, 'requestReturn').mockRejectedValueOnce(new Error('request probe'))
      jest.spyOn(workflow, 'cancelReturn').mockRejectedValueOnce(new Error('cancel probe'))
      const order = refund(till)
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { step: 'return' } })
      const [begun] = await returns(till.orderId)
      expect(begun).toMatchObject({ status: 'open' })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('tally_refund').where({ command_id: order.id }).first()).toMatchObject({ return_id: begun.id, status: 'needs_admin' })
      await resolve(order.id, 'resume')
      expect(await commandRow(order.id)).toMatchObject({ status: 'applied' })
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ id: begun.id, status: 'received' })])
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
      expect(await stockA()).toBe(before)
    })

    it('I6: a refund Medusa made but the row never recorded is never made twice: resume parks refund_unrecorded', async () => {
      const till = await tillSale()
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      const original = workflow.moneyStep
      jest.spyOn(workflow, 'moneyStep').mockImplementationOnce(async (...args) => {
        await original(...args)
        throw new Error('record probe')
      })
      const order = refund(till)
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      expect(await medusaRefunds(till.orderId)).toHaveLength(1)
      await resolve(order.id, 'resume')
      expect(await medusaRefunds(till.orderId)).toHaveLength(1)
      const parked = await commandRow(order.id)
      expect(parked.status).toBe('needs_admin')
      expect(parked.needs_admin_reason).toMatchObject({ step: 'refund', reason: 'refund_unrecorded',
        message: expect.stringMatching(/^refund_unrecorded/) })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('tally_refund').where({ command_id: order.id }).first()).toMatchObject({ status: 'needs_admin', medusa_refund_id: null })
    })

    describe('I7: refusals', () => {
      it('a user without approve_variance (RBAC on) is forbidden', async () => {
        await tallyPosRoles({ container, args: [] })
        const [cashierRole] = await container.resolve(Modules.RBAC).listRbacRoles({ name: 'POS cashier' })
        const cashier = await login(cashierRole.id)
        const till = await tillSale()
        const order = refund(till)
        expect((await post([order], cashier)).data.results).toEqual([{ id: order.id, status: 'rejected',
          error: { code: 'forbidden', message: expect.any(String) } }])
        expect(await medusaRefunds(till.orderId)).toEqual([])
      })

      it.each(['counting', 'closed'])('a %s session is no_open_session', async status => {
        const till = await tillSale()
        await applied([command('register.session.transition', { sessionId: till.sessionId, status, at: closedAt,
          ...(status === 'closed' ? { counted: { cash: 500 } } : {}) })])
        const order = refund(till)
        expect((await post([order])).data.results).toEqual([{ id: order.id, status: 'rejected', error: {
          code: 'no_open_session', message: expect.any(String), data: { sessionId: till.sessionId } } }])
        expect(await returns(till.orderId)).toEqual([])
      })

      it('an order without tally_client_id is not_till_order', async () => {
        const till = await tillSale()
        const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
        await knex('order').where({ id: till.orderId }).update({ metadata: knex.raw("metadata - 'tally_client_id'") })
        const order = refund(till)
        expect((await post([order])).data.results).toEqual([{ id: order.id, status: 'rejected',
          error: { code: 'not_till_order', message: expect.any(String) } }])
      })

      it('a wrong totalMinor is amount_mismatch with both figures', async () => {
        const till = await tillSale()
        const order = refund(till, { totalMinor: 999 })
        expect((await post([order])).data.results).toEqual([{ id: order.id, status: 'rejected', error: { code: 'amount_mismatch',
          message: expect.any(String), data: { expectedMinor: 999, serverMinor: 1000 } } }])
        expect(await returns(till.orderId)).toEqual([])
      })
    })

    it('I8: a closure after a cash refund counts it: periodRefundsTotalMinor and expected cash', async () => {
      const till = await tillSale(true)
      expect((await post([refund(till)])).data.results[0]).toMatchObject({ status: 'applied', refund: { byMethod: { cash: 1000 } } })
      const figures = await loadSessionFigures(container, till.sessionId)
      expect(figures).toMatchObject({ expected: { cash: 100 }, refundsTotalMinor: 1000 })
      const submission = command('register.closure.submit', { closureId: randomUUID(), sessionId: till.sessionId,
        registerId: till.registerId, number: 1, openedAt, closedAt, tillExpected: { cash: 100 }, counted: { cash: 100 },
        periodSalesTotalMinor: 1000, periodRefundsTotalMinor: figures!.refundsTotalMinor, perpetualSalesTotalMinor: 1000,
        perpetualRefundsTotalMinor: 1000, unsyncedCount: 0, unsyncedTotalMinor: 0, softwareVersion: '1.0',
        orderIds: [till.sale.payload.clientOrderId], movementIds: [] })
      const results = await applied([command('register.session.transition', { sessionId: till.sessionId, status: 'closed',
        at: closedAt, counted: { cash: 100 } }), submission])
      expect(results[1].register.closure).toMatchObject({ expected: { cash: 100 } })
      expect(results[1].register.counters).toMatchObject({ perpetualRefundsTotalMinor: 1000 })
      expect(submission.payload.periodRefundsTotalMinor).toBe(1000)
    })

    it("I8: a refund made in another register's session counts there, not in the sale's session", async () => {
      const till = await tillSale(true)
      const other = { sessionId: randomUUID(), registerId: randomUUID() }
      await applied([command('register.session.open', { ...other, openedAt, countedFloatMinor: 2000 })])
      expect((await post([refund(till, other)])).data.results[0]).toMatchObject({ status: 'applied', refund: { byMethod: { cash: 1000 } } })
      expect(await loadSessionFigures(container, till.sessionId)).toEqual({ expected: { cash: 1100 }, salesCount: 1 })
      expect(await loadSessionFigures(container, other.sessionId)).toEqual({ expected: { cash: 1000 }, salesCount: 0,
        refundsTotalMinor: 1000 })
    })
  },
})
