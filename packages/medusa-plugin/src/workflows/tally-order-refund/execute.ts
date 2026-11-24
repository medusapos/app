import { randomUUID } from 'node:crypto'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, MedusaError, generateEntityId } from '@medusajs/framework/utils'
import type { CommandEnvelope, CommandResult, OrderRefundPayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { TALLY_LEDGER_MODULE } from '../../modules/tally-ledger'
import type TallyLedgerModuleService from '../../modules/tally-ledger/service'
import { parseCommandResult } from '../../modules/tally-ledger/command-result'
import { sessionTakesMoney } from '../../modules/tally-register/session-open'
import { mayApproveVariance } from '../../policies/manager'
import type { ExecuteOutcome } from '../tally-order-create/execute'
import { commandFingerprint } from '../tally-order-create/fingerprint'
import { currencyDecimals, minorToMajor } from '../tally-order-create/money'
import { envelopeErrors, MAX_PAYLOAD_ERRORS } from '../tally-order-create/payload-shape'
import { clientTimeStageErrors } from '../client-time'
import { refundPayloadErrors } from './payload-shape'
import { connectorSplit, medusaSumMinor, priceRefund, refundMoneyMinor, type PricedLine, type RefundableLine } from './price'
import { splitRefund, type SplitEntry, type TillTender } from './split'
import { beginReturn, cancelReturn, findOwnOpenReturn, moneyStep, receiveStep, requestReturn } from './workflow'
import { moveOrderRefund } from './admin'

type Raw = { value: string }
type RefundRow = { id: string; client_refund_id: string; command_id: string; order_id: string; session_id: string
  status: 'in_progress' | 'applied' | 'needs_admin'; lines: PricedLine[]; shipping_minor: string | number
  total_minor: string | number; reason: string; by_method: Record<string, number>; refunds: SplitEntry[]
  return_id: string | null; received_at: Date | null; medusa_refund_id: string | null }
type Run = { outcome: ExecuteOutcome; keepClaim: boolean }
// A refund that failed before its money left no row (undo deletes it), so it is never counted.
const COUNTED_REFUND_STATUSES = ['in_progress', 'applied', 'needs_admin'] as const
const sessionClosedMessage = (id: string) =>
  `session_closed: refund ${id} did not finish before its register session closed; this run moved no money and no stock. Check the order's refunds in Medusa Admin and finish it there.`

/** What a refund needs of a Medusa order, in minor units. */
export interface RefundOrder {
  id: string; state?: string; tillId?: string; decimals: number; locationId?: string; tenders: TillTender[]
  lines: RefundableLine[]; linesMoneyMinor: number | null; shippingMinor: number; payment: { id: string; amountMinor: number; refundedMinor: number } | null
}

const rejected = (id: string, code: string, message: string, data?: Record<string, unknown>): ExecuteOutcome =>
  ({ kind: 'result', result: { id, status: 'rejected', error: { code, message, ...(data ? { data } : {}) } } as CommandResult })

export async function loadRefundOrder(container: MedusaContainer, orderId: string): Promise<RefundOrder | null> {
  const { data: [order] } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({ entity: 'order', fields: [
    'id', 'status', 'is_draft_order', 'currency_code', 'metadata', 'total', 'items.id', 'items.quantity', 'items.raw_total',
    'items.raw_tax_total', 'items.metadata', 'shipping_methods.raw_total', 'fulfillments.location_id', 'fulfillments.canceled_at',
    'payment_collections.payments.id', 'payment_collections.payments.raw_amount', 'payment_collections.payments.canceled_at',
    'payment_collections.payments.refunds.raw_amount',
  ], filters: { id: orderId } })
  if (!order) return null
  const decimals = currencyDecimals(order.currency_code)
  const metadata = (order.metadata ?? {}) as Record<string, unknown>
  const payment = (order.payment_collections ?? []).flatMap(collection => collection?.payments ?? [])
    .find(candidate => candidate && candidate.canceled_at == null)
  const fulfillment = (order.fulfillments ?? []).find(candidate => candidate && candidate.canceled_at == null)
  const tenders = Array.isArray(metadata.tally_payments) ? metadata.tally_payments as Record<string, unknown>[] : []
  return {
    id: order.id, decimals,
    state: order.is_draft_order ? 'draft' : order.status === 'draft' || order.status === 'canceled' ? order.status : undefined,
    tillId: typeof metadata.tally_client_id === 'string' && metadata.tally_client_id.length ? metadata.tally_client_id : undefined,
    locationId: fulfillment?.location_id ?? undefined,
    // The till's own payment id is clientPaymentId (order.create's payload).
    tenders: tenders.map(tender => ({ ...tender, id: tender.clientPaymentId ?? tender.id }) as TillTender),
    lines: (order.items ?? []).filter(item => item !== null).filter(item => !item.metadata?.tally_fee_uuid).map(item => ({ id: item.id, quantity: Number(item.quantity),
      ...connectorSplit((item.raw_total as unknown as Raw).value, (item.raw_tax_total as unknown as Raw).value, decimals) })),
    ...refundMoneyMinor(decimals, payment ? (payment.raw_amount as unknown as Raw).value : null,
      (order.shipping_methods ?? []).map(method => (method?.raw_total as unknown as Raw).value),
      (order.items ?? []).filter(item => item?.metadata?.tally_fee_uuid).map(item => (item!.raw_total as unknown as Raw).value)),
    payment: payment ? { id: payment.id, amountMinor: medusaSumMinor(decimals, [(payment.raw_amount as unknown as Raw).value]),
      refundedMinor: medusaSumMinor(decimals, (payment.refunds ?? []).map(refund => (refund?.raw_amount as unknown as Raw).value)) } : null,
  }
}

export function refundResult(id: string, row: Pick<RefundRow, 'id' | 'total_minor' | 'by_method' | 'refunds'>): CommandResult {
  return { id, status: 'applied', refund: { totalMinor: Number(row.total_minor), byMethod: row.by_method,
    refunds: row.refunds.map((entry, n) => ({ id: `${row.id}:${n}`, paymentId: entry.paymentId, totalMinor: entry.totalMinor, state: 'succeeded' })) },
  } as CommandResult
}

/** ADR-038's refusal for a failure that left nothing in Medusa: platform_error for Medusa's own errors, internal_error for a
 *  plugin bug; anything else stays transient. */
function failedOutcome(container: MedusaContainer, id: string, error: Error): ExecuteOutcome {
  if (MedusaError.isMedusaError(error)) {
    return rejected(id, 'platform_error', `${error.type}: ${error.message}`, { platformCode: error.type, platformMessage: error.message })
  }
  if (!(error instanceof TypeError || error instanceof RangeError)) return { kind: 'transient', id, message: error.message }
  const correlationId = randomUUID()
  container.resolve(ContainerRegistrationKeys.LOGGER).error(`tally order.refund ${id} internal error ${correlationId}: ${error.stack}`)
  return rejected(id, 'internal_error', `Internal error (ref ${correlationId})`, { correlationId })
}

/**
 * Runs a refund under the per-order lock and the session row lock (ADR 0026 decisions 2 and 6), held to the end so no
 * other refund of the order and no close of the session interleaves. With a payload it starts or resumes that
 * clientRefundId; without one (the resolve script) it resumes the command's own row.
 */
async function runLocked(container: MedusaContainer, ctx: { id: string; claimToken: string; actorId?: string
  order: RefundOrder; payload?: OrderRefundPayload; row?: RefundRow }): Promise<Run> {
  const { id, claimToken, order, payload } = ctx
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const ledger = container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE)
  const busy: Run = { outcome: { kind: 'in_progress', id }, keepClaim: false }
  return knex.transaction(async trx => {
    const { rows: [{ locked }] } = await trx.raw("select pg_try_advisory_xact_lock(hashtext('tally_refund'), hashtext(?)) as locked", [order.id])
    if (!locked) return busy
    try {
      await ledger.assertClaim(id, claimToken)
    } catch (error) {
      if (MedusaError.isMedusaError(error) && error.type === MedusaError.Types.CONFLICT) return busy
      throw error
    }
    let row: RefundRow | undefined = await trx('tally_refund').where(payload ? { client_refund_id: payload.clientRefundId } : { command_id: id }).first()
    const sessionId = row ? row.session_id : payload!.sessionId
    const { rows: [session] } = await trx.raw(`select id, register_id, status from tally_register_session where id = coalesce(
      (select id from tally_register_session where id = ?), (select session_id from tally_register_session_alias where id = ?)) for update`,
    [sessionId, sessionId])
    if (payload && row && row.command_id !== id) {
      // Amendment 3: an applied clientRefundId under a new command is reconciled by the till; one still running is in progress.
      if (row.status !== 'applied') return busy
      return { outcome: rejected(id, 'invalid_payload', `clientRefundId: ${payload.clientRefundId} is already refund ${row.id}`), keepClaim: false }
    }
    if (row?.status === 'needs_admin') return busy
    if (row?.status === 'applied') {
      const result = refundResult(id, row)
      await ledger.complete(id, claimToken, result)
      return { outcome: { kind: 'result', result }, keepClaim: true }
    }
    const takesMoney = await sessionTakesMoney(session, async (sql, params) => (await trx.raw(sql, params)).rows)
    if (row && !takesMoney) return parkRefund(container, { id, claimToken, row }, 'session', sessionClosedMessage(row.id), 'session_closed')
    if (!row && payload) {
      if (!takesMoney || session.status !== 'open' || session.register_id !== payload.registerId) {
        return { outcome: rejected(id, 'no_open_session', 'This refund needs an open session of its register.', { sessionId: payload.sessionId }), keepClaim: false }
      }
      // Every refund of the order already started counts, so a refund still running or parked is never priced twice. The
      // order is read again under the lock, so its refunded money includes a refund that finished while this one waited.
      const earlier = await trx('tally_refund').where({ order_id: order.id }).whereIn('status', COUNTED_REFUND_STATUSES)
        .select('lines', 'shipping_minor', 'refunds', 'total_minor', 'medusa_refund_id') as RefundRow[]
      const current = await loadRefundOrder(container, order.id) ?? order
      const price = priceRefund({ lines: current.lines, linesMoneyMinor: current.linesMoneyMinor, shippingMinor: current.shippingMinor,
        earlier: earlier.map(entry => ({ lines: entry.lines, shippingMinor: Number(entry.shipping_minor) })),
        refundableMoneyMinor: current.payment ? current.payment.amountMinor - current.payment.refundedMinor
          - earlier.filter(entry => entry.medusa_refund_id === null).reduce((sum, entry) => sum + Number(entry.total_minor), 0) : null, request: payload })
      if (price.ok === false) return { outcome: rejected(id, price.error.code, price.error.message, price.error.data), keepClaim: false }
      const split = splitRefund({ orderId: order.id, tenders: order.tenders, earlier: earlier.flatMap(entry => entry.refunds),
        totalMinor: price.totalMinor, destination: payload.destination })
      const fields = { id: generateEntityId(undefined, 'tref'), client_refund_id: payload.clientRefundId, command_id: id,
        order_id: order.id, session_id: session.id, status: 'in_progress' as const, lines: price.lines,
        shipping_minor: payload.shippingMinor, adjustment_minor: payload.adjustmentMinor, total_minor: price.totalMinor,
        reason: payload.reason, by_method: split.byMethod, refunds: split.refunds }
      // Outside the transaction: the row must outlive a rollback once Medusa has been written to.
      await knex('tally_refund').insert({ ...fields, lines: JSON.stringify(fields.lines), by_method: JSON.stringify(fields.by_method),
        refunds: JSON.stringify(fields.refunds) })
      row = { ...fields, return_id: null, received_at: null, medusa_refund_id: null }
    }
    if (!row) throw new Error(`No refund row for command ${id}`)
    return runSteps(container, { ...ctx, row })
  })
}

async function parkRefund(container: MedusaContainer, { id, claimToken, row }: { id: string; claimToken: string; row: RefundRow },
  step: string, message: string, reason?: 'refund_unrecorded' | 'session_closed'): Promise<Run> {
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const ledger = container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  await knex('tally_refund').where({ id: row.id }).update({ status: 'needs_admin', updated_at: knex.fn.now() })
  const parked = await ledger.markNeedsAdmin(id, claimToken, { orderId: row.order_id, clientRefundId: row.client_refund_id,
    refundId: row.id, step, message, ...(reason ? { reason } : {}) })
  if (parked) logger.error(`tally order.refund needs admin: command ${id}, refund ${row.id}, step ${step}: ${message}`)
  else logger.warn(`tally order.refund: claim lost while parking command ${id} (refund ${row.id}, step ${step}: ${message})`)
  return { outcome: { kind: 'in_progress', id }, keepClaim: true }
}

async function runSteps(container: MedusaContainer, ctx: { id: string; claimToken: string; actorId?: string; order: RefundOrder
  row: RefundRow }): Promise<Run> {
  const { id, claimToken, actorId, order, row } = ctx
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const ledger = container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE)
  const write = (fields: Record<string, unknown>) => knex('tally_refund').where({ id: row.id }).update({ ...fields, updated_at: knex.fn.now() })
  const park = (step: string, message: string, reason?: 'refund_unrecorded') => parkRefund(container, ctx, step, message, reason)
  const lines = row.lines.map(({ orderLineId, quantity, restock }) => ({ orderLineId, quantity, restock }))
  // A failure before anything is in Medusa (or after the begun return was cancelled) leaves no row and no claim.
  const undo = async (error: Error): Promise<Run> => {
    await knex('tally_refund').where({ id: row.id }).delete()
    return { outcome: failedOutcome(container, id, error), keepClaim: false }
  }
  // Never refund twice: Medusa must show no more refunded on the payment than the rows that recorded a refund. Checked before
  // the receive, so stock never moves when the money won't, and again before the money, for a resume past the receive.
  const unrecorded = async (): Promise<{ paymentId: string; message: string | null }> => {
    const fresh = await loadRefundOrder(container, order.id)
    if (!fresh?.payment) throw new Error(`Order ${order.id} has no payment to refund`)
    const [{ sum }] = await knex('tally_refund').where({ order_id: order.id }).whereNotNull('medusa_refund_id').sum({ sum: 'total_minor' })
    const { metadata } = await knex('order').where({ id: order.id }).first('metadata')
    const baselines = await knex('refund').where({ payment_id: fresh.payment.id }).whereNull('deleted_at')
      .whereIn('id', (metadata?.tally_refund_baselines ?? []).map((entry: { refundId: string }) => entry.refundId))
      .whereNotIn('id', knex('tally_refund').whereNotNull('medusa_refund_id').select('medusa_refund_id')).select('raw_amount')
    const recorded = Number(sum ?? 0) + medusaSumMinor(order.decimals, baselines.map(refund => refund.raw_amount.value))
    return { paymentId: fresh.payment.id, message: fresh.payment.refundedMinor > recorded
      ? `refund_unrecorded: payment ${fresh.payment.id} shows ${fresh.payment.refundedMinor} refunded, tally_refund records ${recorded}` : null }
  }
  let step = 'return'
  try {
    let begun = false
    if (lines.length && !row.return_id) {
      if (!order.locationId) throw new MedusaError(MedusaError.Types.INVALID_DATA, `Order ${order.id} has no stock location`)
      // A run that died between the begin and the record left its tagged return open: record that one, never a second.
      let returnId = await findOwnOpenReturn(container, { orderId: order.id, refundRowId: row.id })
      try {
        returnId ??= await beginReturn(container, { orderId: order.id, locationId: order.locationId, actorId, note: row.reason,
          refundRowId: row.id })
      } catch (error) {
        return await undo(error)
      }
      // Recorded at once, so a resume reuses this return and never begins a second one.
      await write({ return_id: returnId })
      row.return_id = returnId
      begun = true
    }
    if (lines.length && !row.received_at) {
      try {
        await requestReturn(container, { returnId: row.return_id!, lines, actorId })
      } catch (error) {
        if (!begun) throw error
        try {
          await cancelReturn(container, row.return_id!)
        } catch (cancelError) {
          // A return that could not be cancelled is left for an admin; a resume reuses it.
          return await park('return', `${error.message} (return ${row.return_id} left open: ${cancelError.message})`)
        }
        return await undo(error)
      }
    }
    step = 'receive'
    if (lines.length && !row.received_at) {
      const check = await unrecorded()
      if (check.message) return await park(step, check.message, 'refund_unrecorded')
      await receiveStep(container, { returnId: row.return_id!, lines, actorId })
      await write({ received_at: new Date() })
    }
    step = 'refund'
    if (!row.medusa_refund_id) {
      const check = await unrecorded()
      if (check.message) return await park(step, check.message, 'refund_unrecorded')
      const medusaRefundId = await moneyStep(container, { paymentId: check.paymentId,
        amount: minorToMajor(Number(row.total_minor), order.decimals), note: row.reason, actorId })
      await write({ medusa_refund_id: medusaRefundId })
    }
    await write({ status: 'applied' })
  } catch (error) {
    return park(step, error.message)
  }
  const result = refundResult(id, row)
  await ledger.complete(id, claimToken, result)
  return { outcome: { kind: 'result', result }, keepClaim: true }
}

/** order.refund v1 (ADR-080, ADR 0026): shape, manager, order checks, claim, then the locked run. */
export async function executeOrderRefund(container: MedusaContainer, command: CommandEnvelope<unknown>, upperBound: number,
  actorId?: string): Promise<ExecuteOutcome> {
  const { id } = command
  const payload = command.payload as OrderRefundPayload
  const errors = [...envelopeErrors(command), ...refundPayloadErrors(payload)].slice(0, MAX_PAYLOAD_ERRORS)
  if (errors.length) return rejected(id, 'invalid_payload', errors.join('; '))
  const timeErrors = clientTimeStageErrors(command, upperBound)
  if (timeErrors.length) return rejected(id, 'invalid_payload', timeErrors.join('; '))
  try {
    if (!await mayApproveVariance(container, actorId)) return rejected(id, 'forbidden', 'Only a manager may refund a sale.')
    const order = await loadRefundOrder(container, payload.orderId)
    if (!order?.tillId) return rejected(id, 'not_till_order', 'This order was not taken at a till.')
    if (order.state) return rejected(id, 'order_state', `This order is ${order.state}.`, { state: order.state })
    const ledger = container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE)
    const fingerprint = commandFingerprint(command)
    let claim: Awaited<ReturnType<TallyLedgerModuleService['claim']>>
    try {
      claim = await ledger.claim({ id, type: command.type, fingerprint })
    } catch (error) {
      if (MedusaError.isMedusaError(error) && error.type === MedusaError.Types.CONFLICT) return { kind: 'in_progress', id }
      throw error
    }
    if (!claim.claimed) {
      if (claim.command.fingerprint !== fingerprint) return rejected(id, 'idempotency_mismatch', `Command ${id} was already used for a different payload.`)
      if (claim.command.status === 'in_progress' || claim.command.status === 'needs_admin') return { kind: 'in_progress', id }
      const result = parseCommandResult(claim.command.result)
      return { kind: 'result', result: claim.command.status === 'applied' ? { ...result, status: 'duplicate' } : result }
    }
    let keepClaim = false
    try {
      const run = await runLocked(container, { id, claimToken: claim.claimToken, actorId, order, payload })
      keepClaim = run.keepClaim
      return run.outcome
    } finally {
      if (!keepClaim) {
        await ledger.release(id, claim.claimToken).catch((error: Error) =>
          container.resolve(ContainerRegistrationKeys.LOGGER).error(`Could not release command ${id}.`, error))
      }
    }
  } catch (error) {
    return { kind: 'transient', id, message: error.message }
  }
}

/**
 * The resolve script's order.refund actions (ADR 0026 decision 2), for a command parked needs_admin: `resume` runs the
 * missing steps (the never-twice check included), `apply` records the admin's own Medusa refund, `move` changes session first. There is no reject.
 */
export async function resolveOrderRefund(container: MedusaContainer, commandId: string, action: string,
  medusaRefundId?: string): Promise<ExecuteOutcome> {
  if (action === 'move') return moveOrderRefund(container, commandId, medusaRefundId)
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const row: RefundRow | undefined = await knex('tally_refund').where({ command_id: commandId }).first()
  if (!row) throw new Error(`Command ${commandId} has no refund row`)
  if (action !== 'resume' && action !== 'apply') {
    throw new Error(`Refund ${row.id} cannot be rejected${row.return_id ? `: its return ${row.return_id} has moved stock` : ''}; use resume or apply`)
  }
  const order = await loadRefundOrder(container, row.order_id)
  if (!order) throw new Error(`Order ${row.order_id} of refund ${row.id} is missing`)
  if (action === 'apply') {
    if (row.lines.length && row.received_at === null) throw new Error(`Refund ${row.id} has not been received; use resume`)
    if (!medusaRefundId || !order.payment) throw new Error('Usage: apply <medusaRefundId> (a refund on the order\'s payment)')
    if (row.medusa_refund_id && row.medusa_refund_id !== medusaRefundId) {
      throw new Error(`Refund ${row.id} already records Medusa refund ${row.medusa_refund_id}; use resume; nothing written`)
    }
    const refund = await knex('refund').where({ id: medusaRefundId, payment_id: order.payment.id }).whereNull('deleted_at').first('id', 'raw_amount')
    if (!refund) throw new Error(`Refund ${medusaRefundId} is not a refund of order ${order.id}'s payment; nothing written`)
    const minor = medusaSumMinor(order.decimals, [refund.raw_amount.value])
    if (minor !== Number(row.total_minor)) throw new Error(`Refund ${medusaRefundId} is ${minor}, refund ${row.id} is ${row.total_minor}; nothing written`)
    const result = refundResult(commandId, row)
    const sessionClosed = await knex.transaction(async trx => {
      const { rows: [{ locked }] } = await trx.raw("select pg_try_advisory_xact_lock(hashtext('tally_refund'), hashtext(?)) as locked", [order.id])
      if (!locked) throw new Error(`A refund of order ${order.id} is in progress; try again`)
      const { rows: [session] } = await trx.raw(`select id, register_id, status from tally_register_session where id = coalesce(
        (select id from tally_register_session where id = ?), (select session_id from tally_register_session_alias where id = ?)) for update`,
      [row.session_id, row.session_id])
      const other = await trx('tally_refund').where({ medusa_refund_id: medusaRefundId }).whereNot({ id: row.id }).first('id')
      if (other) throw new Error(`Refund ${medusaRefundId} is already recorded by refund ${other.id}; nothing written`)
      if (!await sessionTakesMoney(session, async (sql, params) => (await trx.raw(sql, params)).rows)) {
        await trx('tally_command').where({ id: commandId, status: 'needs_admin' }).update({ needs_admin_reason: JSON.stringify({
          orderId: row.order_id, clientRefundId: row.client_refund_id, refundId: row.id,
          step: 'session', reason: 'session_closed', message: sessionClosedMessage(row.id),
        }), updated_at: trx.fn.now() })
        return true
      }
      const rows = await trx('tally_refund').where({ id: row.id, status: 'needs_admin' })
        .update({ status: 'applied', medusa_refund_id: medusaRefundId, updated_at: trx.fn.now() })
      const commands = await trx('tally_command').where({ id: commandId, status: 'needs_admin' }).update({ status: 'applied',
        result: JSON.stringify(parseCommandResult(result)), needs_admin_reason: null, updated_at: trx.fn.now() })
      if (rows !== 1 || commands !== 1) throw new Error(`Command ${commandId} changed while resolving; nothing written`)
    })
    if (sessionClosed) throw new Error(`Refund ${row.id}'s register session is closed; moved no money and no stock; it stays parked (session_closed)`)
    return { kind: 'result', result }
  }
  const claimToken = randomUUID()
  const taken = await knex('tally_command').where({ id: commandId, status: 'needs_admin' })
    .update({ status: 'in_progress', claim_token: claimToken, needs_admin_reason: null, updated_at: knex.fn.now() })
  if (taken !== 1) throw new Error(`Command ${commandId} changed while resolving; nothing written`)
  await knex('tally_refund').where({ id: row.id }).update({ status: 'in_progress', updated_at: knex.fn.now() })
  const run = await runLocked(container, { id: commandId, claimToken, order, row: { ...row, status: 'in_progress' } })
  if (!run.keepClaim) {
    const ledger = container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE)
    await knex('tally_refund').where({ id: row.id }).update({ status: 'needs_admin', updated_at: knex.fn.now() })
    await ledger.markNeedsAdmin(commandId, claimToken, { orderId: row.order_id, clientRefundId: row.client_refund_id,
      refundId: row.id, step: 'resume', message: 'The order was busy; resume again' })
    throw new Error(`A refund of order ${order.id} is in progress; try again`)
  }
  return run.outcome
}
