// Display only: the till change a sale shows. Nothing written or sent reads it.
import { countsTowardPaid, lockedRefundDueMinor, type SentOrder } from '@tallyui/pos';

/**
 * The change the till hands back, in minor units. Since @tallyui/pos 5.0.0 a cash leg taken at Take is netted
 * (use-sale.ts addTender: amountMinor min(entry, due), changeMinor the rest), so order.changeDueMinor is 0 for it;
 * the change sits on the leg. This copies TallyUI's own tender-pane formula (components sale/tender-pane.tsx:177-179):
 * an un-netted overpayment still counts through changeDueMinor, less what locked legs owe as the store's refund, and
 * a locked or uncaptured leg's changeMinor never counts. Drop it when TallyUI exports a change-due helper (TallyUI/tallyui#1360).
 */
export function changeDueMinor(order: Pick<SentOrder, 'changeDueMinor' | 'totalMinor' | 'payments'>): number {
  const refundDue = Math.min(order.changeDueMinor, lockedRefundDueMinor(order));
  return order.changeDueMinor - refundDue + order.payments.reduce(
    (sum, leg) => sum + (!leg.locked && countsTowardPaid(leg) ? leg.changeMinor ?? 0 : 0), 0);
}
