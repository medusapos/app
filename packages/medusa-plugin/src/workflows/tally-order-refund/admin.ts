import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { sessionTakesMoney } from '../../modules/tally-register/session-open'
import { loadRefundOrder, resolveOrderRefund } from './execute'
import { medusaSumMinor } from './price'

export async function moveOrderRefund(container: MedusaContainer, commandId: string, sessionId?: string) {
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const moved = await knex.transaction(async trx => {
    const initial = await trx('tally_refund').where({ command_id: commandId }).first()
    if (!initial) throw new Error(`Command ${commandId} has no parked refund; nothing written`)
    const { rows: [{ locked }] } = await trx.raw("select pg_try_advisory_xact_lock(hashtext('tally_refund'), hashtext(?)) as locked", [initial.order_id])
    if (!locked) throw new Error(`A refund of order ${initial.order_id} is in progress; try again`)
    const { rows: [current] } = await trx.raw(`select id, register_id from tally_register_session where id = coalesce(
      (select id from tally_register_session where id = ?), (select session_id from tally_register_session_alias where id = ?))`,
    [initial.session_id, initial.session_id])
    if (!current) throw new Error(`Session ${initial.session_id} is missing; nothing written`)
    const target = sessionId
      ? (await trx.raw(`select id from tally_register_session where id = coalesce(
        (select id from tally_register_session where id = ?), (select session_id from tally_register_session_alias where id = ?))`,
      [sessionId, sessionId])).rows[0]
      : await trx('tally_register_session').where({ register_id: current.register_id, status: 'open' }).whereNull('deleted_at').first('id')
    const sessions = await trx('tally_register_session').whereIn('id', [current.id, ...(target ? [target.id] : [])])
      .orderBy('id', 'asc').forUpdate()
    const row = await trx('tally_refund').where({ command_id: commandId }).first()
    const command = await trx('tally_command').where({ id: commandId }).first()
    if (command?.type !== 'order.refund' || command.status !== 'needs_admin' || row?.status !== 'needs_admin') {
      throw new Error(`Command ${commandId} is not an order.refund parked needs_admin; nothing written`)
    }
    if (row.medusa_refund_id) throw new Error(`Refund ${row.id} already records ${row.medusa_refund_id}; its money has moved; nothing written`)
    const query = async (sql: string, params: string[]) => (await trx.raw(sql, params)).rows
    if (await sessionTakesMoney(sessions.find(session => session.id === current.id), query)) {
      throw new Error(`Refund ${row.id}'s current session still takes money; use resume; nothing written`)
    }
    if (!target && !sessionId) throw new Error(`Register ${current.register_id} has no open session; nothing written`)
    const next = sessions.find(session => session.id === target?.id)
    if (next?.status !== 'open' || !await sessionTakesMoney(next, query)) {
      throw new Error(`Target session ${sessionId ?? target?.id} has status ${next?.status ?? 'missing'} and cannot take a new refund; nothing written`)
    }
    await trx('tally_refund').where({ id: row.id }).update({ session_id: next.id, updated_at: trx.fn.now() })
    await trx('order').where({ id: row.order_id }).update({ metadata: trx.raw(`jsonb_set(coalesce(metadata, '{}'::jsonb),
      '{tally_refund_moves}', coalesce(metadata->'tally_refund_moves', '[]'::jsonb) || ?::jsonb)`,
    [JSON.stringify([{ refundId: row.id, commandId, fromSessionId: row.session_id, toSessionId: next.id, at: new Date().toISOString() }])]) })
    return { id: row.id, oldSession: row.session_id, newSession: next.id, oldRegister: current.register_id, newRegister: next.register_id }
  })
  container.resolve(ContainerRegistrationKeys.LOGGER).info(`tally refund ${moved.id}: moved from session ${moved.oldSession} to ${moved.newSession}${
    moved.oldRegister !== moved.newRegister ? `; cash leaves register ${moved.newRegister}'s drawer, not the sale's register ${moved.oldRegister}` : ''}`)
  return resolveOrderRefund(container, commandId, 'resume')
}

export async function baselineOrderRefund(container: MedusaContainer, orderId: string, medusaRefundId: string, handMade: boolean, reason: string) {
  if (!reason.trim()) throw new Error('A baseline reason is required; nothing written')
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  await knex.transaction(async trx => {
    const { rows: [{ locked }] } = await trx.raw("select pg_try_advisory_xact_lock(hashtext('tally_refund'), hashtext(?)) as locked", [orderId])
    if (!locked) throw new Error(`A refund of order ${orderId} is in progress; try again`)
    const order = await loadRefundOrder(container, orderId)
    if (!order?.payment) throw new Error(`Order ${orderId} is missing or has no payment; nothing written`)
    const refund = await trx('refund').where({ id: medusaRefundId, payment_id: order.payment.id }).whereNull('deleted_at').first('raw_amount')
    if (!refund) throw new Error(`Refund ${medusaRefundId} is not a non-deleted refund of order ${orderId}'s payment; nothing written`)
    const recorded = await trx('tally_refund').where({ medusa_refund_id: medusaRefundId }).first('id')
    if (recorded) throw new Error(`Refund ${medusaRefundId} is till refund ${recorded.id}'s own money; nothing written`)
    const service = container.resolve(Modules.ORDER)
    const { metadata } = await service.retrieveOrder(orderId)
    const baselines = (metadata?.tally_refund_baselines ?? []) as { refundId: string }[]
    if (baselines.some(entry => entry.refundId === medusaRefundId)) throw new Error(`Refund ${medusaRefundId} is already baselined; nothing written`)
    const amount = medusaSumMinor(order.decimals, [refund.raw_amount.value])
    const pending = await trx('tally_refund').where({ order_id: orderId, total_minor: amount }).whereNull('medusa_refund_id')
      .whereIn('status', ['in_progress', 'needs_admin']).first('id', 'command_id')
    if (pending && !handMade) {
      throw new Error(`Refund ${medusaRefundId} may be refund ${pending.id}'s own money (command ${pending.command_id}); use tally-ledger-resolve.js ${pending.command_id} apply ${medusaRefundId} if it is that refund's, or --hand-made if an admin made it; nothing written`)
    }
    await trx('order').where({ id: orderId }).update({ metadata: trx.raw(`jsonb_set(coalesce(metadata, '{}'::jsonb),
      '{tally_refund_baselines}', coalesce(metadata->'tally_refund_baselines', '[]'::jsonb) || ?::jsonb)`,
    [JSON.stringify([{ refundId: medusaRefundId, amountMinor: amount, at: new Date().toISOString(), reason }])]) })
  })
}

export async function listParkedRefunds(container: MedusaContainer) {
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const parked = await knex('tally_refund as r').leftJoin('order as o', 'o.id', 'r.order_id')
    .leftJoin('tally_command as c', 'c.id', 'r.command_id').leftJoin('tally_register_session as s', 's.id', 'r.session_id')
    .where('r.status', 'needs_admin').orderBy('r.created_at', 'asc')
    .select('r.id', 'r.command_id', 'r.order_id', 'o.display_id', 'r.session_id', 's.status as session_status',
      'r.total_minor', 'o.currency_code', 'r.updated_at', knex.raw(`
        exists(select 1 from tally_register_closure where session_id = s.id) as closure_filed,
        c.needs_admin_reason->>'step' as step, c.needs_admin_reason->>'reason' as reason`))
  const { rows: moved } = await knex.raw(`select m.entry->>'refundId' as id, m.entry->>'commandId' as command_id,
    o.id as order_id, o.display_id, m.entry->>'fromSessionId' as from_session_id,
    m.entry->>'toSessionId' as to_session_id, m.entry->>'at' as at, r.status
    from "order" o cross join lateral jsonb_array_elements(coalesce(o.metadata->'tally_refund_moves', '[]'::jsonb)) as m(entry)
    left join tally_refund r on r.id = m.entry->>'refundId'`)
  return { parked, moved }
}
