import type { RefundFormValue } from '@tallyui/components';
import type { StoreOrder, StoreOrderLine } from '@tallyui/core';
import { priceRefund, refundableLines, type EarlierRefund, type PosOrder } from '@tallyui/pos';
import { paymentLabel } from './order-detail';

/** The plugin refuses a longer reason (packages/medusa-plugin/src/workflows/tally-order-refund/payload-shape.ts). */
export const REFUND_REASON_MAX = 500;

const gross = (charge: { totalMinor: number; taxMinor: number }) => charge.totalMinor + charge.taxMinor;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export type RefundFormInput =
  | { offered: true; lines: StoreOrderLine[]; refunds: EarlierRefund[]; tillRefunded: Map<string, number>; orderTotalMinor: number; refundedMinor: number;
      refundableShippingMinor: number; remainderShareMinor: number; originalMethod?: { title: string; available: true } }
  | { offered: false; reason: 'canceled' | 'refunded' | 'no_payment' | 'money_drift' | 'lines_unknown' | 'sold_unknown' };

export function refundFormInput(order: StoreOrder, tenders: PosOrder['payments']): RefundFormInput {
  if (order.status === 'canceled') return { offered: false, reason: 'canceled' };
  const paidMinor = sum(order.payments.map((payment) => payment.amountMinor));
  if (order.paymentRecordUnreadable || paidMinor === 0) return { offered: false, reason: 'no_payment' };
  if (order.refunds.some((refund) => refund.lines === undefined)) return { offered: false, reason: 'lines_unknown' };
  const refundedMinor = sum(order.refunds.map((refund) => refund.amountMinor));
  if (paidMinor - refundedMinor <= 0) return { offered: false, reason: 'refunded' };

  const lines = order.lines.filter((line) => line.clientLineId && line.quantity > 0);
  if (lines.some((line) => line.soldTotalMinor === undefined || line.soldTaxMinor === undefined)) return { offered: false, reason: 'sold_unknown' };
  const tillRefunds = order.refunds.map((refund) => ({ lines: refund.lines! }));
  const tillRefunded = new Map<string, number>();
  for (const refund of tillRefunds) for (const { orderLineId, quantity } of refund.lines) {
    tillRefunded.set(orderLineId, (tillRefunded.get(orderLineId) ?? 0) + quantity);
  }
  const excess = lines.flatMap((line) => {
    const quantity = Math.min(line.quantity, line.returnedQuantity ?? 0) - (tillRefunded.get(line.id) ?? 0);
    return quantity > 0 ? [{ orderLineId: line.id, quantity }] : [];
  });
  const refunds = excess.length ? [...tillRefunds, { lines: excess }] : tillRefunds;
  const earlierLineMoney = tillRefunds.map((refund) => sum(refund.lines.map((line) => line.netMinor + line.taxMinor)));
  const shippingMinor = sum(order.shipping.map(gross));
  // Earlier shipping is an upper estimate: the store does not return each refund's shipping.
  const earlierShippingMinor = sum(order.refunds.map((refund, index) => Math.max(0, refund.amountMinor - earlierLineMoney[index])));
  const refundableShippingMinor = Math.max(0, shippingMinor - earlierShippingMinor);
  const fees = [...order.lines.filter((line) => !line.clientLineId), ...order.fees];
  const remainderMinor = paidMinor - shippingMinor - sum(fees.map(gross)) - sum(earlierLineMoney);
  const request = refundableLines(lines, refunds).map(({ orderLineId, refundableQuantity }) =>
    ({ orderLineId, quantity: refundableQuantity, restock: false }));
  const { priced, totalMinor } = priceRefund(lines, refunds, request);
  let remainderShareMinor = 0;
  // Mirror the plugin's ADR 0026 rulings B/N1: a negative difference needs a covering net or the largest gross line's tax.
  if (!excess.length && priced.length) {
    const difference = remainderMinor - totalMinor;
    if (Math.abs(difference) > lines.length) return { offered: false, reason: 'money_drift' };
    const largest = priced.reduce((best, line) => line.totalMinor >= best.totalMinor ? line : best);
    if (difference >= 0 || priced.some((line) => line.netMinor >= -difference) || largest.taxMinor + difference >= 0) {
      remainderShareMinor = difference;
    }
  }
  const labels = [...new Set(tenders.filter((tender) => tender.method !== 'cash').map((tender) => paymentLabel(tender.method)))];
  return {
    offered: true, lines, refunds, tillRefunded, orderTotalMinor: paidMinor, refundedMinor, refundableShippingMinor, remainderShareMinor,
    ...(labels.length ? { originalMethod: { title: labels.join(', '), available: true as const } } : {}),
  };
}

export function refundRequest(value: RefundFormValue, input: Extract<RefundFormInput, { offered: true }>): RefundFormValue {
  if (!value.lines.length || input.remainderShareMinor === 0) return value;
  const emptiesLines = input.lines.every(({ id, quantity }) => (input.tillRefunded.get(id) ?? 0)
    + (value.lines.find((line) => line.orderLineId === id)?.quantity ?? 0) >= quantity);
  return emptiesLines ? { ...value, adjustmentMinor: value.adjustmentMinor - input.remainderShareMinor } : value;
}
