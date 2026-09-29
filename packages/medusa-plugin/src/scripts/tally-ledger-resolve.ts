import { randomUUID } from 'node:crypto'
import type { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { cancelOrderWorkflow } from '@medusajs/medusa/core-flows'
import { parseCommandResult } from '../modules/tally-ledger/command-result'
import { takeBackStockWorkflow } from '../workflows/tally-order-create/workflow'

// npx medusa exec <built path>/tally-ledger-resolve.js <commandId> apply|reject [message]
// Resolves an order.create the ledger parked as needs_admin (see the plugin README).
export default async function tallyLedgerResolve({ container, args }: ExecArgs) {
  const [id, action, ...words] = args
  const message = words.join(' ') || (action === 'reject' ? 'Rejected by an admin.' : 'Fixed by an admin.')
  if (!id || (action !== 'apply' && action !== 'reject')) {
    throw new Error('Usage: medusa exec tally-ledger-resolve.js <commandId> apply|reject [message]')
  }
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const row = await knex('tally_command').where({ id }).first()
  if (row?.status !== 'needs_admin') throw new Error(`Command ${id} is ${row?.status ?? 'missing'}, not needs_admin`)
  const reason = row.needs_admin_reason as { orderId: string; clientOrderId: string }
  // The same per-sale lock execute.ts holds, so no order.create of this sale runs while it is resolved.
  const connection = await knex.client.acquireConnection()
  let unlocked = true
  try {
    const { rows: [{ locked }] } = await connection.query(
      "select pg_try_advisory_lock(hashtext('tally_order'), hashtext($1)) as locked", [reason.clientOrderId])
    if (!locked) {
      logger.error(`tally_ledger_resolve: sale ${reason.clientOrderId} is in progress; try again`)
      throw new Error(`Sale ${reason.clientOrderId} is in progress; nothing written`)
    }
    try {
      await resolveHeld(container, id, action, message, reason)
    } finally {
      try {
        await connection.query("select pg_advisory_unlock(hashtext('tally_order'), hashtext($1))", [reason.clientOrderId])
      } catch (error) {
        unlocked = false
        logger.error(`tally_ledger_resolve: could not unlock sale ${reason.clientOrderId}: ${error.message}`)
      }
    }
  } finally {
    // A session whose unlock failed may still hold the sale lock, so it is closed and marked disposed: the pool
    // only frees a borrowed connection on release (its destroy waits for it), and its validator drops a disposed one.
    if (!unlocked) {
      connection.__knex__disposed = 'sale unlock failed'
      await knex.client.destroyRawConnection(connection).catch((error: Error) =>
        logger.error(`tally_ledger_resolve: could not close the connection of sale ${reason.clientOrderId}: ${error.message}`))
    }
    await knex.client.releaseConnection(connection)
  }
}

async function resolveHeld(container: ExecArgs['container'], id: string, action: string, message: string,
  reason: { orderId: string; clientOrderId: string }) {
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  // Re-read under the sale lock: the row may have been resolved between the first read and the lock.
  const current = await knex('tally_command').where({ id }).first('status')
  if (current?.status !== 'needs_admin') throw new Error(`Command ${id} changed while resolving; nothing written`)
  if (action === 'reject') {
    // A rejected command must never leave a live order behind, so the sale's live order is canceled first.
    const orders = await knex('order').select('id', 'status', 'metadata').whereRaw("metadata->>'tally_client_id' = ?", [reason.clientOrderId])
      .whereNull('deleted_at')
    for (const order of orders) {
      // Cancelling releases reservations but not the plugin's top-up, so an unreversed one is taken back first, hand-cancelled or not.
      if (order.metadata?.tally_stock_topups && !order.metadata.tally_stock_topups_reversed) {
        try {
          await takeBackStockWorkflow(container).run({ input: { orderId: order.id } })
        } catch (error) {
          logger.error(`tally_ledger_resolve: reject refused for command ${id}: stock top-up on order ${order.id} could not be reversed: ${error.message}`)
          throw error
        }
      }
      if (order.status !== 'canceled') {
        try {
          await cancelOrderWorkflow(container).run({ input: { order_id: order.id } })
        } catch (error) {
          logger.error(`tally_ledger_resolve: reject refused for command ${id}: order ${order.id} could not be cancelled: ${error.message}`)
          throw error
        }
      }
      // Only the order this command parked was never placed; an earlier order of the sale an admin canceled keeps counting.
      if (order.id !== reason.orderId) continue
      try {
        const service = container.resolve(Modules.ORDER)
        const { metadata } = await service.retrieveOrder(order.id)
        await service.updateOrders(order.id, { metadata: { ...metadata, tally_rejected: true } })
      } catch (error) {
        logger.error(`tally_ledger_resolve: reject refused for command ${id}: order ${order.id} could not be marked rejected: ${error.message}`)
        throw error
      }
    }
  }
  // apply: the resend reclaims at once (updated_at is past the lease) and resumes the fixed order.
  const update = action === 'apply'
    ? { status: 'in_progress', claim_token: randomUUID(), updated_at: knex.raw('to_timestamp(0)'), needs_admin_reason: null }
    : { status: 'rejected', updated_at: knex.fn.now(), result: JSON.stringify(parseCommandResult({
      id, status: 'rejected', error: { code: 'platform_error', message, data: {
        platformCode: 'TALLY_ADMIN_REJECTED', platformMessage: message, orderId: reason.orderId,
      } },
    })) }
  const updated = await knex('tally_command').where({ id, status: 'needs_admin' }).update(update)
  if (updated !== 1) throw new Error(`Command ${id} changed while resolving; nothing written`)
  logger.info(`tally_ledger_resolve: command ${id} ${action}: ${message}`)
}
