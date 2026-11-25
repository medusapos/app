import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, FeatureFlag, MedusaError, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import tallyPosRoles from '../../src/scripts/tally-pos-roles'
import { loadSessionFigures } from '../../src/workflows/tally-register-command/figures'
import { Migration20261124120000 } from '../../src/modules/tally-register/migrations/Migration20261124120000'
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
    async function tillSale(cashOnly = false, discount?: { minor: number; taxMinor: number }, registerId: string = randomUUID()) {
      const session = { sessionId: randomUUID(), registerId }
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
    const refundsScript = async (...args: (string | number)[]) => {
      const script = require(`${built}/scripts/tally-refunds`) as typeof import('../../src/scripts/tally-refunds')
      await script.default({ container, args } as never)
    }

    async function parkedReceived(close = true) {
      const till = await tillSale(true)
      const stock = await stockA()
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      jest.spyOn(workflow, 'moneyStep').mockRejectedValueOnce(new Error('money probe'))
      const order = refund(till)
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      expect(await stockA()).toBe(stock + 1)
      expect(await commandRow(order.id)).toMatchObject({ needs_admin_reason: { step: 'refund', reason: 'money_unconfirmed' } })
      if (close) {
        await applied([command('register.closure.submit', { closureId: randomUUID(), sessionId: till.sessionId,
          registerId: till.registerId, number: 1, openedAt, closedAt, tillExpected: { cash: 1100 }, counted: { cash: 1100 },
          periodSalesTotalMinor: 1000, periodRefundsTotalMinor: 0, perpetualSalesTotalMinor: 1000,
          perpetualRefundsTotalMinor: 0, unsyncedCount: 0, unsyncedTotalMinor: 0, softwareVersion: '1.0',
          orderIds: [till.sale.payload.clientOrderId], movementIds: [] }, 3),
        command('register.session.transition', { sessionId: till.sessionId, status: 'closed', at: closedAt, counted: { cash: 1100 } })])
        await resolve(order.id, 'resume', 'money-not-sent')
        expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin',
          needs_admin_reason: { step: 'session', reason: 'session_closed' } })
      }
      const row = await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('tally_refund').where({ command_id: order.id }).first()
      expect(row.received_at).not.toBeNull()
      return { till, order, row }
    }

    /**
     * The remainder order (ADR 0026 decision 5): three one-unit lines at 0.99 ex 19% (gross 1.1781 each), paid 3.53 cash.
     * With free, a fourth line z of variant D at 0 (#546).
     */
    async function remainderSale(charge?: 'fee' | 'shipping', free = false) {
      const session = { sessionId: randomUUID(), registerId: randomUUID() }
      const clientLineIds = [randomUUID(), randomUUID(), randomUUID(), ...(free ? [randomUUID()] : [])]
      const fees = charge === 'fee' ? [{ clientFeeId: randomUUID(), name: 'Bag', amountMinor: 100, taxStatus: 'taxable', taxMinor: 19 }] : []
      const shipping = charge === 'shipping' ? [{ clientShippingId: randomUUID(), name: 'Delivery', amountMinor: 500, taxStatus: 'taxable', taxMinor: 95 }] : []
      const netMinor = 297 + (charge === 'fee' ? 100 : charge === 'shipping' ? 500 : 0)
      const taxMinor = 56 + (charge === 'fee' ? 19 : charge === 'shipping' ? 95 : 0), totalMinor = netMinor + taxMinor
      const sale = command('order.create', {
        clientOrderId: randomUUID(), createdAt: openedAt, currency: 'EUR', pricesIncludeTax: false, sessionId: session.sessionId,
        lines: [data.variantA, data.variantB, data.variantC, ...(free ? [data.variantD] : [])].map((variantId, index) =>
          ({ clientLineId: clientLineIds[index], variantId, quantity: 1, unitPriceMinor: index === 3 ? 0 : 99 })),
        ...(fees.length ? { fees } : {}), ...(shipping.length ? { shipping } : {}),
        subtotalMinor: 297, taxMinor, totalMinor,
        payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: totalMinor, tenderedMinor: totalMinor + 47, changeMinor: 47 }],
        display: { currency: 'EUR', exponent: 2, taxInclusive: false, subtotalMinor: 297, discountMinor: 0, taxMinor,
          totalMinor, orderDiscountMinor: 0, lines: clientLineIds.map((clientLineId, index) => ({ clientLineId, amountMinor: index === 3 ? 0 : 99, discounts: [] })),
          ...(fees.length ? { fees: fees.map(({ clientFeeId, amountMinor }) => ({ clientFeeId, amountMinor })) } : {}),
          ...(shipping.length ? { shipping: shipping.map(({ clientShippingId, amountMinor }) => ({ clientShippingId, amountMinor })) } : {}) },
        taxByRate: [{ ratePpm: 190000, code: 'VAT', netMinor, taxMinor, grossMinor: totalMinor }],
      }, charge ? 5 : 3)
      const [, created] = await applied([command('register.session.open', { ...session, openedAt, countedFloatMinor: 100 }), sale])
      const orderId = created.serverRefs.orderId as string
      const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'order',
        fields: ['total', 'items.id', 'items.metadata', 'items.variant_id', 'payment_collections.payments.id', 'payment_collections.payments.amount'],
        filters: { id: orderId } }) as unknown as Rows
      const [payment] = (order.payment_collections as Row[]).flatMap(collection => collection.payments as Row[])
      expect([Number(payment.amount), order.items.length]).toEqual([totalMinor / 100, charge === 'fee' || free ? 4 : 3])
      const productLines = (order.items as Row[]).filter(item => !item.metadata?.tally_fee_uuid)
      const full = command('order.refund', { clientRefundId: randomUUID(), orderId, ...session,
        lines: productLines.map(item => ({ orderLineId: item.id, quantity: 1, restock: true })), shippingMinor: 0,
        adjustmentMinor: 0, totalMinor: 353, destination: 'original_method', reason: 'Wrong size', createdAt: openedAt })
      return { ...session, orderId, paymentId: payment.id as string, full,
        feeId: (order.items as Row[]).find(item => item.metadata?.tally_fee_uuid)?.id as string | undefined,
        freeId: (order.items as Row[]).find(item => free && item.variant_id === data.variantD)?.id as string | undefined }
    }
    /** An Admin refund made once the next till command is priced (after its return is requested), so the receive parks it. */
    function refundAfterPricing(paymentId: string, amount: number) {
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      const original = workflow.requestReturn
      jest.spyOn(workflow, 'requestReturn').mockImplementationOnce(async (...args) => {
        await original(...args)
        const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
        await refundPaymentWorkflow(container).run({ input: { payment_id: paymentId, amount, note: 'by hand' } })
      })
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

    it('I-546-1: the ADR N1 sale: a, b, c at 118 each, then the free z alone is a stock-only return with no Medusa refund', async () => {
      const till = await remainderSale('shipping', true)
      expect(till.freeId).toEqual(expect.any(String))
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      for (const line of till.full.payload.lines.filter(entry => entry.orderLineId !== till.freeId)) {
        const one = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID(), lines: [line], totalMinor: 118 })
        expect((await applied([one]))[0].refund.totalMinor).toBe(118)
      }
      const stock = await stockOf(data.inventoryD)
      const money = jest.spyOn(workflow, 'moneyStep')
      const z = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID(),
        lines: [{ orderLineId: till.freeId!, quantity: 1, restock: true }], shippingMinor: 0, adjustmentMinor: 0, totalMinor: 0 })
      expect((await post([z])).data).toEqual({ results: [{ id: z.id, status: 'applied', refund: { totalMinor: 0, byMethod: {}, refunds: [] } }] })
      expect(money).not.toHaveBeenCalled()
      expect(await medusaRefunds(till.orderId)).toEqual([1, 2, 3].map(() => ({ paymentId: till.paymentId, amount: 1.18 })))
      const received = (await returns(till.orderId)).filter(entry => entry.status === 'received')
      expect(received).toHaveLength(4)
      expect(await stockOf(data.inventoryD)).toBe(stock + 1)
      const row = await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('tally_refund').where({ command_id: z.id }).first()
      expect(row).toMatchObject({ status: 'applied', medusa_refund_id: null, money_started_at: null, received_at: expect.any(Date) })
    })

    // #547 (desk 2026-11-24): earlier goodwill no row puts on a line lets Refund all pass at what is left.
    const differsMessage = "The refund total differs from the store's."
    const capMessage = 'The refund is more than the money the order has left to refund.'
    const detailFields = ['items.id', 'items.detail.return_requested_quantity', 'items.detail.return_received_quantity',
      'items.detail.return_dismissed_quantity', 'items.detail.written_off_quantity']

    it('clamp: Admin goodwill, Refund all at what is left', async () => {
      const till = await remainderSale()
      const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
      await refundPaymentWorkflow(container).run({ input: { payment_id: till.paymentId, amount: 0.01, note: 'goodwill in Admin' } })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const hand = await knex('refund').where({ payment_id: till.paymentId }).whereNull('deleted_at').first('id')
      // An admin's own refund is baselined; one with no baseline is refused up front (I9).
      await refundsScript('baseline', till.orderId, hand.id, 'goodwill', 'in', 'Admin')
      const over = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID() })
      expect((await post([over])).data.results).toEqual([{ id: over.id, status: 'rejected', error: { code: 'amount_mismatch',
        message: differsMessage, data: { expectedMinor: 353, serverMinor: 352 } } }])
      const full = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID(), totalMinor: 352 })
      expect((await applied([full]))[0].refund).toMatchObject({ totalMinor: 352, byMethod: { cash: 352 } })
      expect((await medusaRefunds(till.orderId)).map(entry => entry.amount).sort((a, b) => a - b)).toEqual([0.01, 3.52])
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ status: 'received' })])
      expect((await loadSessionFigures(container, till.sessionId))?.refundsTotalMinor).toBe(352)
      const row = await knex('tally_refund').where({ command_id: full.id }).first()
      expect(row.lines.map((line: Row) => [line.netMinor, line.taxMinor])).toEqual([[99, 19], [98, 19], [98, 19]])
    })

    const outsideMessage = 'This order has a refund made outside the till (Medusa shows more refunded than the till recorded). Finish it in Medusa Admin.'
    it('R3-outside: an Admin refund with no baseline refuses Refund all up front: no row, no return, no stock moved', async () => {
      const till = await remainderSale()
      const stock = [await stockOf(data.inventoryA), await stockOf(data.inventoryC)]
      const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
      await refundPaymentWorkflow(container).run({ input: { payment_id: till.paymentId, amount: 0.01, note: 'goodwill in Admin' } })
      const full = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID(), totalMinor: 352 })
      expect((await post([full])).data.results).toEqual([{ id: full.id, status: 'rejected', error: { code: 'order_state',
        message: outsideMessage, data: { reason: 'refunded_outside_till', outsideMinor: 1 } } }])
      expect(await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('tally_refund').where({ order_id: till.orderId })).toEqual([])
      expect(await returns(till.orderId)).toEqual([])
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: till.paymentId, amount: 0.01 }])
      expect([await stockOf(data.inventoryA), await stockOf(data.inventoryC)]).toEqual(stock)
    })

    it('clamp: Admin return blocks the clamp', async () => {
      const till = await remainderSale()
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      const lines = [till.full.payload.lines[0]]
      const returnId = await workflow.beginReturn(container, { orderId: till.orderId, locationId: data.berlinId, note: 'return in Admin',
        refundRowId: 'tref_admin_return' })
      await workflow.requestReturn(container, { returnId, lines })
      await workflow.receiveStep(container, { returnId, lines })
      const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
      await refundPaymentWorkflow(container).run({ input: { payment_id: till.paymentId, amount: 1.18, note: 'return in Admin' } })
      const hand = await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('refund').where({ payment_id: till.paymentId }).first('id')
      await refundsScript('baseline', till.orderId, hand.id, 'return', 'in', 'Admin')
      // No row knows the return: two lines price at 236 on a cap of 235, and the 118 looks like goodwill (G = 353 − 235).
      // Medusa's returned quantity on line a keeps the clamp off. (All three lines stop earlier, at money_drift.)
      const rest = till.full.payload.lines.slice(1)
      const two = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID(), lines: rest, totalMinor: 236 })
      expect((await post([two])).data.results).toEqual([{ id: two.id, status: 'rejected', error: { code: 'amount_mismatch',
        message: capMessage, data: { expectedMinor: 236, serverMinor: 235 } } }])
      const left = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID(), lines: rest, totalMinor: 235 })
      expect((await post([left])).data.results).toEqual([{ id: left.id, status: 'rejected', error: { code: 'amount_mismatch',
        message: differsMessage, data: { expectedMinor: 235, serverMinor: 236 } } }])
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: till.paymentId, amount: 1.18 }])
    })

    it('clamp: own returns never block', async () => {
      const till = await remainderSale()
      const [a, b, c] = till.full.payload.lines
      const part = (lines: unknown[], totalMinor: number, adjustmentMinor = 0) => command('order.refund', { ...till.full.payload,
        clientRefundId: randomUUID(), lines, adjustmentMinor, totalMinor })
      expect((await applied([part([a], 118)]))[0].refund.totalMinor).toBe(118)
      expect((await applied([part([{ ...b, restock: false }], 118)]))[0].refund.totalMinor).toBe(118)
      expect((await applied([part([], 1, 1)]))[0].refund.totalMinor).toBe(1)
      // Received counts once; a dismiss lands in both return_dismissed and written_off, and only the first is counted.
      const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'order', fields: detailFields,
        filters: { id: till.orderId } }) as unknown as Rows
      const detail = (id: string) => { const found = (order.items as Row[]).find(item => item.id === id)!.detail
        return [found.return_requested_quantity, found.return_received_quantity, found.return_dismissed_quantity, found.written_off_quantity].map(Number) }
      expect([detail(a.orderLineId), detail(b.orderLineId), detail(c.orderLineId)]).toEqual([[0, 1, 0, 0], [0, 0, 1, 1], [0, 0, 0, 0]])
      // C = 353 − 118 − 118 − 1 = 116; the last line prices at the 117 left and the clamp takes the goodwill off it.
      expect((await applied([part([c], 116)]))[0].refund.totalMinor).toBe(116)
      expect((await medusaRefunds(till.orderId)).map(entry => entry.amount).sort((x, y) => x - y)).toEqual([0.01, 1.16, 1.18, 1.18])
    })

    /** #565: the sale's lines by variant (a = A, stocked; b = B, not stocked; c = C, stocked), and a return of a received in Admin. */
    async function adminReturnOfA() {
      const till = await remainderSale()
      const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'order',
        fields: ['items.id', 'items.variant_id'], filters: { id: till.orderId } }) as unknown as Rows
      const lineOf = (variantId: string) => till.full.payload.lines.find((entry: Row) =>
        entry.orderLineId === (order.items as Row[]).find(item => item.variant_id === variantId)!.id)!
      const [a, b, c] = [lineOf(data.variantA), lineOf(data.variantB), lineOf(data.variantC)]
      const stock = [await stockOf(data.inventoryA), await stockOf(data.inventoryC)]
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      const returnId = await workflow.beginReturn(container, { orderId: till.orderId, locationId: data.berlinId, note: 'return in Admin',
        refundRowId: 'tref_admin_return' })
      await workflow.requestReturn(container, { returnId, lines: [a] })
      await workflow.receiveStep(container, { returnId, lines: [a] })
      expect([await stockOf(data.inventoryA), await stockOf(data.inventoryC)]).toEqual([stock[0] + 1, stock[1]])
      return { till, a, b, c, stock: [stock[0] + 1, stock[1]] }
    }
    const tillRefunds = (orderId: string) => container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('tally_refund').where({ order_id: orderId })

    it('I-565-1: an Admin return of line a, no refund: Refund all refuses quantity_exceeds; no row, return, stock move or refund', async () => {
      const { till, a, stock } = await adminReturnOfA()
      const full = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID() })
      expect((await post([full])).data.results).toEqual([{ id: full.id, status: 'rejected', error: { code: 'quantity_exceeds',
        message: expect.any(String), data: { lines: [{ orderLineId: a.orderLineId, quantity: 1, refundableQuantity: 0 }] } } }])
      expect(await tillRefunds(till.orderId)).toEqual([])
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ status: 'received' })])
      expect([await stockOf(data.inventoryA), await stockOf(data.inventoryC)]).toEqual(stock)
      expect(await medusaRefunds(till.orderId)).toEqual([])
    })

    it('I-565-2: an Admin return of line a: the till refunds b and c, restocked once; a refund of a then refuses', async () => {
      const { till, a, b, c, stock } = await adminReturnOfA()
      const rest = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID(), lines: [b, c], totalMinor: 236 })
      expect((await applied([rest]))[0].refund.totalMinor).toBe(236)
      expect([await stockOf(data.inventoryA), await stockOf(data.inventoryC)]).toEqual([stock[0], stock[1] + 1])
      const again = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID(), lines: [a], totalMinor: 117 })
      expect((await post([again])).data.results).toEqual([{ id: again.id, status: 'rejected', error: { code: 'quantity_exceeds',
        message: expect.any(String), data: { lines: [{ orderLineId: a.orderLineId, quantity: 1, refundableQuantity: 0 }] } } }])
      expect([await stockOf(data.inventoryA), await stockOf(data.inventoryC)]).toEqual([stock[0], stock[1] + 1])
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: till.paymentId, amount: 2.36 }])
      expect(await tillRefunds(till.orderId)).toHaveLength(1)
      expect(await returns(till.orderId)).toHaveLength(2)
    })

    it('I-565-3: till-only history: line a, then the rest at the remainder; one restock per line', async () => {
      const till = await remainderSale()
      const stock = [await stockOf(data.inventoryA), await stockOf(data.inventoryC)]
      const [first, ...others] = till.full.payload.lines
      const part = (lines: unknown[], totalMinor: number) => command('order.refund', { ...till.full.payload, clientRefundId: randomUUID(), lines, totalMinor })
      expect((await applied([part([first], 118)]))[0].refund.totalMinor).toBe(118)
      expect((await applied([part(others, 235)]))[0].refund.totalMinor).toBe(235)
      expect([await stockOf(data.inventoryA), await stockOf(data.inventoryC)]).toEqual([stock[0] + 1, stock[1] + 1])
      expect((await medusaRefunds(till.orderId)).map(entry => entry.amount).sort((x, y) => x - y)).toEqual([1.18, 2.35])
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ status: 'received' }), expect.objectContaining({ status: 'received' })])
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

    it('I9: a Medusa refund made outside the plugin is refused up front (#547): no row, no return, no stock moves, no refund', async () => {
      const till = await remainderSale()
      const stock = [await stockOf(data.inventoryA), await stockOf(data.inventoryC)]
      const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
      await refundPaymentWorkflow(container).run({ input: { payment_id: till.paymentId, amount: 0.01, note: 'by hand' } })
      // The receive park for a refund made while a command runs is F5-apply (received=false), B1 and B3.
      const order = { ...till.full, payload: { ...till.full.payload, lines: [till.full.payload.lines[0]], totalMinor: 118 } }
      expect((await post([order])).data.results).toEqual([{ id: order.id, status: 'rejected', error: { code: 'order_state',
        message: outsideMessage, data: { reason: 'refunded_outside_till', outsideMinor: 1 } } }])
      expect(await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('tally_refund').where({ command_id: order.id }).first()).toBeUndefined()
      expect(await returns(till.orderId)).toEqual([])
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
        clientRefundId: order.payload.clientRefundId, step: 'refund', reason: 'money_unconfirmed', message: expect.stringMatching(/^money probe\. /) } })
      expect(parked.needs_admin_reason.message.endsWith("An earlier attempt at this refund may still be running: wait a few minutes, then look at the order's refunds in Medusa. A till sale is paid through Medusa's manual payment, so Medusa only records a refund and sends no money; the till hands the money back. If Medusa shows this refund, use tally-ledger-resolve apply <medusaRefundId>. If it does not, use tally-ledger-resolve resume money-not-sent to record it. Do this before the register session closes: until then the session's expected figures leave this refund out, so the count will not match (cash shows short by the refund's cash part).")).toBe(true)
      expect(await stockA()).toBe(before)
      expect(await medusaRefunds(till.orderId)).toEqual([])
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      // A new command id with the parked clientRefundId is in progress too, and starts no second workflow.
      const reused = { ...refund(till), payload: order.payload }
      expect((await post([reused])).data).toEqual({ code: 'in_progress', id: reused.id })
      expect(await commandRow(reused.id)).toBeUndefined()
      expect(await returns(till.orderId)).toHaveLength(1)
      await resolve(order.id, 'resume', 'money-not-sent')
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
      await resolve(order.id, 'resume', 'money-not-sent')
      expect(await knex('tally_refund').where({ id: row.id }).first()).toMatchObject({ status: 'applied' })
      expect(await commandRow(order.id)).toMatchObject({ status: 'applied' })
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: Number(row.total_minor) / 100 }])
      expect(await loadSessionFigures(container, till.sessionId)).toEqual({ expected: { cash: 100 }, salesCount: 1, refundsTotalMinor: 1000 })
    })

    it('T-takeover-closed: a takeover of an expired claim whose session closed parks session_closed, moving no money or stock', async () => {
      const till = await tillSale()
      const stock = await stockA()
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      jest.spyOn(workflow, 'requestReturn').mockRejectedValueOnce(new Error('request probe'))
      jest.spyOn(workflow, 'cancelReturn').mockRejectedValueOnce(new Error('cancel probe'))
      const order = refund(till)
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const row = await knex('tally_refund').where({ command_id: order.id }).first()
      const [begun] = await returns(till.orderId)
      expect(row).toMatchObject({ return_id: begun.id, received_at: null, medusa_refund_id: null })
      // The first worker died holding its claim: the row and command stay in_progress past the lease.
      await knex('tally_refund').where({ id: row.id }).update({ status: 'in_progress' })
      await knex('tally_command').where({ id: order.id }).update({ status: 'in_progress', needs_admin_reason: null,
        updated_at: knex.raw("now() - interval '1 hour'") })
      await applied([command('register.session.transition', { sessionId: till.sessionId, status: 'closed',
        at: closedAt, counted: { cash: 500 } })])
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { step: 'session',
        reason: 'session_closed', message: expect.stringMatching(/^session_closed: refund /) } })
      expect(await knex('tally_refund').where({ id: row.id }).first()).toMatchObject({ status: 'needs_admin', received_at: null,
        medusa_refund_id: null })
      expect(await medusaRefunds(till.orderId)).toEqual([])
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ id: begun.id, status: 'open' })])
      expect(await stockA()).toBe(stock)
    })

    // #543 window 1: a run that died between beginReturn and recording its id. The row is in_progress with no return_id,
    // its open return carries the row's tag, and the command's claim is past its lease.
    async function crashed() {
      const before = await stockA()
      const till = await tillSale()
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      jest.spyOn(workflow, 'requestReturn').mockRejectedValueOnce(new Error('request probe'))
      jest.spyOn(workflow, 'cancelReturn').mockRejectedValueOnce(new Error('cancel probe'))
      const order = refund(till)
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const row = await knex('tally_refund').where({ command_id: order.id }).first()
      const begun = await knex('return').where({ order_id: till.orderId }).first()
      expect(begun).toMatchObject({ id: row.return_id, status: 'open', metadata: { tally_refund_id: row.id } })
      await knex('tally_refund').where({ id: row.id }).update({ status: 'in_progress', return_id: null })
      await knex('tally_command').where({ id: order.id }).update({ status: 'in_progress', needs_admin_reason: null,
        updated_at: knex.raw("now() - interval '1 hour'") })
      return { before, till, workflow, order, knex, row, begun }
    }

    it('W1-reuse: a retry records the open return its row began instead of beginning a second: one return, one refund', async () => {
      const { before, till, order, knex, row, begun } = await crashed()
      expect((await post([order])).data.results).toEqual([expect.objectContaining({ id: order.id, status: 'applied' })])
      expect(await knex('tally_refund').where({ id: row.id }).first()).toMatchObject({ status: 'applied', return_id: begun.id })
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ id: begun.id, status: 'received' })])
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
      expect(await stockA()).toBe(before)
    })

    for (const [name, metadata] of [['untagged', null], ['other row', { tally_refund_id: 'tref_someone_else' }]] as const) {
      it(`W1-foreign: ${name}: an open return that is not this row's is never reused; the retry refuses and leaves it open`, async () => {
        const { till, order, knex, row, begun } = await crashed()
        await knex('return').where({ id: begun.id }).update({ metadata })
        expect((await post([order])).data.results[0]).toMatchObject({ status: 'rejected', error: { code: 'platform_error' } })
        expect(await knex('tally_refund').where({ id: row.id }).first()).toBeUndefined()
        expect(await knex('return').where({ order_id: till.orderId })).toEqual([expect.objectContaining({ id: begun.id,
          status: 'open', metadata })])
        expect(await medusaRefunds(till.orderId)).toEqual([])
      })
    }

    it('W1-not-reused: cancelled: a cancelled tagged return stays cancelled; the retry begins a new one and finishes', async () => {
      const { before, till, workflow, order, knex, begun } = await crashed()
      await workflow.cancelReturn(container, begun.id)
      expect((await post([order])).data.results).toEqual([expect.objectContaining({ id: order.id, status: 'applied' })])
      // Medusa cancels a return request by soft-deleting the return; it stays so, and the refund has a second return.
      expect(await knex('return').where({ id: begun.id }).first()).toMatchObject({ deleted_at: expect.any(Date) })
      const after = await returns(till.orderId)
      expect(after).toEqual([expect.objectContaining({ status: 'received' })])
      const second = after[0]
      expect(second.id).not.toBe(begun.id)
      expect(await knex('tally_refund').where({ command_id: order.id }).first()).toMatchObject({ status: 'applied',
        return_id: second.id })
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
      expect(await stockA()).toBe(before)
    })

    it('W1-not-reused: not open: a tagged return whose status is no longer open is not reused; the retry refuses as today', async () => {
      const { till, order, knex, row, begun } = await crashed()
      await knex('return').where({ id: begun.id }).update({ status: 'requested' })
      expect((await post([order])).data.results[0]).toMatchObject({ status: 'rejected', error: { code: 'platform_error' } })
      expect(await knex('tally_refund').where({ id: row.id }).first()).toBeUndefined()
      expect(await knex('return').where({ order_id: till.orderId })).toEqual([expect.objectContaining({ id: begun.id,
        status: 'requested', metadata: { tally_refund_id: row.id } })])
      expect(await medusaRefunds(till.orderId)).toEqual([])
    })

    it('W1-lookup-fails-parks: a lookup that throws parks at the return step and never deletes the row', async () => {
      const { till, workflow, order, knex, row, begun } = await crashed()
      jest.spyOn(workflow, 'findOwnOpenReturn').mockRejectedValueOnce(new Error('lookup probe'))
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { step: 'return',
        message: 'lookup probe' } })
      expect(await knex('tally_refund').where({ id: row.id }).first()).toMatchObject({ status: 'needs_admin', return_id: null })
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ id: begun.id, status: 'open' })])
    })

    // #543 round 2: an open tagged return is reused only while its active request change is empty.
    const activeChanges = (knex: any, returnId: string) => knex('order_change')
      .where({ return_id: returnId }).whereIn('status', ['pending', 'requested']).whereNull('deleted_at')
    it('R2-no-change: a tagged return left without an active change (death inside the begin) is cancelled; a second return finishes the refund', async () => {
      const { before, till, order, knex, row, begun } = await crashed()
      const ids = await activeChanges(knex, begun.id).pluck('id')
      expect(ids).toHaveLength(1)
      await knex('order_change_action').whereIn('order_change_id', ids).delete()
      await knex('order_change').whereIn('id', ids).delete()
      expect((await post([order])).data.results).toEqual([expect.objectContaining({ id: order.id, status: 'applied' })])
      const recorded = await knex('tally_refund').where({ id: row.id }).first()
      expect(recorded).toMatchObject({ status: 'applied' })
      expect(recorded.return_id).not.toBe(begun.id)
      expect(await returns(till.orderId)).toEqual(expect.arrayContaining([expect.objectContaining({ id: begun.id, status: 'canceled' }),
        expect.objectContaining({ id: recorded.return_id, status: 'received' })]))
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
      expect(await stockA()).toBe(before)
    })

    // #565b: the orphan of R2-no-change, made by crashed() with its active change deleted.
    async function orphaned() {
      const crash = await crashed()
      const ids = await activeChanges(crash.knex, crash.begun.id).pluck('id')
      await crash.knex('order_change_action').whereIn('order_change_id', ids).delete()
      await crash.knex('order_change').whereIn('id', ids).delete()
      return crash
    }

    it('O1-cancel-fails-parks: an orphan whose cancel throws parks at the return step; no second return, no money, no stock', async () => {
      const { till, workflow, order, knex, row, begun } = await orphaned()
      const stock = await stockA()
      jest.spyOn(workflow, 'cancelOrphanReturn').mockRejectedValueOnce(new Error('orphan cancel probe'))
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { step: 'return',
        message: expect.stringMatching(new RegExp(`${begun.id}.*orphan cancel probe`)) } })
      expect(await knex('tally_refund').where({ id: row.id }).first()).toMatchObject({ status: 'needs_admin', return_id: null })
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ id: begun.id, status: 'open' })])
      expect(await medusaRefunds(till.orderId)).toEqual([])
      expect(await stockA()).toBe(stock)
    })

    it('O2-other-tag: an open return with no items and no change tagged with another row is never cancelled; the retry behaves as today', async () => {
      const { before, till, order, knex, row, begun } = await orphaned()
      await knex('return').where({ id: begun.id }).update({ metadata: { tally_refund_id: 'tref_someone_else' } })
      expect((await post([order])).data.results).toEqual([expect.objectContaining({ id: order.id, status: 'applied' })])
      const recorded = await knex('tally_refund').where({ id: row.id }).first()
      expect(recorded).toMatchObject({ status: 'applied' })
      expect(recorded.return_id).not.toBe(begun.id)
      expect(await returns(till.orderId)).toEqual(expect.arrayContaining([expect.objectContaining({ id: begun.id, status: 'open' }),
        expect.objectContaining({ id: recorded.return_id, status: 'received' })]))
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
      expect(await stockA()).toBe(before)
    })

    it('R2-actions: a tagged return whose request holds an Admin\'s items is not reused; the retry refuses and leaves them', async () => {
      const { till, order, knex, row, begun } = await crashed()
      const stock = await stockA()
      const { requestItemReturnWorkflow } = require('@medusajs/medusa/core-flows')
      await requestItemReturnWorkflow(container).run({ input: { return_id: begun.id, items: [{ id: till.lineId, quantity: 1 }] } })
      const [changeId] = await activeChanges(knex, begun.id).pluck('id')
      const actions = async () => (await knex('order_change_action').where({ order_change_id: changeId }).whereNull('deleted_at')).length
      expect(await actions()).toBe(1)
      expect((await post([order])).data.results[0]).toMatchObject({ status: 'rejected', error: { code: 'platform_error' } })
      expect(await knex('tally_refund').where({ id: row.id }).first()).toBeUndefined()
      expect(await knex('return').where({ order_id: till.orderId })).toEqual([expect.objectContaining({ id: begun.id, status: 'open' })])
      expect(await actions()).toBe(1)
      expect(await medusaRefunds(till.orderId)).toEqual([])
      expect(await stockA()).toBe(stock)
    })

    it('R2-reuse-request-fails: a reused return whose request fails is cancelled and the row deleted, as for a begun one', async () => {
      const { till, workflow, order, knex, row, begun } = await crashed()
      const stock = await stockA()
      jest.spyOn(workflow, 'requestReturn').mockRejectedValueOnce(new MedusaError(MedusaError.Types.NOT_ALLOWED, 'request probe'))
      expect((await post([order])).data.results[0]).toMatchObject({ status: 'rejected', error: { code: 'platform_error',
        message: expect.stringContaining('request probe') } })
      expect(await knex('return').where({ id: begun.id }).first()).toMatchObject({ deleted_at: expect.any(Date) })
      expect(await knex('tally_refund').where({ id: row.id }).first()).toBeUndefined()
      expect(await medusaRefunds(till.orderId)).toEqual([])
      expect(await stockA()).toBe(stock)
    })

    // #543 window 2: a run paused inside a Medusa step, still holding the order lock, until the test lets it go.
    type Workflow = typeof import('../../src/workflows/tally-order-refund/workflow')
    function paused(step: 'moneyStep' | 'receiveStep' | 'requestReturn' | 'cancelOrphanReturn', dies = false) {
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as Workflow
      const original = workflow[step] as (...args: unknown[]) => Promise<unknown>
      let entered!: () => void, release!: () => void
      const reached = new Promise<void>(resolve => { entered = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      jest.spyOn(workflow, step).mockImplementationOnce((async (...args: unknown[]) => {
        entered()
        await gate
        if (dies) throw new Error('dead run: the step never ran')
        return original(...args)
      }) as never)
      return { reached, release }
    }
    const knexOf = () => container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const ageClaim = (id: string) => knexOf()('tally_command').where({ id }).update({ updated_at: knexOf().raw("now() - interval '1 hour'") })
    // The backends holding the order's refund lock (takeOrderLock's two keys) in this database; `waiting`: blocked on a row lock.
    const lockHolders = async (orderId: string, waiting = false): Promise<number[]> => (await knexOf().raw(`select l.pid from pg_locks l
      join pg_stat_activity a on a.pid = l.pid where l.locktype = 'advisory' and l.granted and l.objsubid = 2
      and l.database = (select oid from pg_database where datname = current_database()) and l.classid = hashtext('tally_refund')::oid
      and l.objid = hashtext(?)::oid${waiting ? " and a.wait_event_type = 'Lock'" : ''}`, [orderId])).rows.map((r: Row) => r.pid)
    async function untilHeld(orderId: string, waiting = false) {
      for (let n = 0; n < 150; n++) {
        const pids = await lockHolders(orderId, waiting)
        if (pids.length) return pids
        await new Promise(done => setTimeout(done, 100))
      }
      throw new Error(`No run holds order ${orderId}'s refund lock`)
    }
    // #573: ends the backend holding the order's lock (a dead run's trx) and waits until the lock is free.
    async function terminateHolder(orderId: string) {
      const pids = await lockHolders(orderId)
      expect(pids).toHaveLength(1)
      expect((await knexOf().raw('select pg_terminate_backend(?) as ended', [pids[0]])).rows[0].ended).toBe(true)
      for (let n = 0; n < 50 && (await lockHolders(orderId)).length; n++) await new Promise(done => setTimeout(done, 100))
      expect(await lockHolders(orderId)).toEqual([])
    }
    // The refund row and its command, byte for byte.
    const bytes = async (commandId: string) => Promise.all(['tally_refund t where command_id', 'tally_command t where id'].map(async from =>
      (await knexOf().raw(`select row_to_json(t)::text as json from ${from} = ?`, [commandId])).rows[0]?.json))
    const oneLine = (till: Awaited<ReturnType<typeof remainderSale>>, n: number) => command('order.refund', { ...till.full.payload,
      clientRefundId: randomUUID(), lines: [till.full.payload.lines[n]], totalMinor: 118 })

    it('W2-long-run: a retry past the lease answers in_progress and keeps the command; the first run\'s result lands once', async () => {
      const before = await stockA()
      const till = await tillSale()
      const pause = paused('moneyStep')
      const order = refund(till)
      const first = post([order])
      try {
        await pause.reached
        const claimed = await commandRow(order.id)
        await ageClaim(order.id)
        const retry = await post([order])
        expect([retry.status, retry.data]).toEqual([409, { code: 'in_progress', id: order.id }])
        const kept = await commandRow(order.id)
        expect(kept).toMatchObject({ status: 'in_progress', claim_token: expect.any(String) })
        expect(kept.claim_token).not.toBe(claimed.claim_token)
      } finally {
        pause.release()
      }
      const response = await first
      expect(response.data.results).toEqual([expect.objectContaining({ id: order.id, status: 'applied', refund: expect.objectContaining({ totalMinor: 1000 }) })])
      expect(await commandRow(order.id)).toMatchObject({ status: 'applied', result: response.data.results[0] })
      expect((await post([order])).data.results).toEqual([{ ...response.data.results[0], status: 'duplicate' }])
      expect(await knexOf()('tally_refund').where({ order_id: till.orderId })).toEqual([expect.objectContaining({ status: 'applied' })])
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ status: 'received' })])
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
      expect(await stockA()).toBe(before)
    })

    it('W2-long-park: a run that parks after a lease takeover still parks the command with its reason; resume finishes it once', async () => {
      const till = await remainderSale()
      const pause = paused('receiveStep')
      const order = oneLine(till, 0)
      const first = post([order])
      try {
        await pause.reached
        // A refund made outside the plugin while the run waits: the check before the money parks it refund_unrecorded.
        const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
        await refundPaymentWorkflow(container).run({ input: { payment_id: till.paymentId, amount: 0.01, note: 'by hand' } })
        await ageClaim(order.id)
        expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
        expect(await commandRow(order.id)).toMatchObject({ status: 'in_progress' })
      } finally {
        pause.release()
      }
      expect((await first).data).toEqual({ code: 'in_progress', id: order.id })
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { orderId: till.orderId,
        clientRefundId: order.payload.clientRefundId, step: 'refund', reason: 'refund_unrecorded' } })
      const hand = await knexOf()('refund').where({ payment_id: till.paymentId }).whereNull('deleted_at').first('id')
      await refundsScript('baseline', till.orderId, hand.id, 'test', 'reason')
      await resolve(order.id, 'resume')
      expect(await commandRow(order.id)).toMatchObject({ status: 'applied', result: { status: 'applied', refund: { totalMinor: 118 } } })
      expect((await medusaRefunds(till.orderId)).map(entry => entry.amount).sort((a, b) => a - b)).toEqual([0.01, 1.18])
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ status: 'received',
        items: [expect.objectContaining({ quantity: 1, received_quantity: 1 })] })])
    })

    it('L1: a run whose lock is lost before the money stops at its next step; the retry pays once', async () => {
      const before = await stockA()
      const till = await tillSale()
      const pause = paused('receiveStep')
      const order = refund(till)
      const first = post([order])
      try {
        await pause.reached
        await terminateHolder(till.orderId)
      } finally {
        pause.release()
      }
      const response = await first
      expect([response.status, response.data]).toEqual([503, { code: 'transient', id: order.id, message: 'Temporary failure, retry later.' }])
      // The zombie's receive landed; its probe at the money step stopped it before the intent.
      const row = await knexOf()('tally_refund').where({ command_id: order.id }).first()
      expect(row).toMatchObject({ status: 'in_progress', received_at: expect.any(Date), money_started_at: null, medusa_refund_id: null })
      expect(await medusaRefunds(till.orderId)).toEqual([])
      expect((await post([order])).data.results).toEqual([expect.objectContaining({ id: order.id, status: 'applied',
        refund: expect.objectContaining({ totalMinor: 1000 }) })])
      expect(await knexOf()('tally_refund').where({ order_id: till.orderId })).toEqual([expect.objectContaining({ id: row.id, status: 'applied' })])
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ id: row.return_id, status: 'received',
        items: [expect.objectContaining({ received_quantity: 1 })] })])
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
      expect(await stockA()).toBe(before)
    })

    it('L1b: a lost-lock run never rewrites its row: its park stops before writing; a retry applies once', async () => {
      const till = await tillSale()
      const pause = paused('receiveStep', true)
      const order = refund(till)
      const first = post([order])
      let row: string | undefined
      try {
        await pause.reached
        ;[row] = await bytes(order.id)
        await terminateHolder(till.orderId)
      } finally {
        pause.release()
      }
      await first
      expect(row).toEqual(expect.stringContaining('"status":"in_progress"'))
      expect((await bytes(order.id))[0]).toBe(row)
      // Only the release touched the command: its own claim, deleted by its token.
      expect(await commandRow(order.id)).toBeUndefined()
      expect((await post([order])).data.results).toEqual([expect.objectContaining({ id: order.id, status: 'applied' })])
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ status: 'received' })])
    })

    it('O4-lock-lost-in-cancel: a run whose lock is lost while cancelling the orphan never begins a second return; the retry applies once', async () => {
      const { before, till, order, knex, row, begun } = await orphaned()
      const stock = await stockA()
      const pause = paused('cancelOrphanReturn')
      const first = post([order])
      try {
        await pause.reached
        await terminateHolder(till.orderId)
      } finally {
        pause.release()
      }
      const response = await first
      expect([response.status, response.data]).toEqual([503, { code: 'transient', id: order.id, message: 'Temporary failure, retry later.' }])
      // The zombie's cancel landed; its probe after the orphan loop stopped it before a second begin.
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ id: begun.id, status: 'canceled' })])
      expect(await medusaRefunds(till.orderId)).toEqual([])
      expect(await stockA()).toBe(stock)
      expect((await post([order])).data.results).toEqual([expect.objectContaining({ id: order.id, status: 'applied' })])
      const recorded = await knex('tally_refund').where({ id: row.id }).first()
      expect(recorded).toMatchObject({ status: 'applied' })
      expect(recorded.return_id).not.toBe(begun.id)
      expect(await returns(till.orderId)).toEqual(expect.arrayContaining([expect.objectContaining({ id: begun.id, status: 'canceled' }),
        expect.objectContaining({ id: recorded.return_id, status: 'received' })]))
      expect(await returns(till.orderId)).toHaveLength(2)
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
      expect(await stockA()).toBe(before)
    })

    it('L2: a run whose lock is lost inside the money step never pays twice: the retry parks money_unconfirmed', async () => {
      // 1.18 of a 3.53 payment, so Medusa's captured-amount cap cannot hide a second refund.
      const till = await remainderSale()
      const pause = paused('moneyStep')
      const order = oneLine(till, 0)
      const first = post([order])
      let retry: Row | undefined, parked: Row | undefined, during: Row[] | undefined
      try {
        await pause.reached
        await terminateHolder(till.orderId)
        await ageClaim(order.id)
        retry = (await post([order])).data
        parked = await commandRow(order.id)
        during = await medusaRefunds(till.orderId)
      } finally {
        pause.release()
      }
      await first
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: till.paymentId, amount: 1.18 }])
      expect(retry).toEqual({ code: 'in_progress', id: order.id })
      expect(parked).toMatchObject({ status: 'needs_admin', needs_admin_reason: { step: 'refund', reason: 'money_unconfirmed',
        message: expect.stringContaining('tally-ledger-resolve resume money-not-sent') } })
      expect(during).toEqual([])
      // The zombie's money moved and is recorded; its probe before applied stopped it.
      expect(await knexOf()('tally_refund').where({ command_id: order.id }).first()).toMatchObject({ status: 'needs_admin',
        medusa_refund_id: expect.any(String) })
      await resolve(order.id, 'resume')
      expect(await commandRow(order.id)).toMatchObject({ status: 'applied', result: { status: 'applied', refund: { totalMinor: 118 } } })
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: till.paymentId, amount: 1.18 }])
    })

    it('L3: a lost-lock run whose money step throws keeps its intent; runs park money_unconfirmed until resume money-not-sent', async () => {
      const before = await stockA()
      const till = await tillSale()
      const pause = paused('moneyStep', true)
      const order = refund(till)
      const first = post([order])
      try {
        await pause.reached
        await terminateHolder(till.orderId)
      } finally {
        pause.release()
      }
      await first
      const row = await knexOf()('tally_refund').where({ command_id: order.id }).first()
      expect(row).toMatchObject({ status: 'in_progress', received_at: expect.any(Date), money_started_at: expect.any(Date), medusa_refund_id: null })
      expect(await medusaRefunds(till.orderId)).toEqual([])
      await ageClaim(order.id)
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      const unconfirmed = { status: 'needs_admin', needs_admin_reason: { refundId: row.id, step: 'refund', reason: 'money_unconfirmed' } }
      expect(await commandRow(order.id)).toMatchObject(unconfirmed)
      await resolve(order.id, 'resume')
      expect(await commandRow(order.id)).toMatchObject(unconfirmed)
      expect(await medusaRefunds(till.orderId)).toEqual([])
      await resolve(order.id, 'resume', 'money-not-sent')
      expect(await commandRow(order.id)).toMatchObject({ status: 'applied', result: { status: 'applied', refund: { totalMinor: 1000 } } })
      expect(await knexOf()('tally_refund').where({ order_id: till.orderId })).toEqual([expect.objectContaining({ id: row.id, status: 'applied' })])
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ id: row.return_id, status: 'received' })])
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
      expect(await stockA()).toBe(before)
    })

    it('L4: a zombie\'s park after the retry applied leaves the row applied', async () => {
      const till = await tillSale()
      const pause = paused('receiveStep', true)
      const order = refund(till)
      const first = post([order])
      let retry: Row | undefined
      try {
        await pause.reached
        await terminateHolder(till.orderId)
        await ageClaim(order.id)
        retry = (await post([order])).data
      } finally {
        pause.release()
      }
      await first
      expect(await knexOf()('tally_refund').where({ order_id: till.orderId })).toEqual([expect.objectContaining({ status: 'applied' })])
      expect(retry?.results).toEqual([expect.objectContaining({ id: order.id, status: 'applied' })])
      expect(await commandRow(order.id)).toMatchObject({ status: 'applied' })
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
    })

    // #576: the sale's payment moved to a provider that would send money; the guard stops before anything is written.
    async function otherProvider(orderId: string) {
      const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'order',
        fields: ['payment_collections.payments.id'], filters: { id: orderId } }) as unknown as Rows
      const ids = (order.payment_collections as Row[]).flatMap(collection => (collection.payments as Row[]).map(payment => payment.id))
      expect(await knexOf()('payment').whereIn('id', ids).update({ provider_id: 'pp_stripe_stripe' })).toBe(ids.length)
    }
    const providerMessage = "This sale's payment uses provider pp_stripe_stripe, not Medusa's manual payment, so a refund through Medusa would go to that provider and could pay twice. Refund it in Medusa Admin, then use tally-ledger-resolve apply <medusaRefundId>. See medusapos/app#576."

    it('G1: a refund of a sale paid through another provider is refused order_state: no row, no return, no refund', async () => {
      const till = await tillSale()
      await otherProvider(till.orderId)
      const order = refund(till)
      expect((await post([order])).data.results).toEqual([{ id: order.id, status: 'rejected', error: { code: 'order_state',
        message: "This sale was paid through pp_stripe_stripe, not the till's manual payment, so the till cannot refund it. Refund it in Medusa Admin.",
        data: { paymentProvider: 'pp_stripe_stripe' } } }])
      expect(await knexOf()('tally_refund').where({ order_id: till.orderId })).toEqual([])
      expect(await returns(till.orderId)).toEqual([])
      expect(await medusaRefunds(till.orderId)).toEqual([])
      expect(['in_progress', 'needs_admin']).not.toContain((await commandRow(order.id))?.status)
    })

    it('G2: resume of a parked refund whose sale moved to another provider re-parks payment_provider, writing nothing', async () => {
      const till = await tillSale()
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as Workflow
      jest.spyOn(workflow, 'receiveStep').mockRejectedValueOnce(new Error('receive probe'))
      const order = refund(till)
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { step: 'receive' } })
      const [row] = await bytes(order.id)
      const before = await returns(till.orderId)
      await otherProvider(till.orderId)
      await expect(resolve(order.id, 'resume')).rejects.toThrow('stays parked (payment_provider)')
      expect((await bytes(order.id))[0]).toBe(row)
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { step: 'payment',
        reason: 'payment_provider', message: providerMessage } })
      expect(await returns(till.orderId)).toEqual(before)
      expect(await medusaRefunds(till.orderId)).toEqual([])
    })

    it('G3: resume money-not-sent of a money_unconfirmed refund on another provider keeps money_started_at and re-parks', async () => {
      const till = await tillSale()
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as Workflow
      jest.spyOn(workflow, 'moneyStep').mockRejectedValueOnce(new Error('money probe'))
      const order = refund(till)
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { reason: 'money_unconfirmed' } })
      const started = (await knexOf()('tally_refund').where({ command_id: order.id }).first()).money_started_at
      expect(started).toEqual(expect.any(Date))
      const [row] = await bytes(order.id)
      await otherProvider(till.orderId)
      await expect(resolve(order.id, 'resume', 'money-not-sent')).rejects.toThrow('stays parked (payment_provider)')
      expect((await knexOf()('tally_refund').where({ command_id: order.id }).first()).money_started_at).toEqual(started)
      expect((await bytes(order.id))[0]).toBe(row)
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { reason: 'payment_provider' } })
      expect(await medusaRefunds(till.orderId)).toEqual([])
    })

    it('U1: a zombie whose request throws while a retry holds the row never cancels the return or deletes the row', async () => {
      const till = await tillSale()
      const zombie = paused('requestReturn', true)
      const order = refund(till)
      const first = post([order])
      let retried: Promise<Awaited<ReturnType<typeof post>>> | undefined
      let held = { release: () => {} } as ReturnType<typeof paused>
      try {
        await zombie.reached
        // The retry waits before its own request, while the begun return still has an active change Medusa can cancel.
        held = paused('requestReturn')
        await terminateHolder(till.orderId)
        await ageClaim(order.id)
        retried = post([order])
        await held.reached
        zombie.release()
        expect((await first).data).toEqual({ code: 'transient', id: order.id, message: 'Temporary failure, retry later.' })
        expect(await knexOf()('tally_refund').where({ command_id: order.id }).first()).toMatchObject({ status: 'in_progress' })
        expect(await knexOf()('return').where({ order_id: till.orderId }).whereNull('deleted_at')).toHaveLength(1)
      } finally {
        zombie.release()
        held.release()
      }
      expect((await retried!).data.results).toEqual([expect.objectContaining({ id: order.id, status: 'applied' })])
      const row = await knexOf()('tally_refund').where({ command_id: order.id }).first()
      expect(row).toMatchObject({ status: 'applied' })
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ id: row.return_id, status: 'received' })])
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
    })

    it('M1: resume money-not-sent refuses an unrecorded Medusa refund and any other park, writing nothing', async () => {
      const till = await remainderSale()
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as Workflow
      jest.spyOn(workflow, 'moneyStep').mockRejectedValueOnce(new Error('money probe'))
      const order = oneLine(till, 0)
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { reason: 'money_unconfirmed' } })
      const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
      await refundPaymentWorkflow(container).run({ input: { payment_id: till.paymentId, amount: 0.01, note: 'by hand' } })
      const unconfirmed = await bytes(order.id)
      await expect(resolve(order.id, 'resume', 'money-not-send')).rejects.toThrow('Usage: medusa exec tally-ledger-resolve.js')
      await expect(resolve(order.id, 'resume', 'money-not-sent')).rejects.toThrow(
        'Medusa shows a refund this row has not recorded; check it and use tally-ledger-resolve apply <medusaRefundId>; nothing written')
      expect(await bytes(order.id)).toEqual(unconfirmed)
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: till.paymentId, amount: 0.01 }])
      // Intent set, no refund recorded, Medusa shows one: plain resume parks refund_unrecorded.
      await resolve(order.id, 'resume')
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { step: 'refund', reason: 'refund_unrecorded' } })
      const unrecorded = await bytes(order.id)
      await expect(resolve(order.id, 'resume', 'money-not-sent')).rejects.toThrow(
        'is not parked money_unconfirmed; resume money-not-sent is only for that. Use tally-ledger-resolve resume, or apply <medusaRefundId>; nothing written')
      expect(await bytes(order.id)).toEqual(unrecorded)
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: till.paymentId, amount: 0.01 }])
    })

    it('W2-takeover-before-row: a run taken over before its row insert parks a released command; the next retry re-parks it and resume finishes once', async () => {
      const till = await remainderSale()
      const pause = paused('receiveStep')
      const order = oneLine(till, 0)
      // The session row held, so the first run waits after it takes the order lock and before it inserts its row.
      const hold = await knexOf().transaction()
      await hold.raw('select id from tally_register_session where id = ? for update', [till.sessionId])
      const first = post([order])
      try {
        await untilHeld(till.orderId, true)
        await ageClaim(order.id)
        expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
        expect(await commandRow(order.id)).toBeUndefined()
        await hold.commit()
        await pause.reached
        // A refund made outside the plugin while the run waits: the check before the money parks it refund_unrecorded.
        const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
        await refundPaymentWorkflow(container).run({ input: { payment_id: till.paymentId, amount: 0.01, note: 'by hand' } })
      } finally {
        if (!hold.isCompleted()) await hold.rollback()
        pause.release()
      }
      expect((await first).data).toEqual({ code: 'in_progress', id: order.id })
      const row = await knexOf()('tally_refund').where({ command_id: order.id }).first()
      expect(row).toMatchObject({ status: 'needs_admin', medusa_refund_id: null })
      expect(await commandRow(order.id)).toBeUndefined()
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { refundId: row.id,
        clientRefundId: order.payload.clientRefundId, step: 'park', reason: 'park_unrecorded' } })
      const hand = await knexOf()('refund').where({ payment_id: till.paymentId }).whereNull('deleted_at').first('id')
      await refundsScript('baseline', till.orderId, hand.id, 'test', 'reason')
      await resolve(order.id, 'resume')
      expect(await commandRow(order.id)).toMatchObject({ status: 'applied', result: { status: 'applied', refund: { totalMinor: 118 } } })
      expect((await medusaRefunds(till.orderId)).map(entry => entry.amount).sort((a, b) => a - b)).toEqual([0.01, 1.18])
    })

    it('W2-crash-between-parks: a row parked before a crash whose command park never landed is re-parked by the retry; resume finishes it once', async () => {
      const { before, till, order, knex, row, begun } = await crashed()
      // The crash came after the row's park and before the command's: the row is needs_admin, its command in_progress and stale.
      await knex('tally_refund').where({ id: row.id }).update({ status: 'needs_admin', return_id: begun.id })
      await knex('tally_command').where({ id: order.id }).update({ claim_token: randomUUID() })
      const stock = await stockA()
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { refundId: row.id,
        step: 'park', reason: 'park_unrecorded' } })
      expect(await knex('tally_refund').where({ order_id: till.orderId })).toEqual([expect.objectContaining({ id: row.id,
        status: 'needs_admin', return_id: begun.id, received_at: null, medusa_refund_id: null })])
      expect(await medusaRefunds(till.orderId)).toEqual([])
      expect(await stockA()).toBe(stock)
      // Not received, so apply refuses; resume runs the missing steps on the same row and return.
      await resolve(order.id, 'resume')
      expect(await commandRow(order.id)).toMatchObject({ status: 'applied', result: { status: 'applied', refund: { totalMinor: 1000 } } })
      expect(await knex('tally_refund').where({ order_id: till.orderId })).toEqual([expect.objectContaining({ id: row.id, status: 'applied' })])
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ id: begun.id, status: 'received' })])
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
      expect(await stockA()).toBe(before)
    })

    it('W2-busy-other: a new command blocked by another refund of the order is released as today, then claims fresh', async () => {
      const till = await remainderSale()
      const pause = paused('moneyStep')
      const holder = oneLine(till, 0), blocked = oneLine(till, 1)
      const first = post([holder])
      try {
        await pause.reached
        expect((await post([blocked])).data).toEqual({ code: 'in_progress', id: blocked.id })
        expect(await commandRow(blocked.id)).toBeUndefined()
        expect(await knexOf()('tally_refund').where({ command_id: blocked.id }).first()).toBeUndefined()
      } finally {
        pause.release()
      }
      expect((await first).data.results).toEqual([expect.objectContaining({ id: holder.id, status: 'applied' })])
      expect((await post([blocked])).data.results).toEqual([expect.objectContaining({ id: blocked.id, status: 'applied',
        refund: expect.objectContaining({ totalMinor: 118 }) })])
      expect((await medusaRefunds(till.orderId)).map(entry => entry.amount)).toEqual([1.18, 1.18])
    })

    // #571: a till refund whose money moved but has no medusa_refund_id is named for tally-ledger-resolve, not sent to Admin.
    const pendingRefusal = async (resumeFirst: boolean) => {
      const till = await remainderSale()
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      const original = workflow.moneyStep
      jest.spyOn(workflow, 'moneyStep').mockImplementationOnce(async (...args) => {
        await original(...args)
        throw new Error('record probe')
      })
      const first = { ...till.full, payload: { ...till.full.payload, lines: [till.full.payload.lines[0]], totalMinor: 118 } }
      expect((await post([first])).data).toEqual({ code: 'in_progress', id: first.id })
      if (resumeFirst) {
        await resolve(first.id, 'resume')
        expect(await commandRow(first.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { reason: 'refund_unrecorded' } })
      }
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('tally_refund').where({ command_id: first.id }).first()).toMatchObject({ medusa_refund_id: null })
      const beforeReturns = await returns(till.orderId)
      // Medusa shows 118 the rows do not record, so the last two lines are refused before the cap (which held the 118 back twice).
      const last = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID(),
        lines: till.full.payload.lines.slice(1), totalMinor: 235 })
      expect((await post([last])).data.results).toEqual([{ id: last.id, status: 'rejected', error: { code: 'order_state',
        message: `An earlier refund of this order moved money but is not recorded yet (command ${first.id}). Finish it with tally-ledger-resolve <command> apply <medusaRefundId>, or resume, then refund again.`,
        data: { reason: 'refund_pending_resolve', outsideMinor: 118, commandIds: [first.id] } } }])
      expect(await knex('tally_refund').where({ command_id: last.id }).first()).toBeUndefined()
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: till.paymentId, amount: 1.18 }])
      expect(await returns(till.orderId)).toEqual(beforeReturns)
    }

    it('N3-double-subtraction: a refund_unrecorded row whose money moved is refused up front, never priced against the cap (#547, #571)', async () => {
      await pendingRefusal(true)
    })

    it('N3-money-unconfirmed: a row parked money_unconfirmed is named for tally-ledger-resolve, not Admin (#571)', async () => {
      await pendingRefusal(false)
    })

    it('N3-not-started: a row parked before its money step, with an Admin refund of the same amount, is refunded_outside_till (#571)', async () => {
      const till = await remainderSale()
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      const spy = jest.spyOn(workflow, 'receiveStep').mockRejectedValueOnce(new Error('receive probe'))
      const first = { ...till.full, payload: { ...till.full.payload, lines: [till.full.payload.lines[0]], totalMinor: 118 } }
      try {
        expect((await post([first])).data).toEqual({ code: 'in_progress', id: first.id })
      } finally {
        spy.mockRestore()
      }
      expect(await commandRow(first.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { step: 'receive' } })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('tally_refund').where({ command_id: first.id }).first()).toMatchObject({ money_started_at: null, medusa_refund_id: null })
      const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
      await refundPaymentWorkflow(container).run({ input: { payment_id: till.paymentId, amount: 1.18, note: 'goodwill in Admin' } })
      // Medusa shows 118 no row records, but the parked row's money never started, so the refusal sends the operator to Admin.
      const last = command('order.refund', { ...till.full.payload, clientRefundId: randomUUID(),
        lines: till.full.payload.lines.slice(1), totalMinor: 235 })
      expect((await post([last])).data.results).toEqual([{ id: last.id, status: 'rejected', error: { code: 'order_state',
        message: outsideMessage, data: { reason: 'refunded_outside_till', outsideMinor: 118 } } }])
      expect(await knex('tally_refund').where({ command_id: last.id }).first()).toBeUndefined()
    })

    it('T-counting-apply: apply in a counting session without a closure records one Medusa refund and counts it', async () => {
      const till = await tillSale(true)
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      jest.spyOn(workflow, 'moneyStep').mockRejectedValueOnce(new Error('money probe'))
      const order = refund(till)
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const row = await knex('tally_refund').where({ command_id: order.id }).first()
      expect(row.received_at).not.toBeNull()
      await applied([command('register.session.transition', { sessionId: till.sessionId, status: 'counting', at: closedAt })])
      const { loadRefundOrder } = require(`${built}/workflows/tally-order-refund/execute`) as typeof import('../../src/workflows/tally-order-refund/execute')
      const paymentId = (await loadRefundOrder(container, till.orderId))!.payment!.id
      const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
      await refundPaymentWorkflow(container).run({ input: { payment_id: paymentId, amount: 10, note: 'by hand' } })
      const medusa = await knex('refund').where({ payment_id: paymentId }).whereNull('deleted_at').first('id')
      await resolve(order.id, 'apply', medusa.id)
      expect(await knex('tally_refund').where({ id: row.id }).first()).toMatchObject({ status: 'applied', medusa_refund_id: medusa.id })
      expect(await commandRow(order.id)).toMatchObject({ status: 'applied', result: { status: 'applied', refund: { totalMinor: 1000 } } })
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId, amount: 10 }])
      expect(await loadSessionFigures(container, till.sessionId)).toEqual({ expected: { cash: 100 }, salesCount: 1, refundsTotalMinor: 1000 })
    })

    it('T-resume-after-filed-closure: resume after a closure is filed, session still open, parks session_closed with no money', async () => {
      const { till, order, row } = await parkedReceived(false)
      await applied([command('register.closure.submit', { closureId: randomUUID(), sessionId: till.sessionId,
        registerId: till.registerId, number: 1, openedAt, closedAt, tillExpected: { cash: 1100 }, counted: { cash: 1100 },
        periodSalesTotalMinor: 1000, periodRefundsTotalMinor: 0, perpetualSalesTotalMinor: 1000,
        perpetualRefundsTotalMinor: 0, unsyncedCount: 0, unsyncedTotalMinor: 0, softwareVersion: '1.0',
        orderIds: [till.sale.payload.clientOrderId], movementIds: [] }, 3)])
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      expect(await knex('tally_register_session').where({ id: row.session_id }).first('status')).toEqual({ status: 'open' })
      const figures = await loadSessionFigures(container, till.sessionId), stock = await stockA()
      await resolve(order.id, 'resume')
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { step: 'session', reason: 'session_closed' } })
      expect(await knex('tally_refund').where({ id: row.id }).first()).toMatchObject({ status: 'needs_admin', medusa_refund_id: null })
      expect(await medusaRefunds(till.orderId)).toEqual([])
      expect(await stockA()).toBe(stock)
      expect(await loadSessionFigures(container, till.sessionId)).toEqual(figures)
    })

    it.each([false, true])('F5-apply: an unreceived row or a different Medusa amount writes nothing (received=%s)', async received => {
      const till = await remainderSale()
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
      const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
      if (received) jest.spyOn(workflow, 'moneyStep').mockRejectedValueOnce(new Error('money probe'))
      else refundAfterPricing(till.paymentId, 0.01)
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

    it.each([['M1-move-default', false], ['M2-move-named', true]] as const)('%s: finishes in an open session without changing the closed one', async (_tag, named) => {
      const { till, order, row } = await parkedReceived()
      const service = container.resolve(Modules.ORDER)
      const { metadata } = await service.retrieveOrder(till.orderId)
      expect(metadata?.tally_payments).toBeDefined()
      const logger = jest.spyOn(container.resolve(ContainerRegistrationKeys.LOGGER), 'info')
      const figures = await loadSessionFigures(container, till.sessionId), stock = await stockA()
      const medusa = await medusaRefunds(till.orderId)
      expect(medusa).toEqual([])
      const next = { sessionId: randomUUID(), registerId: named ? randomUUID() : till.registerId }
      await applied([command('register.session.open', { ...next, openedAt, countedFloatMinor: 2000 })])
      const before = await loadSessionFigures(container, next.sessionId)
      await resolve(order.id, 'move', ...(named ? [next.sessionId] : []))
      expect(await commandRow(order.id)).toMatchObject({ status: 'applied', result: { status: 'applied' } })
      const moved = await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)('tally_refund').where({ id: row.id }).first()
      expect(moved).toMatchObject({ status: 'applied', session_id: next.sessionId, received_at: row.received_at, return_id: row.return_id })
      expect((await service.retrieveOrder(till.orderId)).metadata).toEqual({ ...metadata, tally_refund_moves: [{
        refundId: row.id, commandId: order.id, fromSessionId: till.sessionId, toSessionId: next.sessionId,
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      }] })
      expect(logger).toHaveBeenCalledWith(expect.stringContaining(`moved from session ${till.sessionId} to ${next.sessionId}`))
      if (named) expect(logger).toHaveBeenCalledWith(expect.stringContaining(
        `cash leaves register ${next.registerId}'s drawer, not the sale's register ${till.registerId}`))
      expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: expect.any(String), amount: 10 }])
      expect(await stockA()).toBe(stock)
      expect(await returns(till.orderId)).toEqual([expect.objectContaining({ items: [expect.objectContaining({ received_quantity: 1 })] })])
      expect(await loadSessionFigures(container, till.sessionId)).toEqual(figures)
      expect(await loadSessionFigures(container, next.sessionId)).toEqual({ expected: { cash: before!.expected.cash - 1000 },
        salesCount: 0, refundsTotalMinor: 1000 })
    })

    it.each(['still open', 'counting', 'filed closure', 'no open session', 'money recorded'])('M3-move-refusals: %s', async scenario => {
      const { till, order } = await parkedReceived(scenario !== 'still open')
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const next = { sessionId: randomUUID(), registerId: randomUUID() }
      if (scenario !== 'no open session') {
        await applied([command('register.session.open', { ...next, openedAt, countedFloatMinor: 2000 })])
      }
      if (scenario === 'counting') await applied([command('register.session.transition', { sessionId: next.sessionId, status: 'counting', at: closedAt })])
      if (scenario === 'filed closure') {
        await applied([command('register.closure.submit', { closureId: randomUUID(), ...next, number: 1, openedAt, closedAt,
          tillExpected: { cash: 2000 }, counted: { cash: 2000 }, periodSalesTotalMinor: 0, periodRefundsTotalMinor: 0,
          perpetualSalesTotalMinor: 0, perpetualRefundsTotalMinor: 0, unsyncedCount: 0, unsyncedTotalMinor: 0,
          softwareVersion: '1.0', orderIds: [], movementIds: [] }, 3)])
      }
      if (scenario === 'money recorded') await knex('tally_refund').where({ command_id: order.id }).update({ medusa_refund_id: 'ref_recorded' })
      const row = await knex('tally_refund').where({ command_id: order.id }).first(), parked = await commandRow(order.id)
      const refusal = resolve(order.id, 'move', ...(scenario === 'no open session' ? [] : [next.sessionId]))
      await expect(refusal).rejects.toThrow('nothing written')
      if (scenario === 'still open') await expect(refusal).rejects.toThrow('use resume')
      if (scenario === 'counting') await expect(refusal).rejects.toThrow('status counting')
      if (scenario === 'filed closure') await expect(refusal).rejects.toThrow('status open')
      if (scenario === 'no open session') await expect(refusal).rejects.toThrow(`Register ${till.registerId} has no open session`)
      expect(await knex('tally_refund').where({ id: row.id }).first()).toEqual(row)
      expect(await commandRow(order.id)).toEqual(parked)
      expect((await container.resolve(Modules.ORDER).retrieveOrder(till.orderId)).metadata).not.toHaveProperty('tally_refund_moves')
    })

    it.each(['B1-baseline', 'B4-baseline-fails-closed'])('%s: a hand refund baseline preserves metadata and is required on resume', async tag => {
      const till = await remainderSale()
      refundAfterPricing(till.paymentId, 0.01)
      const order = { ...till.full, payload: { ...till.full.payload, lines: [till.full.payload.lines[0]], totalMinor: 118 } }
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      expect(await commandRow(order.id)).toMatchObject({ needs_admin_reason: { reason: 'refund_unrecorded' } })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const hand = await knex('refund').where({ payment_id: till.paymentId }).whereNull('deleted_at').first('id')
      const service = container.resolve(Modules.ORDER)
      const { metadata } = await service.retrieveOrder(till.orderId)
      expect(metadata?.tally_payments).toBeDefined()
      await refundsScript('baseline', till.orderId, hand.id, 'test', 'reason')
      expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin' })
      expect((await service.retrieveOrder(till.orderId)).metadata).toEqual({ ...metadata, tally_refund_baselines: [{
        refundId: hand.id, amountMinor: 1, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/), reason: 'test reason',
      }] })
      if (tag === 'B4-baseline-fails-closed') {
        // The service merges metadata; undefined removes this key when the JSON is stored.
        await service.updateOrders(till.orderId, { metadata: { ...metadata, tally_refund_baselines: undefined } })
        expect((await service.retrieveOrder(till.orderId)).metadata).toEqual(metadata)
        expect((await service.retrieveOrder(till.orderId)).metadata).not.toHaveProperty('tally_refund_baselines')
        await resolve(order.id, 'resume')
        expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { reason: 'refund_unrecorded' } })
        expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId: till.paymentId, amount: 0.01 }])
        return
      }
      await resolve(order.id, 'resume')
      expect(await commandRow(order.id)).toMatchObject({ status: 'applied' })
      expect((await medusaRefunds(till.orderId)).map(entry => entry.amount).sort((a, b) => a - b)).toEqual([0.01, 1.18])
    })

    it.each(['another payment', 'recorded', 'already baselined', 'amount guard'])('B2-baseline-refusals: %s', async scenario => {
      const till = await remainderSale()
      const order = { ...till.full, payload: { ...till.full.payload, lines: [till.full.payload.lines[0]], totalMinor: 118 } }
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      let paymentId = till.paymentId
      if (scenario === 'another payment') paymentId = (await remainderSale()).paymentId
      if (scenario === 'recorded') await applied([order])
      else if (scenario === 'amount guard') {
        const workflow = require(`${built}/workflows/tally-order-refund/workflow`) as typeof import('../../src/workflows/tally-order-refund/workflow')
        const original = workflow.moneyStep
        jest.spyOn(workflow, 'moneyStep').mockImplementationOnce(async (...args) => {
          await original(...args)
          throw new Error('record probe')
        })
        expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      } else {
        const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
        await refundPaymentWorkflow(container).run({ input: { payment_id: paymentId, amount: 0.01, note: 'by hand' } })
      }
      const medusa = await knex('refund').where({ payment_id: paymentId }).whereNull('deleted_at').first('id')
      if (scenario === 'already baselined') await refundsScript('baseline', till.orderId, medusa.id, 'test reason')
      const service = container.resolve(Modules.ORDER)
      const { metadata } = await service.retrieveOrder(till.orderId)
      const refusal = refundsScript('baseline', till.orderId, medusa.id, 'test reason')
      await expect(refusal).rejects.toThrow('nothing written')
      if (scenario === 'recorded') await expect(refusal).rejects.toThrow('own money')
      if (scenario === 'amount guard') {
        const row = await knex('tally_refund').where({ command_id: order.id }).first()
        await expect(refusal).rejects.toThrow(row.id)
        await expect(refusal).rejects.toThrow(`tally-ledger-resolve.js ${order.id} apply ${medusa.id}`)
        await expect(refusal).rejects.toThrow('or hand-made if an admin made it')
        await resolve(order.id, 'resume')
        expect(await commandRow(order.id)).toMatchObject({ status: 'needs_admin', needs_admin_reason: { reason: 'refund_unrecorded' } })
        expect(await medusaRefunds(till.orderId)).toEqual([{ paymentId, amount: 1.18 }])
      }
      expect((await service.retrieveOrder(till.orderId)).metadata).toEqual(metadata)
    })

    it('B3-hand-made: only the explicit flag baselines a hand refund equal to the parked row', async () => {
      const till = await remainderSale()
      refundAfterPricing(till.paymentId, 1.18)
      const order = { ...till.full, payload: { ...till.full.payload, lines: [till.full.payload.lines[0]], totalMinor: 118 } }
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      expect(await commandRow(order.id)).toMatchObject({ needs_admin_reason: { reason: 'refund_unrecorded' } })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const hand = await knex('refund').where({ payment_id: till.paymentId }).whereNull('deleted_at').first('id')
      await expect(refundsScript('baseline', till.orderId, hand.id, 'test reason')).rejects.toThrow('nothing written')
      await refundsScript('baseline', till.orderId, hand.id, 'hand-made', 'test', 'reason')
      expect((await container.resolve(Modules.ORDER).retrieveOrder(till.orderId)).metadata?.tally_refund_baselines).toEqual([{
        refundId: hand.id, amountMinor: 118, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/), reason: 'test reason',
      }])
      await resolve(order.id, 'resume')
      expect(await commandRow(order.id)).toMatchObject({ status: 'applied' })
      expect((await medusaRefunds(till.orderId)).map(entry => entry.amount)).toEqual([1.18, 1.18])
    })

    it.each([false, true])('B5-baseline-needs-reason: hand-made flag %s', async handMade => {
      const till = await remainderSale()
      const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
      await refundPaymentWorkflow(container).run({ input: { payment_id: till.paymentId, amount: 0.01, note: 'by hand' } })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const hand = await knex('refund').where({ payment_id: till.paymentId }).whereNull('deleted_at').first('id')
      await expect(refundsScript('baseline', till.orderId, hand.id, ...(handMade ? ['hand-made'] : []))).rejects.toThrow('nothing written')
      expect((await container.resolve(Modules.ORDER).retrieveOrder(till.orderId)).metadata).not.toHaveProperty('tally_refund_baselines')
    })

    it('B6-baseline-refuses-dashed-word: --hand-made is not swallowed into the reason', async () => {
      const till = await remainderSale()
      const { refundPaymentWorkflow } = require('@medusajs/medusa/core-flows')
      await refundPaymentWorkflow(container).run({ input: { payment_id: till.paymentId, amount: 0.01, note: 'by hand' } })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const hand = await knex('refund').where({ payment_id: till.paymentId }).whereNull('deleted_at').first('id')
      await expect(refundsScript('baseline', till.orderId, hand.id, '--hand-made', 'test', 'reason')).rejects.toThrow('nothing written')
      expect((await container.resolve(Modules.ORDER).retrieveOrder(till.orderId)).metadata).not.toHaveProperty('tally_refund_baselines')
    })

    it('B7-baseline-numeric-word: a number from yargs joins the reason', async () => {
      const till = await remainderSale()
      refundAfterPricing(till.paymentId, 0.01)
      const order = { ...till.full, payload: { ...till.full.payload, lines: [till.full.payload.lines[0]], totalMinor: 118 } }
      expect((await post([order])).data).toEqual({ code: 'in_progress', id: order.id })
      const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      const hand = await knex('refund').where({ payment_id: till.paymentId }).whereNull('deleted_at').first('id')
      await refundsScript('baseline', till.orderId, hand.id, 'ticket', 1234)
      const { metadata } = await container.resolve(Modules.ORDER).retrieveOrder(till.orderId)
      expect((metadata?.tally_refund_baselines as { reason: string }[])[0].reason).toBe('ticket 1234')
    })

    it('L1-list: parked refunds with order, session, money and reason, then moved refunds with current status', async () => {
      const logger = jest.spyOn(container.resolve(ContainerRegistrationKeys.LOGGER), 'info')
      await refundsScript('list')
      expect(logger).toHaveBeenCalledWith('no parked refunds')
      const { till, order, row } = await parkedReceived()
      const other = await tillSale(true)
      await applied([refund(other)])
      const { listParkedRefunds } = require(`${built}/workflows/tally-order-refund/admin`) as typeof import('../../src/workflows/tally-order-refund/admin')
      const { display_id } = await container.resolve(Modules.ORDER).retrieveOrder(till.orderId)
      const { parked: rows, moved } = await listParkedRefunds(container)
      expect(moved).toEqual([])
      expect(rows).toEqual([expect.objectContaining({ id: row.id, command_id: order.id, order_id: till.orderId, display_id,
        session_id: till.sessionId, session_status: 'closed', closure_filed: true, currency_code: 'eur',
        step: 'session', reason: 'session_closed', updated_at: row.updated_at })])
      expect(Number(rows[0].total_minor)).toBe(1000)
      logger.mockClear()
      await refundsScript('list')
      expect(logger).toHaveBeenCalledTimes(2)
      expect(logger).toHaveBeenCalledWith(`refund ${row.id}, command ${order.id}, order ${till.orderId} (#${display_id}), session ${till.sessionId} (closed, closure filed: true), 10.00 eur, step session, reason session_closed, updated_at ${row.updated_at.toISOString()}`)
      const next = { sessionId: randomUUID(), registerId: till.registerId }
      await applied([command('register.session.open', { ...next, openedAt, countedFloatMinor: 2000 })])
      await resolve(order.id, 'move')
      const listed = await listParkedRefunds(container)
      expect(listed.parked).toEqual([])
      expect(listed.moved).toEqual([{ id: row.id, command_id: order.id, order_id: till.orderId, display_id,
        from_session_id: till.sessionId, to_session_id: next.sessionId, at: expect.any(String), status: 'applied' }])
      logger.mockClear()
      await refundsScript('list')
      expect(logger.mock.calls).toEqual([['no parked refunds'], ['moved refunds'], [
        `refund ${row.id}, command ${order.id}, order ${till.orderId} (#${display_id}), from session ${till.sessionId}, to session ${next.sessionId}, at ${listed.moved[0].at}, status applied`,
      ]])
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

    describe("C544: a closure stores the server's period refunds and keeps the till's when they differ", () => {
      const knex = () => container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
      type Till = Awaited<ReturnType<typeof tillSale>>
      // The register's refunds counter starts at 5000, and the till's perpetual refunds are 5000 plus its period figure.
      const submit = (till: Till, refundsMinor: number, cash = 1100, extra: Record<string, unknown> = {}, version = 3) =>
        command('register.closure.submit', { closureId: randomUUID(), sessionId: till.sessionId, registerId: till.registerId,
          number: 1, openedAt, closedAt, tillExpected: { cash }, counted: { cash }, periodSalesTotalMinor: 1000,
          periodRefundsTotalMinor: refundsMinor, perpetualSalesTotalMinor: 1000, perpetualRefundsTotalMinor: 5000 + refundsMinor,
          unsyncedCount: 0, unsyncedTotalMinor: 0, softwareVersion: '1.0', orderIds: [till.sale.payload.clientOrderId],
          movementIds: [], ...extra }, version)
      const closureRow = (id: string) => knex()('tally_register_closure').where({ id }).first()
      const registerRow = (id: string) => knex()('tally_register').where({ id }).first()
      async function close(till: Till, submission: ReturnType<typeof submit>, cash = 1100) {
        const [, { register }] = await applied([command('register.session.transition', { sessionId: till.sessionId,
          status: 'closed', at: closedAt, counted: { cash } }), submission])
        const row = await closureRow(submission.payload.closureId)
        return { register, row, stored: { period: Number(row.period_refunds_total_minor), perpetual: Number(row.perpetual_refunds_total_minor),
          till: row.till_period_refunds_total_minor === null ? null : Number(row.till_period_refunds_total_minor),
          register: Number((await registerRow(till.registerId)).perpetual_refunds_total_minor) } }
      }
      async function sale(registerId?: string) {
        const till = await tillSale(true, undefined, registerId)
        if (!registerId) expect(await knex()('tally_register').where({ id: till.registerId }).update({ perpetual_refunds_total_minor: 5000 })).toBe(1)
        return till
      }
      async function refunded(registerId?: string) {
        const till = await sale(registerId)
        expect((await post([refund(till)])).data.results[0]).toMatchObject({ status: 'applied', refund: { byMethod: { cash: 1000 } } })
        return till
      }

      it.each([0, 1000])('C544-equal: till and server both %d: stored as sent, no till column, no refunds', async minor => {
        const till = minor ? await refunded() : await sale()
        const { register, stored } = await close(till, submit(till, minor, 1100 - minor), 1100 - minor)
        expect(stored).toEqual({ period: minor, perpetual: 5000 + minor, till: null, register: 5000 + minor })
        expect(register.closure).not.toHaveProperty('refunds')
      })

      it('C544-till-over: till 1000, server 0: stores 0, keeps 1000, shifts perpetual down, warns', async () => {
        const warn = jest.spyOn(container.resolve(ContainerRegistrationKeys.LOGGER), 'warn')
        const till = await sale()
        const { register, stored } = await close(till, submit(till, 1000))
        expect(stored).toEqual({ period: 0, perpetual: 5000, till: 1000, register: 5000 })
        expect(register.closure.refunds).toEqual({ tillMinor: 1000, serverMinor: 0 })
        expect(register.counters.perpetualRefundsTotalMinor).toBe(5000)
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`${till.sessionId}.*refunds 1000 .*server's 0`)))
      })

      it('C544-till-under: a refund applied in the session, till sends 0: stores 1000, keeps 0, shifts perpetual up', async () => {
        const till = await refunded()
        const { register, stored } = await close(till, submit(till, 0, 100), 100)
        expect(stored).toEqual({ period: 1000, perpetual: 6000, till: 0, register: 6000 })
        expect(register.closure.refunds).toEqual({ tillMinor: 0, serverMinor: 1000 })
      })

      it.each([
        ['C544-unsynced', 3, (till: Till) => ({ unsyncedCount: 1, unsyncedTotalMinor: 500, orderIds: [till.sale.payload.clientOrderId, randomUUID()] })],
        ['C544-v2', 2, () => ({})],
        ['C544-unsynced-base', 3, (till: Till) => ({ unsyncedCount: 1, unsyncedTotalMinor: 500, perpetualRefundsTotalMinor: 7000,
          orderIds: [till.sale.payload.clientOrderId, randomUUID()] })],
      ] as const)("%s: the till's figures are stored as sent", async (_tag, version, extra) => {
        const till = await sale()
        const { register, stored } = await close(till, submit(till, 1000, 1100, extra(till), version))
        const perpetual = 'perpetualRefundsTotalMinor' in extra(till) ? 7000 : 6000
        expect(stored).toEqual({ period: 1000, perpetual, till: null, register: perpetual })
        expect(register.closure).not.toHaveProperty('refunds')
      })

      it('C544-unsynced-claim: an unsynced claim the server disproves stores the server\'s figure, as till-over', async () => {
        const till = await sale()
        const { register, stored } = await close(till, submit(till, 1000, 1100, { unsyncedCount: 1, unsyncedTotalMinor: 500 }))
        expect(stored).toEqual({ period: 0, perpetual: 5000, till: 1000, register: 5000 })
        expect(register.closure.refunds).toEqual({ tillMinor: 1000, serverMinor: 0 })
      })

      it('C544-chain: after a till-over closure the till keeps its high base, and the next closure stays on the counter', async () => {
        const first = await sale()
        const one = await close(first, submit(first, 1000))
        expect(one.stored).toEqual({ period: 0, perpetual: 5000, till: 1000, register: 5000 })
        const second = await sale(first.registerId)
        const two = await close(second, submit(second, 0, 1100, { number: 2, perpetualRefundsTotalMinor: 6000 }))
        expect(two.stored).toEqual({ period: 0, perpetual: 5000, till: null, register: 5000 })
        expect(two.stored.perpetual - one.stored.perpetual).toBe(two.stored.period)
      })

      it('C544-race: two closures of one register queued on its lock each store the counter at insert plus their period', async () => {
        const transition = (till: Till) => applied([command('register.session.transition', { sessionId: till.sessionId,
          status: 'closed', at: closedAt, counted: { cash: 100 } })])
        const first = await refunded()
        await transition(first)
        const second = await refunded(first.registerId)
        await transition(second)
        const waiting = async (n: number) => {
          for (let i = 0; i < 200; i++) {
            const { rows: [{ count }] } = await knex().raw(`select count(*)::int as count from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'`)
            if (count >= n) return
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          throw new Error(`fewer than ${n} commands wait on the register lock`)
        }
        // Hold the register row so both closures pass their gates first and then queue on its lock in order.
        const hold = await knex().transaction()
        const submissions = [submit(first, 1000, 100), submit(second, 1000, 100, { number: 2, perpetualRefundsTotalMinor: 7000 })]
        let responses: Promise<Awaited<ReturnType<typeof post>>>[]
        try {
          await hold('tally_register').where({ id: first.registerId }).forUpdate().first()
          responses = [post([submissions[0]])]
          await waiting(1)
          responses.push(post([submissions[1]]))
          await waiting(2)
        } finally { await hold.commit() }
        expect((await Promise.all(responses)).map(response => response.data.results[0].status)).toEqual(['applied', 'applied'])
        const rows = await Promise.all(submissions.map(submission => closureRow(submission.payload.closureId)))
        expect(rows.map(row => [Number(row.period_refunds_total_minor), Number(row.perpetual_refunds_total_minor)]))
          .toEqual([[1000, 6000], [1000, 7000]])
        expect(Number((await registerRow(first.registerId)).perpetual_refunds_total_minor)).toBe(7000)
      })

      it.each([
        ['C544-resend', false, 1000, 1100, { period: 0, perpetual: 5000, till: 1000, register: 5000 }],
        ['C544-resend-under', true, 0, 100, { period: 1000, perpetual: 6000, till: 0, register: 6000 }],
      ] as const)('%s: a resend returns the same refunds and changes neither the closure nor the register', async (_tag, refund, minor, cash, expected) => {
        const till = refund ? await refunded() : await sale()
        const submission = submit(till, minor, cash)
        const { register, row, stored } = await close(till, submission, cash)
        expect(stored).toEqual(expected)
        const counters = await registerRow(till.registerId)
        const [resent] = await applied([{ ...submission, id: randomUUID() }])
        expect(resent.register.closure).toEqual(register.closure)
        expect((await post([submission])).data.results[0]).toMatchObject({ status: 'duplicate', register: { closure: register.closure } })
        expect(await closureRow(submission.payload.closureId)).toEqual(row)
        expect(await registerRow(till.registerId)).toEqual(counters)
      })

      it("C544-history: closure history reads both figures, and leaves the till's out when it is null", async () => {
        const over = await sale(), equal = await sale()
        await close(over, submit(over, 1000))
        await close(equal, submit(equal, 0))
        const read = async (till: Till) => (await api.get(`/tally/v1/registers/${till.registerId}/closures`, { headers })).data.closures[0]
        expect(await read(over)).toMatchObject({ periodRefundsTotalMinor: 0, tillPeriodRefundsTotalMinor: 1000 })
        const plain = await read(equal)
        expect(plain.periodRefundsTotalMinor).toBe(0)
        expect(plain).not.toHaveProperty('tillPeriodRefundsTotalMinor')
      })

      it('C544-migration: down then up on a database holding a closure keeps the row and brings the column back null', async () => {
        const till = await sale()
        const submission = submit(till, 0)
        await close(till, submission)
        const before = await closureRow(submission.payload.closureId)
        const migration = new Migration20261124120000(undefined as never, undefined as never)
        const columns = async () => Object.keys(await knex()('tally_register_closure').columnInfo())
        const run = async (step: 'up' | 'down') => {
          migration.reset()
          await migration[step]()
          for (const sql of migration.getQueries()) await knex().raw(sql as string)
        }
        try {
          await run('down')
          expect(await columns()).not.toContain('till_period_refunds_total_minor')
          const { till_period_refunds_total_minor: _dropped, ...rest } = before
          expect(await closureRow(submission.payload.closureId)).toEqual(rest)
          await run('up')
          expect(await columns()).toContain('till_period_refunds_total_minor')
          expect(await closureRow(submission.payload.closureId)).toEqual({ ...before, till_period_refunds_total_minor: null })
        } finally {
          if (!(await columns()).includes('till_period_refunds_total_minor')) await run('up')
        }
      })
    })
  },
})
