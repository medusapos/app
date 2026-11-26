import { useRef, useState, type JSX } from 'react';
import { RefundModal, type RefundFormValue } from '@tallyui/components';
import type { OrderRefundEnvelope, StoreOrder } from '@tallyui/core';
import {
  getDeviceId, mintUuid, RefundAnswerPendingError, submitOrderRefund, type PosOrder, type PosRefundCollection,
} from '@tallyui/pos';
import { REFUND_REASON_MAX, refundRequest, type RefundFormInput } from '../lib/refund';
import { useRegister } from '../lib/register-context';
import { defaultStorage, REGISTER_ID_KEY } from '../lib/session';
import { useNetworkOnline } from '../lib/use-network-online';
import { outcomeMessage, REFUND_IN_PROGRESS } from './order-refund-dialog';

const NOT_READY = 'Open the register to refund';

/**
 * A partial refund (#569) in TallyUI's RefundModal: the form prices, this sends. One refund id per opening (ADR-080
 * Amendment 3); each confirm is a new command built from the form's current values, and only a rejection keeps the
 * modal open for another. A refund sent without a final answer goes to the sheet, which resumes it on its own envelope.
 */
export function OrderRefundModal({ order, refunds, input, onClose, onUnanswered }: {
  order: StoreOrder; tenders: PosOrder['payments']; refunds: PosRefundCollection;
  input: Extract<RefundFormInput, { offered: true }>;
  onClose: () => void;
  /** The refund was sent without a final answer; the sheet resumes it on its own envelope. */
  onUnanswered: (message: string, record: import('@tallyui/pos').PosRefund) => void;
}): JSX.Element {
  const { register, boundRegisterId, commandTransport } = useRegister();
  const online = useNetworkOnline();
  const [message, setMessage] = useState('');
  const clientRefundId = useRef(mintUuid());
  const inFlight = useRef(false);
  const sessionId = register.session?.status === 'open' ? register.session.id : null;
  const ready = !!sessionId && !!boundRegisterId;

  async function confirm(value: RefundFormValue) {
    if (inFlight.current) return;
    if (!sessionId || !boundRegisterId) return setMessage(NOT_READY);
    if (value.reason.trim().length > REFUND_REASON_MAX) return setMessage(`Keep the reason to ${REFUND_REASON_MAX} characters.`);
    const request = refundRequest(value, input);
    const createdAt = new Date().toISOString();
    const envelope: OrderRefundEnvelope = { id: mintUuid(), type: 'order.refund', version: 1, createdAt,
      deviceId: getDeviceId(defaultStorage(), REGISTER_ID_KEY), attempt: 1,
      payload: { clientRefundId: clientRefundId.current, orderId: order.id, clientOrderId: order.clientOrderId, lines: request.lines,
        shippingMinor: request.shippingMinor, adjustmentMinor: request.adjustmentMinor, totalMinor: request.totalMinor,
        destination: request.destination, reason: request.reason.trim(), registerId: boundRegisterId, sessionId, createdAt } };
    inFlight.current = true;
    setMessage('');
    try {
      const { outcome, record } = await submitOrderRefund({ refunds, transport: commandTransport(), envelope });
      if (outcome.kind === 'applied') return onClose();
      // A rejection is final for its command; the next confirm sends a new one for the same refund.
      if (outcome.kind === 'rejected') return setMessage(outcomeMessage(outcome));
      onUnanswered(outcome.kind === 'needs_admin' ? '' : outcomeMessage(outcome), record);
    } catch (error) {
      if (error instanceof RefundAnswerPendingError) return onUnanswered(REFUND_IN_PROGRESS, error.record);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
    }
  }

  const error = !ready ? NOT_READY : message || undefined;
  return <RefundModal open onOpenChange={(next) => { if (!next && !inFlight.current) onClose(); }}
    lines={input.lines} refunds={input.refunds} orderTotalMinor={input.orderTotalMinor} refundedMinor={input.refundedMinor}
    refundableShippingMinor={input.refundableShippingMinor} originalMethod={input.originalMethod}
    cashRoundingMinor={input.remainderShareMinor} currency={order.currency} orderReference={order.reference}
    online={online} error={error} onConfirm={confirm} />;
}
