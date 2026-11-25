import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import {
  beginReceiveReturnWorkflow, beginReturnOrderWorkflow, cancelReturnReceiveWorkflow, cancelReturnRequestWorkflow, cancelReturnWorkflow,
  confirmReturnReceiveWorkflow, confirmReturnRequestWorkflow, dismissItemReturnRequestWorkflow,
  receiveItemReturnRequestWorkflow, refundPaymentWorkflow, requestItemReturnWorkflow,
} from '@medusajs/medusa/core-flows'

// The Medusa steps of a till refund (ADR 0026 decision 2). Each is its own set of Medusa workflows; execute.ts records
// each one's outcome on the tally_refund row before the next starts, so a retry runs only the missing ones.

export interface RefundStepLine { orderLineId: string; quantity: number; restock: boolean }

/**
 * Step 1a: begin a return at the sale's location, tagged with the refund row's id; returns its id, which execute.ts records
 * before anything else.
 */
export async function beginReturn(container: MedusaContainer, input: { orderId: string; locationId: string; actorId?: string
  note: string; refundRowId: string }): Promise<string> {
  const { result: change } = await beginReturnOrderWorkflow(container).run({ input: {
    order_id: input.orderId, location_id: input.locationId, created_by: input.actorId, internal_note: input.note,
    metadata: { tally_refund_id: input.refundRowId },
  } })
  return change.return_id as string
}

/**
 * The open return this refund row began, if a run died before recording it; a return with any other status or tag is not
 * ours. It is reused only while its active request change is empty: with no active change (a death inside the begin) the
 * request cannot run on it, and a request holding actions (an Admin's items) would confirm someone else's lines.
 */
export async function findOwnOpenReturn(container: MedusaContainer, input: { orderId: string; refundRowId: string }): Promise<string | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: 'return', fields: ['id', 'status', 'metadata'], filters: { order_id: input.orderId } })
  const candidate = data.find(found => found.status === 'open' && found.metadata?.tally_refund_id === input.refundRowId)
  if (!candidate) return null
  const { data: changes } = await query.graph({ entity: 'order_change', fields: ['id', 'change_type', 'actions.id'],
    filters: { return_id: candidate.id, status: ['pending', 'requested'] } })
  return changes.some(change => change.change_type === 'return_request' && !change.actions?.length) ? candidate.id : null
}

/**
 * This row's orphans: open returns it tagged with no items and no active order change, left by a run that died inside the
 * begin. findOwnOpenReturn cannot reuse them, so a retry cancels them before it begins its own; any other shape is not ours.
 */
export async function findOrphanReturns(container: MedusaContainer, input: { orderId: string; refundRowId: string }): Promise<string[]> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({ entity: 'return', fields: ['id', 'status', 'metadata', 'items.id'], filters: { order_id: input.orderId } })
  const orphans: string[] = []
  for (const found of data.filter(found => found.status === 'open' && found.metadata?.tally_refund_id === input.refundRowId
    && !found.items?.length)) {
    const { data: changes } = await query.graph({ entity: 'order_change', fields: ['id'],
      filters: { return_id: found.id, status: ['pending', 'requested'] } })
    if (!changes.length) orphans.push(found.id)
  }
  return orphans
}

/** Cancels an orphan return (see findOrphanReturns) through Medusa's cancel-return workflow. */
export async function cancelOrphanReturn(container: MedusaContainer, input: { returnId: string; actorId?: string }): Promise<void> {
  await cancelReturnWorkflow(container).run({ input: { return_id: input.returnId, canceled_by: input.actorId } })
}

/**
 * Step 1b: request the lines on the recorded return and confirm the request. It reuses the return: one already confirmed
 * is left as it is, and lines an earlier attempt requested are not requested again.
 */
export async function requestReturn(container: MedusaContainer, input: { returnId: string; lines: RefundStepLine[]
  actorId?: string }): Promise<void> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: [found] } = await query.graph({ entity: 'return', fields: ['id', 'status'], filters: { id: input.returnId } })
  if (!found || found.status === 'canceled') throw new Error(`Return ${input.returnId} is ${found ? 'canceled' : 'missing'}`)
  if (found.status !== 'open') return
  const { data: changes } = await query.graph({ entity: 'order_change', fields: ['id', 'change_type', 'actions.id'],
    filters: { return_id: input.returnId, status: ['pending', 'requested'] } })
  const request = changes.find(change => change.change_type === 'return_request')
  if (!request?.actions?.length) {
    await requestItemReturnWorkflow(container).run({ input: { return_id: input.returnId,
      items: input.lines.map(line => ({ id: line.orderLineId, quantity: line.quantity })) } })
  }
  await confirmReturnRequestWorkflow(container).run({ input: { return_id: input.returnId, confirmed_by: input.actorId } })
}

/** Cancels a begun return whose request failed, so nothing of the refund stays in Medusa. */
export async function cancelReturn(container: MedusaContainer, returnId: string): Promise<void> {
  await cancelReturnRequestWorkflow(container).run({ input: { return_id: returnId } })
}

/**
 * Step 2: receive the return. `restock: true` lines are received into stock at the return's location; `restock: false`
 * lines are dismissed (Medusa's damaged items, recorded but not restocked). A return already received is left as it is;
 * a receive begun by an earlier attempt is cancelled first, since only its confirm moves stock.
 */
export async function receiveStep(container: MedusaContainer, input: { returnId: string; lines: RefundStepLine[];
  actorId?: string }): Promise<void> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data: [found] } = await query.graph({ entity: 'return', fields: ['id', 'status'], filters: { id: input.returnId } })
  if (found?.status === 'received') return
  const { data: changes } = await query.graph({ entity: 'order_change', fields: ['id', 'change_type'],
    filters: { return_id: input.returnId, status: ['pending', 'requested'] } })
  if (changes.some(change => change.change_type === 'return_receive')) {
    await cancelReturnReceiveWorkflow(container).run({ input: { return_id: input.returnId } })
  }
  await beginReceiveReturnWorkflow(container).run({ input: { return_id: input.returnId, created_by: input.actorId } })
  const items = (restock: boolean) => input.lines.filter(line => line.restock === restock)
    .map(line => ({ id: line.orderLineId, quantity: line.quantity }))
  if (items(true).length) {
    await receiveItemReturnRequestWorkflow(container).run({ input: { return_id: input.returnId, items: items(true) } })
  }
  if (items(false).length) {
    await dismissItemReturnRequestWorkflow(container).run({ input: { return_id: input.returnId, items: items(false) } })
  }
  await confirmReturnReceiveWorkflow(container).run({ input: { return_id: input.returnId, confirmed_by: input.actorId } })
}

/** Step 3: one refund of `amount` (a major-unit decimal string) on the order's payment; returns Medusa's refund id. */
export async function moneyStep(container: MedusaContainer, input: { paymentId: string; amount: string; note: string;
  actorId?: string }): Promise<string> {
  const refundIds = async () => {
    const { data: [payment] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
      entity: 'payment', fields: ['id', 'refunds.id'], filters: { id: input.paymentId } })
    return (payment?.refunds ?? []).map((refund: { id: string } | null) => refund?.id)
  }
  const before = await refundIds()
  await refundPaymentWorkflow(container).run({ input: {
    payment_id: input.paymentId, amount: input.amount, note: input.note, created_by: input.actorId,
  } })
  const created = (await refundIds()).filter(id => id && !before.includes(id))
  if (created.length !== 1) throw new Error(`Expected one new refund on payment ${input.paymentId}, found ${created.length}`)
  return created[0] as string
}
