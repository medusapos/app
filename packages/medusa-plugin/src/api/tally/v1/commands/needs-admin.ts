import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { TALLY_LEDGER_MODULE } from '../../../../modules/tally-ledger'
import type TallyLedgerModuleService from '../../../../modules/tally-ledger/service'
import { loadRefundOrder, recordedRefundsMinor } from '../../../../workflows/tally-order-refund/execute'

export const NEEDS_ADMIN_REFUND_MESSAGES = Object.freeze({
  session_closed: 'The register session closed before this refund finished, so no money was refunded. A manager can finish it in the store admin.',
  money_unconfirmed: 'The store could not confirm whether this refund went through. A manager must check it in the store admin.',
  refund_unrecorded: "This order's refunds do not match the till's records. A manager must check them in the store admin.",
  park_unrecorded: 'The store could not finish recording this refund. A manager must check it in the store admin.',
  payment_provider: "This sale's payment needs a manager to handle the refund in the store admin.",
  admin_check: 'A manager must check this refund in the store admin.',
})
export const NEEDS_ADMIN_SALE_MESSAGE = 'A manager must check this sale in the store admin.'

export function needsAdminWire({ type, storedReason, sessionClosedProven }: {
  type: string; storedReason: unknown; sessionClosedProven: boolean
}): { reason: string; message: string } | null {
  if (type === 'order.create') return { reason: 'admin_check', message: NEEDS_ADMIN_SALE_MESSAGE }
  if (type !== 'order.refund') return null
  const reason = storedReason === 'session_closed' && !sessionClosedProven ? 'money_unconfirmed'
    : typeof storedReason === 'string' && Object.prototype.hasOwnProperty.call(NEEDS_ADMIN_REFUND_MESSAGES, storedReason)
      ? storedReason as keyof typeof NEEDS_ADMIN_REFUND_MESSAGES : 'admin_check'
  return { reason, message: NEEDS_ADMIN_REFUND_MESSAGES[reason] }
}

export async function loadNeedsAdminAnswer(container: MedusaContainer, id: string): Promise<{ reason: string; message: string } | null> {
  try {
    const ledger = container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE)
    const [command] = await ledger.listTallyCommands({ id })
    if (command?.status !== 'needs_admin') return null
    const storedReason = command.needs_admin_reason?.reason
    let sessionClosedProven = false
    if (command.type === 'order.refund' && storedReason === 'session_closed') {
      try {
        const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
        const row = await knex('tally_refund').where({ command_id: id }).first('order_id', 'money_started_at', 'medusa_refund_id')
        if (row?.money_started_at === null && row.medusa_refund_id === null) {
          const order = await loadRefundOrder(container, row.order_id)
          if (order?.payment) sessionClosedProven = order.payment.refundedMinor <= await recordedRefundsMinor(knex, order, order.payment.id)
        }
      } catch {
        sessionClosedProven = false
      }
    }
    return needsAdminWire({ type: command.type, storedReason, sessionClosedProven })
  } catch {
    return null
  }
}
