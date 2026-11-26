import type { RefundFormValue } from '@tallyui/components';
import type { OrderRefundLine, StoreOrder, StoreOrderLine } from '@tallyui/core';
import { priceRefund, refundableLines, type EarlierRefund, type PosOrder } from '@tallyui/pos';
import { paymentLabel } from './order-detail';

/** A full refund of one store order (ADR 0026), priced as the plugin prices it, or why none is offered. */
export type FullRefundOffer =
  | { offered: true; lines: OrderRefundLine[]; shippingMinor: number; adjustmentMinor: 0; totalMinor: number;
      destination: 'cash' | 'original_method'; methodLabel: string }
  | { offered: false; reason: 'canceled' | 'refunded' | 'no_payment' | 'nothing' | 'money_drift' };

/** The plugin refuses a longer reason (packages/medusa-plugin/src/workflows/tally-order-refund/payload-shape.ts). */
export const REFUND_REASON_MAX = 500;

const gross = (charge: { totalMinor: number; taxMinor: number }) => charge.totalMinor + charge.taxMinor;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/**
 * Mirrors the plugin's priceRefund for a whole order (ADR 0026 rulings A, B, N1, and #547's goodwill clamp): the lines get
 * what was paid less every shipping and fee gross, so the total is exactly the figure the plugin computes. The
 * connector reads fee items as lines; only product lines carry a till line id (order-create writes tally_line_uuid on
 * them and tally_fee_uuid on fees), so a line without one is a fee and stays with the store.
 */
export function fullRefundOffer(order: StoreOrder, tenders: PosOrder['payments'], restock: boolean): FullRefundOffer {
  if (order.status === 'canceled') return { offered: false, reason: 'canceled' };
  // The plugin reads one payment; a split store payment is summed here (a NOTES gap, not a pricing rule).
  const paidMinor = sum(order.payments.map((payment) => payment.amountMinor));
  if (order.paymentRecordUnreadable || paidMinor === 0) return { offered: false, reason: 'no_payment' };
  const products = order.lines.filter((line) => line.clientLineId && line.quantity > 0);
  const fees = [...order.lines.filter((line) => !line.clientLineId), ...order.fees];
  const shippingMinor = sum(order.shipping.map(gross));
  const remainderMinor = paidMinor - shippingMinor - sum(fees.map(gross));
  let linesMinor = sum(products.map(gross));
  const difference = remainderMinor - linesMinor;
  // More than a minor unit a line apart: the order's money moved since the sale (the plugin's order_state money_drift).
  if (Math.abs(difference) > products.length) return { offered: false, reason: 'money_drift' };
  // B: a line whose net covers the difference takes it, or any line takes a positive one. N1: else the largest gross
  // line's tax takes it if it can; otherwise the difference is dropped and the lines keep their own sum.
  const covered = difference >= 0 || products.some((line) => line.totalMinor >= -difference);
  const largest = products.reduce<(typeof products)[number] | null>(
    (best, line) => (!best || gross(line) >= gross(best) ? line : best), null);
  if (covered || (largest && largest.taxMinor + difference >= 0)) linesMinor = remainderMinor;
  if (linesMinor + shippingMinor === 0) return { offered: false, reason: 'nothing' };
  // #547: earlier refunds carry no lines here, so the offer is capped at what is left; the plugin accepts that figure when
  // the overrun is earlier goodwill recorded at a till or baselined and refuses lines or shipping already taken.
  const leftMinor = paidMinor - sum(order.refunds.map((entry) => entry.amountMinor));
  const totalMinor = Math.min(linesMinor + shippingMinor, leftMinor);
  // #569: the plugin takes an overrun off the lines only while overMinor <= linesMinor; a bigger one is refused every time.
  if (linesMinor + shippingMinor - leftMinor > linesMinor) return { offered: false, reason: 'refunded' };
  if (totalMinor <= 0) return { offered: false, reason: 'refunded' };
  // Decision 4: a sale paid only in cash refunds to cash; any other refunds to the sale's own method, non-cash first,
  // and a sale that also took cash gets back in cash only what the non-cash tenders cannot take (fees stay with the store).
  const nonCash = tenders.filter((tender) => tender.method !== 'cash');
  const tookCash = nonCash.length < tenders.length;
  const labels = [...new Set(nonCash.map((tender) => paymentLabel(tender.method)))].join(', ');
  const cashToo = tookCash && totalMinor > sum(nonCash.map((tender) => tender.amountMinor));
  const methodLabel = nonCash.length === 0 ? 'Cash' : cashToo ? `${labels}, then cash` : labels;
  return {
    offered: true, lines: products.map((line) => ({ orderLineId: line.id, quantity: line.quantity, restock })), shippingMinor,
    adjustmentMinor: 0, totalMinor, destination: nonCash.length > 0 ? 'original_method' : 'cash', methodLabel,
  };
}

export type RefundFormInput =
  | { offered: true; lines: StoreOrderLine[]; refunds: EarlierRefund[]; orderTotalMinor: number; refundedMinor: number;
      refundableShippingMinor: number; remainderShareMinor: number; originalMethod?: { title: string; available: true } }
  | { offered: false; reason: 'canceled' | 'refunded' | 'no_payment' | 'money_drift' | 'lines_unknown' };

export function refundFormInput(order: StoreOrder, tenders: PosOrder['payments']): RefundFormInput {
  if (order.status === 'canceled') return { offered: false, reason: 'canceled' };
  const paidMinor = sum(order.payments.map((payment) => payment.amountMinor));
  if (order.paymentRecordUnreadable || paidMinor === 0) return { offered: false, reason: 'no_payment' };
  if (order.refunds.some((refund) => refund.lines === undefined)) return { offered: false, reason: 'lines_unknown' };
  const refundedMinor = sum(order.refunds.map((refund) => refund.amountMinor));
  if (paidMinor - refundedMinor <= 0) return { offered: false, reason: 'refunded' };

  const lines = order.lines.filter((line) => line.clientLineId && line.quantity > 0);
  const refunds = order.refunds.map((refund) => ({ lines: refund.lines! }));
  const earlierLineMoney = refunds.map((refund) => sum(refund.lines.map((line) => line.netMinor + line.taxMinor)));
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
  if (priced.length) {
    const difference = remainderMinor - totalMinor;
    if (Math.abs(difference) > lines.length) return { offered: false, reason: 'money_drift' };
    const largest = priced.reduce((best, line) => line.totalMinor >= best.totalMinor ? line : best);
    if (difference >= 0 || priced.some((line) => line.netMinor >= -difference) || largest.taxMinor + difference >= 0) {
      remainderShareMinor = difference;
    }
  }
  const labels = [...new Set(tenders.filter((tender) => tender.method !== 'cash').map((tender) => paymentLabel(tender.method)))];
  return {
    offered: true, lines, refunds, orderTotalMinor: paidMinor, refundedMinor, refundableShippingMinor, remainderShareMinor,
    ...(labels.length ? { originalMethod: { title: labels.join(', '), available: true as const } } : {}),
  };
}

export function refundRequest(value: RefundFormValue, input: Extract<RefundFormInput, { offered: true }>): RefundFormValue {
  if (!value.lines.length || input.remainderShareMinor === 0) return value;
  const remaining = refundableLines(input.lines, input.refunds);
  const emptiesLines = remaining.every(({ orderLineId, refundableQuantity }) =>
    (value.lines.find((line) => line.orderLineId === orderLineId)?.quantity ?? 0) === refundableQuantity);
  return emptiesLines ? { ...value, adjustmentMinor: value.adjustmentMinor - input.remainderShareMinor } : value;
}
