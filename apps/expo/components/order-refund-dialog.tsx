import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Button, Dialog, DialogContent, DialogFooter, DialogTitle, Label, Notice, RefundNeedsAdminNotice, Switch, Text, Textarea } from '@tallyui/components';
import { formatMoney, type StoreOrder } from '@tallyui/core';
import {
  RefundAnswerPendingError, submitOrderRefund, type OrderRefundOutcome, type PosOrder, type PosRefund, type PosRefundCollection,
} from '@tallyui/pos';
import { paymentLabel } from '../lib/order-detail';
import { REFUND_REASON_MAX } from '../lib/refund';
import { useRegister } from '../lib/register-context';
import { useNetworkOnline } from '../lib/use-network-online';

export const REFUND_IN_PROGRESS = 'This refund is still in progress. Try again in a moment.';

/** This till's refund records for one store order, live from `pos_refunds`. */
export function useRefundRecords(refunds: PosRefundCollection | undefined, orderId: string | undefined): PosRefund[] | null {
  const [records, setRecords] = useState<{ refunds: PosRefundCollection; orderId: string; list: PosRefund[] } | null>(null);
  useEffect(() => {
    if (!refunds || !orderId) return;
    const subscription = refunds.find({ selector: { orderId } }).$.subscribe((docs) => setRecords({ refunds, orderId, list: docs.map((doc) => doc.toJSON() as PosRefund) }));
    return () => subscription.unsubscribe();
  }, [refunds, orderId]);
  return records && records.refunds === refunds && records.orderId === orderId ? records.list : null;
}

/** How many of this till's `pos_refunds` the store has applied, live. */
export function useAppliedRefundCount(refunds: PosRefundCollection | undefined): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!refunds) return;
    const subscription = refunds.count({ selector: { status: 'applied' } }).$.subscribe(setCount);
    return () => subscription.unsubscribe();
  }, [refunds]);
  return refunds ? count : 0;
}

export function outcomeMessage(outcome: Exclude<OrderRefundOutcome, { kind: 'applied' | 'needs_admin' }>): string {
  switch (outcome.kind) {
    // TallyUI exports no cashier text for refund codes, so the store's own message shows.
    case 'rejected': return outcome.error.message;
    // An unknown answer leaves the envelope available for retry.
    case 'unknown': return 'The store did not answer. Try again.';
    case 'refused': return `The store refused the refund (${outcome.reason}). Try again.`;
    case 'unauthorized': return 'Sign in again, then try again.';
  }
}

/**
 * Resume an unanswered refund (ADR 0026) on its original envelope. A rejection ends this attempt.
 */
export function OrderRefundDialog({ order, tenders, refunds, resume, onClose, notice }: {
  order: StoreOrder; tenders: PosOrder['payments']; refunds: PosRefundCollection; resume: PosRefund; onClose: () => void;
  /** Shown as the first error message: why a refund form handed this refund over unanswered. */
  notice?: string;
}) {
  const { commandTransport } = useRegister();
  const online = useNetworkOnline();
  const { lines, shippingMinor, totalMinor, destination, reason } = resume.envelope.payload;
  const restock = lines.every((line) => line.restock);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState(notice ?? '');
  const [needsAdmin, setNeedsAdmin] = useState<{ reason: string; message: string } | null>(() => {
    if (resume.error?.code !== 'needs_admin') return null;
    const storedReason = resume.error.data?.reason;
    return { reason: typeof storedReason === 'string' ? storedReason : 'admin_check', message: resume.error.message };
  });
  const [rejected, setRejected] = useState(false);
  const inFlight = useRef(false);
  const label = destination === 'cash' ? 'Cash'
    : [...new Set(tenders.filter((tender) => tender.method !== 'cash').map((tender) => paymentLabel(tender.method)))].join(', ');
  const money = (amount: number) => formatMoney({ amount, currency: order.currency }) ?? '';

  async function confirm() {
    if (inFlight.current || !online) return;
    inFlight.current = true;
    setPending(true);
    setMessage('');
    try {
      const { outcome } = await submitOrderRefund({ refunds, transport: commandTransport(), envelope: resume.envelope });
      if (outcome.kind === 'applied') return onClose();
      if (outcome.kind === 'needs_admin') return setNeedsAdmin({ reason: outcome.reason, message: outcome.message });
      if (outcome.kind === 'rejected') {
        setRejected(true);
        setNeedsAdmin(null);
      }
      setMessage(outcomeMessage(outcome));
    } catch (error) {
      setMessage(error instanceof RefundAnswerPendingError ? REFUND_IN_PROGRESS : error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const hold = !online ? 'Refunds need a connection' : null;
  return <Dialog open onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
    <DialogContent testID="order-refund-dialog" className="gap-4">
      <DialogTitle>{`Refund order ${order.reference}`}</DialogTitle>
      <View className="gap-1">
        {lines.map((line) => <View key={line.orderLineId} className="flex-row justify-between">
          <Text className="text-sm text-foreground">{order.lines.find((entry) => entry.id === line.orderLineId)?.name ?? ''}</Text>
          <Text className="text-sm text-foreground">{`× ${line.quantity}`}</Text>
        </View>)}
        {shippingMinor > 0 ? <View className="flex-row justify-between">
          <Text className="text-sm text-foreground">Shipping</Text><Text className="text-sm text-foreground">{money(shippingMinor)}</Text>
        </View> : null}
      </View>
      <Text testID="order-refund-total" className="font-semibold text-foreground">{`Refund ${money(totalMinor)}`}</Text>
      <Text testID="order-refund-destination" className="text-sm text-muted-foreground">{`To ${label}`}</Text>
      <View className="flex-row items-center justify-between">
        <Label nativeID="order-refund-restock-label">Restock</Label>
        <Switch testID="order-refund-restock" aria-labelledby="order-refund-restock-label" checked={restock} disabled />
      </View>
      <Textarea testID="order-refund-reason" value={reason} editable={false} placeholder="Reason"
        accessibilityLabel="Reason" maxLength={REFUND_REASON_MAX} />
      {hold ? <Notice tone="info" title={hold} testID="order-refund-hold" /> : null}
      {needsAdmin ? <RefundNeedsAdminNotice {...needsAdmin} onCheckAgain={confirm} /> : null}
      {message ? <Notice tone="bad" title={message} testID="order-refund-error" /> : null}
      <DialogFooter>
        <Button variant="outline" testID="order-refund-cancel" disabled={pending} onPress={onClose}><Text>Cancel</Text></Button>
        {!needsAdmin && !rejected && <Button variant="destructive" testID="order-refund-confirm" disabled={pending || !!hold} onPress={() => { void confirm(); }}>
          <Text>Confirm</Text>
        </Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
