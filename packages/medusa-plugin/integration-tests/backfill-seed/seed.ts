import { randomUUID } from 'node:crypto'
import type { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import {
  convertDraftOrderWorkflow, createOrderPaymentCollectionWorkflow, createOrderWorkflow, markPaymentCollectionAsPaid,
  type CreateOrderWorkflowInput,
} from '@medusajs/medusa/core-flows'
import type TallyLedgerModuleService from '../../src/modules/tally-ledger/service'
import { seed } from '../http/seed'

// npx medusa exec <plugin>/integration-tests/backfill-seed/seed.ts, on a fresh database with plugin-app's config (run.sh does this).
// Builds the backfill's scenarios through the built plugin's own code paths, as the integration tests do.
const built = '../../.medusa/server/src'
const { processBatch } = require(`${built}/api/tally/v1/commands/process`) as typeof import('../../src/api/tally/v1/commands/process')
const { planOrderCreate } = require(`${built}/workflows/tally-order-create/plan`) as typeof import('../../src/workflows/tally-order-create/plan')
const { TALLY_LEDGER_MODULE } = require(`${built}/modules/tally-ledger`) as typeof import('../../src/modules/tally-ledger')
const resolveScript = require(`${built}/scripts/tally-ledger-resolve`) as typeof import('../../src/scripts/tally-ledger-resolve')
type Batch = Parameters<typeof processBatch>[1]
type Sale = { id: string; payload: { clientOrderId: string; totalMinor: number } }

export default async function backfillSeed({ container }: ExecArgs) {
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const options = container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE).getPluginOptions()
  const data = await seed(container)
  const envelope = (type: string, payload: object, version = 1) => ({
    id: randomUUID(), type, version, payload, createdAt: new Date().toISOString(), deviceId: 'backfill-seed', attempt: 1 })
  // A cash sale of 10.00; with a session it is a version 3 session sale.
  const sale = (sessionId?: string) => envelope('order.create', {
    clientOrderId: randomUUID(), createdAt: new Date().toISOString(), currency: 'EUR', pricesIncludeTax: true,
    ...sessionId ? { sessionId } : {},
    lines: [{ clientLineId: randomUUID(), variantId: data.variantB, quantity: 1, unitPriceMinor: 1000 }],
    subtotalMinor: 840, taxMinor: 160, totalMinor: 1000,
    payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: 1000 }],
  }, sessionId ? 3 : 1) as ReturnType<typeof envelope> & Sale
  // Sends a batch as POST /tally/v1/commands does and fails unless the statuses are the expected ones.
  async function send(expected: string, ...commands: object[]) {
    const outcome = await processBatch(container, commands as Batch, options)
    const got = outcome.status === 200 ? outcome.body.results.map(result => result.status).join(',') : String(outcome.status)
    if (got !== expected) throw new Error(`backfill-seed: expected ${expected}, got ${got}: ${JSON.stringify(outcome.body)}`)
    return outcome
  }
  async function open() {
    const session = { sessionId: randomUUID(), registerId: randomUUID(), openedAt: new Date().toISOString() }
    await send('applied', envelope('register.session.open', { ...session, countedFloatMinor: 100 }))
    return session
  }
  // Closes a session with a closure that lists these clientOrderIds.
  async function close(session: Awaited<ReturnType<typeof open>>, orderIds: string[]) {
    const at = new Date().toISOString()
    await send('applied,applied', envelope('register.session.transition', { sessionId: session.sessionId, status: 'closed', at, counted: { cash: 100 } }),
      envelope('register.closure.submit', { closureId: randomUUID(), ...session, number: 1, closedAt: at, tillExpected: { cash: 100 },
        counted: { cash: 100 }, periodSalesTotalMinor: 0, periodRefundsTotalMinor: 0, perpetualSalesTotalMinor: 0,
        perpetualRefundsTotalMinor: 0, unsyncedCount: 0, unsyncedTotalMinor: 0, softwareVersion: '1.0', orderIds, movementIds: [] }))
  }
  // commands.spec's parkLiveOrder: a written and paid order whose payment an admin then marks partially captured, so the resume parks it.
  async function park(command: Sale) {
    const planned = planOrderCreate(command.payload as Parameters<typeof planOrderCreate>[0], {
      customer: null, commandId: command.id, salesChannelId: data.channelId,
      region: { id: data.regionId, currency_code: 'eur', country_codes: ['de', 'dk'] },
      location: { id: data.berlinId, address: { address_1: 'Alexanderplatz 1', city: 'Berlin', country_code: 'de', postal_code: '10178' } },
      variants: { [data.variantB]: { id: data.variantB } },
    })
    if (!planned.ok) throw new Error('backfill-seed: expected a plan')
    const { result: draft } = await createOrderWorkflow(container).run({ input: planned.plan.draftOrder as unknown as CreateOrderWorkflowInput })
    await convertDraftOrderWorkflow(container).run({ input: { id: draft.id } })
    const { result: [collection] } = await createOrderPaymentCollectionWorkflow(container).run({
      input: { order_id: draft.id, amount: command.payload.totalMinor / 100 } })
    await markPaymentCollectionAsPaid(container).run({ input: { order_id: draft.id, payment_collection_id: collection.id } })
    await container.resolve(Modules.PAYMENT).updatePaymentCollections(collection.id, { status: 'partially_captured' })
    await send('409', command)
    const row = await knex('tally_command').where({ id: command.id }).first('status')
    if (row?.status !== 'needs_admin') throw new Error(`backfill-seed: command ${command.id} is ${row?.status}, not needs_admin`)
    return draft.id as string
  }
  // commands.spec's rejectUnmarked: rejected by tally-ledger-resolve, then the marker removed, as a reject made before #121 left it.
  async function rejectUnmarked(command: Sale) {
    const orderId = await park(command)
    await resolveScript.default({ container, args: [command.id, 'reject'] })
    // The order module merges metadata; an empty string deletes the key.
    await container.resolve(Modules.ORDER).updateOrders(orderId, { metadata: { tally_rejected: '' } })
    const order = await knex('order').where({ id: orderId }).first('status', knex.raw("metadata->>'tally_rejected' as rejected"))
    if (order.status !== 'canceled' || order.rejected !== null) throw new Error(`backfill-seed: order ${orderId} is not canceled and unmarked`)
    return orderId
  }

  // 1. Open session S1: a rejected, unmarked session sale, and an ordinary applied sale that stays counted.
  const s1 = await open()
  const s1Rejected = await rejectUnmarked(sale(s1.sessionId))
  const s1Sale = await send('applied', sale(s1.sessionId))
  // 2. Closed session S2, the #121 review case: c0 applied then canceled by hand, c1 of the same sale parked, rejected and unmarked.
  const s2 = await open()
  const c0 = sale(s2.sessionId)
  const c0Order = (await send('applied', c0)).body as { results: { serverRefs?: { orderId?: string } }[] }
  const handCanceled = c0Order.results[0].serverRefs!.orderId!
  await knex('order').where({ id: handCanceled }).update({ status: 'canceled' })
  const c1 = { ...c0, id: randomUUID() }
  const c1Rejected = await rejectUnmarked(c1)
  await close(s2, [c0.payload.clientOrderId])
  // 3. A TALLY_ADMIN_REJECTED ledger row that names no order, as the no-orderId test makes it.
  const unnamed = sale()
  await rejectUnmarked(unnamed)
  await knex('tally_command').where({ id: unnamed.id }).update({ result: knex.raw("result #- '{error,data,orderId}'") })

  logger.info(`backfill-seed: S1 ${s1.sessionId} (open): rejected order ${s1Rejected}, counted command ${JSON.stringify(s1Sale.body)}`)
  logger.info(`backfill-seed: S2 ${s2.sessionId} (closed): hand-canceled order ${handCanceled}, rejected order ${c1Rejected} (command ${c1.id})`)
  logger.info(`backfill-seed: no-orderId command ${unnamed.id}`)
}
