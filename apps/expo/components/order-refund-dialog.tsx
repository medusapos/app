import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Button, Dialog, DialogContent, DialogFooter, DialogTitle, Label, Notice, RefundNeedsAdminNotice, Switch, Text, Textarea } from '@tallyui/components';
import { formatMoney, type OrderRefundEnvelope, type StoreOrder } from '@tallyui/core';
import {
  getDeviceId, mintUuid, RefundAnswerPendingError, submitOrderRefund, type OrderRefundOutcome, type PosOrder, type PosRefund, type PosRefundCollection,
} from '@tallyui/pos';
import { fullRefundOffer, REFUND_REASON_MAX } from '../lib/refund';
import { useRegister } from '../lib/register-context';
import { defaultStorage, REGISTER_ID_KEY } from '../lib/session';
import { useNetworkOnline } from '../lib/use-network-online';

export const REFUND_IN_PROGRESS = 'This refund is still in progress. Try again in a moment.';

/** This till's refund records for one store order, live from `pos_refunds`. */
export function useRefundRecords(refunds: PosRefundCollection | undefined, orderId: string | undefined): PosRefund[] {
  const [records, setRecords] = useState<{ orderId?: string; list: PosRefund[] }>({ list: [] });
  useEffect(() => {
    if (!refunds || !orderId) return;
    const subscription = refunds.find({ selector: { orderId } }).$.subscribe((docs) => setRecords({ orderId, list: docs.map((doc) => doc.toJSON() as PosRefund) }));
    return () => subscription.unsubscribe();
  }, [refunds, orderId]);
  return refunds && records.orderId === orderId ? records.list : [];
}

function outcomeMessage(outcome: Exclude<OrderRefundOutcome, { kind: 'applied' | 'needs_admin' }>): string {
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
 * Refund all (ADR 0026): one order.refund v1 for the whole order, nothing editable but Restock and the reason. Mounted
 * once per opening, so its refund id is minted once. After no answer, a refusal or an unauthorized answer, Confirm resends
 * the same envelope; after a rejection, it sends a new command for the same refund.
 */
export function OrderRefundDialog({ order, tenders, refunds, resume, onClose }: {
  order: StoreOrder; tenders: PosOrder['payments']; refunds: PosRefundCollection; resume: PosRefund | null; onClose: () => void;
}) {
  const { register, boundRegisterId, commandTransport } = useRegister();
  const online = useNetworkOnline();
  const resumed = resume?.envelope.payload;
  const [restock, setRestock] = useState(resumed ? resumed.lines.every((line) => line.restock) : true);
  const [reason, setReason] = useState(resumed?.reason ?? '');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [needsAdmin, setNeedsAdmin] = useState<{ reason: string; message: string } | null>(() => {
    if (resume?.error?.code !== 'needs_admin') return null;
    const storedReason = resume.error.data?.reason;
    return { reason: typeof storedReason === 'string' ? storedReason : 'admin_check', message: resume.error.message };
  });
  const clientRefundId = useRef(resumed?.clientRefundId ?? mintUuid());
  const envelope = useRef<OrderRefundEnvelope | null>(resume?.envelope ?? null);
  const inFlight = useRef(false);
  const offer = fullRefundOffer(order, tenders, restock);
  const sent = envelope.current?.payload;
  const lines = sent?.lines ?? (offer.offered ? offer.lines : []);
  const shippingMinor = sent?.shippingMinor ?? (offer.offered ? offer.shippingMinor : 0);
  const totalMinor = sent?.totalMinor ?? (offer.offered ? offer.totalMinor : 0);
  const label = offer.offered ? offer.methodLabel : sent?.destination === 'cash' ? 'Cash' : "the sale's method";
  const money = (amount: number) => formatMoney({ amount, currency: order.currency }) ?? '';
  const sessionId = register.session?.status === 'open' ? register.session.id : null;
  const ready = !!sessionId && !!boundRegisterId;

  async function confirm() {
    if (inFlight.current || !online || !sessionId || !boundRegisterId) return;
    if (!envelope.current) {
      if (!offer.offered || !reason.trim() || reason.trim().length > REFUND_REASON_MAX) return;
      const createdAt = new Date().toISOString();
      envelope.current = { id: mintUuid(), type: 'order.refund', version: 1, createdAt, deviceId: getDeviceId(defaultStorage(), REGISTER_ID_KEY), attempt: 1,
        payload: { clientRefundId: clientRefundId.current, orderId: order.id, clientOrderId: order.clientOrderId, lines: offer.lines,
          shippingMinor: offer.shippingMinor, adjustmentMinor: 0, totalMinor: offer.totalMinor, destination: offer.destination, reason: reason.trim(),
          registerId: boundRegisterId, sessionId, createdAt } };
    }
    inFlight.current = true;
    setPending(true);
    setMessage('');
    try {
      const { outcome } = await submitOrderRefund({ refunds, transport: commandTransport(), envelope: envelope.current });
      if (outcome.kind === 'applied') return onClose();
      if (outcome.kind === 'needs_admin') return setNeedsAdmin({ reason: outcome.reason, message: outcome.message });
      // A refusal is final for its command; the next Confirm sends a new one for the same refund.
      if (outcome.kind === 'rejected') {
        envelope.current = null;
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

  const locked = pending || envelope.current !== null;
  // The plugin refuses a blank reason (payload-shape.ts), so a new refund waits for one.
  const hold = !ready ? 'Open the register to refund' : !online ? 'Refunds need a connection'
    : !envelope.current && !reason.trim() ? 'Enter a reason to refund' : null;
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
      {order.refunds.length > 0 ? <Text testID="order-refund-already" className="text-sm text-muted-foreground">
        {`Already refunded ${money(order.refunds.reduce((total, entry) => total + entry.amountMinor, 0))}`}
      </Text> : null}
      <Text testID="order-refund-total" className="font-semibold text-foreground">{`Refund ${money(totalMinor)}`}</Text>
      <Text testID="order-refund-destination" className="text-sm text-muted-foreground">{`To ${label}`}</Text>
      <View className="flex-row items-center justify-between">
        <Label nativeID="order-refund-restock-label">Restock</Label>
        <Switch testID="order-refund-restock" aria-labelledby="order-refund-restock-label" checked={restock} disabled={locked} onCheckedChange={setRestock} />
      </View>
      <Textarea testID="order-refund-reason" value={reason} onChangeText={setReason} editable={!locked} placeholder="Reason"
        accessibilityLabel="Reason" maxLength={REFUND_REASON_MAX} />
      {hold ? <Notice tone="info" title={hold} testID="order-refund-hold" /> : null}
      {needsAdmin ? <RefundNeedsAdminNotice {...needsAdmin} onCheckAgain={confirm} /> : null}
      {message ? <Notice tone="bad" title={message} testID="order-refund-error" /> : null}
      <DialogFooter>
        <Button variant="outline" testID="order-refund-cancel" disabled={pending} onPress={onClose}><Text>Cancel</Text></Button>
        {!needsAdmin && <Button variant="destructive" testID="order-refund-confirm" disabled={pending || !!hold} onPress={() => { void confirm(); }}>
          <Text>Confirm</Text>
        </Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
