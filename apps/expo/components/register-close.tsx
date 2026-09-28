import { useRef, useState, type ReactNode } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { getLocales } from 'expo-localization';
import { Button, ClosureSheet, Dialog, DialogContent, DialogTitle, Input, Label, Text } from '@tallyui/components';
import { formatMoney, minorUnitDigits, moneyFromDecimalString } from '@tallyui/core';
import { buildClosureDocument, type Closure, type ClosureContext, type useRegisterSession } from '@tallyui/pos';
import { Portal } from '@tallyui/primitives';
import { ApprovalError, rememberApprover, requestApproval, type Approval } from '../lib/approval';
import { defaultStorage } from '../lib/session';

type Register = ReturnType<typeof useRegisterSession>;

// ADR 0018's copy.
export const APPROVE_OFFLINE = 'Connect to approve, or count again.';
export const APPROVE_CONTEXT = "This count is over the threshold. A manager's admin login approves it.";
const APPROVE_FAILED = "Couldn't check the approval. Try again.";

/**
 * RegisterCount's `approve` (ADR 0018, option b): opens "Manager approval" and resolves with the approver, or null
 * on Cancel. `dialog` must be rendered by the caller.
 */
export function useApprove(baseUrl: string, online: boolean) {
  const [pending, setPending] = useState<((result: Approval | null) => void) | null>(null);
  const approve = () => new Promise<Approval | null>((resolve) => setPending(() => resolve));
  const dialog = pending ? <ApprovalDialog baseUrl={baseUrl} online={online}
    onResult={(result) => { setPending(null); pending(result); }} /> : null;
  return { approve, dialog };
}

function ApprovalDialog({ baseUrl, online, onResult }: { baseUrl: string; online: boolean; onResult: (result: Approval | null) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const offline = !online || unreachable;
  const submit = async () => {
    if (busyRef.current || !email.trim() || !password) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    // The password leaves state with the request, whatever its answer; nothing else keeps it.
    const secret = password;
    setPassword('');
    try {
      const approval = await requestApproval(baseUrl, email.trim(), secret);
      rememberApprover(defaultStorage(), baseUrl, approval.approvedBy, approval.approvedByName);
      onResult(approval);
    } catch (e) {
      if (e instanceof ApprovalError && e.code === 'offline') setUnreachable(true);
      else setError(e instanceof ApprovalError ? e.message : APPROVE_FAILED);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busyRef.current) onResult(null); }}>
    <DialogContent testID="approval-dialog">
      <DialogTitle>Manager approval</DialogTitle>
      <Text testID="approval-context" className="text-muted-foreground">{APPROVE_CONTEXT}</Text>
      {offline ? <Text testID="approval-offline" accessibilityRole="alert">{APPROVE_OFFLINE}</Text> : <>
        <Label nativeID="approval-email-label">Email</Label>
        <Input><Input.Field testID="approval-email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="off"
          keyboardType="email-address" accessibilityLabel="Email" accessibilityLabelledBy="approval-email-label" /></Input>
        <Label nativeID="approval-password-label">Password</Label>
        {/* autoComplete off: the till's browser must neither fill in nor offer to keep an approver's password. */}
        <Input><Input.Field testID="approval-password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="off"
          onSubmitEditing={() => { void submit(); }} accessibilityLabel="Password" accessibilityLabelledBy="approval-password-label" /></Input>
        {error ? <Text testID="approval-error" accessibilityRole="alert" className="text-destructive">{error}</Text> : null}
        <Button testID="approval-approve" className="min-h-11" disabled={busy || !email.trim() || !password} onPress={() => { void submit(); }}>
          <Text>{busy ? 'Checking…' : 'Approve'}</Text>
        </Button>
      </>}
      <Button testID="approval-cancel" variant="outline" className="min-h-11" disabled={busy} onPress={() => onResult(null)}>
        <Text>Cancel</Text>
      </Button>
    </DialogContent>
  </Dialog>;
}

/** The approver the closure froze (`breakdowns.approved_by`, named by `approved_by_name`), or null without one. */
export function closureApprover(closure: Closure): string | null {
  const { approved_by: id, approved_by_name: name } = closure.breakdowns;
  if (typeof id !== 'string' || !id) return null;
  return typeof name === 'string' && name ? name : id;
}

/** TallyUI's ClosureSheet, with the app's "Approved by" line under it (in the portal, above the sheet's overlay). */
export function RegisterClosedSheet({ register, currency, onDone }: { register: Register; currency: string; onDone: () => void }) {
  const approver = register.lastClosure ? closureApprover(register.lastClosure) : null;
  return <>
    <ClosureSheet register={register} currency={currency} onDone={onDone} />
    {approver ? <Portal name="closure-approved-by">
      <View className="pointer-events-none fixed inset-x-0 bottom-0 z-50 items-center p-4">
        <Text testID="closure-approved-by" className="rounded-md bg-background px-4 py-2">{`Approved by ${approver}`}</Text>
      </View>
    </Portal> : null}
  </>;
}

/** A session closed but whose closure didn't finish (a restart mid-close, #88 review): Finish closing resumes it. */
export function FinishClose({ closing, error, onFinish }: { closing: boolean; error: string; onFinish: () => void }) {
  return <View testID="finish-close" className="gap-3 p-4">
    <Text>{closing ? 'Finishing the close…' : "The last close didn't finish. Finish it to open the register again."}</Text>
    {error ? <Text accessibilityRole="alert" className="text-destructive">{error}</Text> : null}
    <Button testID="finish-close-button" className="min-h-11" disabled={closing} onPress={onFinish}><Text>Finish closing</Text></Button>
  </View>;
}

const I18N = { over: 'Over', short: 'Short', exact: 'Exact', paid_in: 'Paid in', paid_out: 'Paid out', no_sale: 'No sale', void: 'Void' };

export function closureContext(currency: string, store: { name: string; address?: string }): ClosureContext {
  return {
    currency, exponent: minorUnitDigits(currency), timezone: 'device', locale: getLocales()[0]?.languageTag ?? 'en',
    store, printedAt: new Date().toISOString(), i18n: I18N,
    // The envelope's money is decimal text ('-5.00'); shown as the till shows every amount.
    formatMoney: (value) => {
      const negative = value.startsWith('-');
      const money = moneyFromDecimalString(negative ? value.slice(1) : value, currency);
      return money ? formatMoney({ ...money, amount: negative ? -money.amount : money.amount }) ?? value : value;
    },
  };
}

const Row = ({ label, value, testID }: { label: string; value: ReactNode; testID?: string }) =>
  <View className="min-h-11 flex-row items-center justify-between gap-3">
    <Text className="shrink-0 text-muted-foreground">{label}</Text>
    <Text testID={testID} className="shrink text-right tabular-nums">{value}</Text>
  </View>;

/**
 * The last closure's Z figures (ADR 0018), only ever from the frozen `Closure` row through TallyUI's
 * `buildClosureDocument`, never recomputed from sales or movements. Reached from "Register ›" while no session is open.
 */
export function LastClosureSheet({ register, currency, store, open, onOpenChange }: {
  register: Register; currency: string; store: { name: string; address?: string }; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const { height } = useWindowDimensions();
  const closure = register.lastClosure;
  if (!open || !closure) return null;
  const { closure: z, fiscal } = buildClosureDocument(closure, closureContext(currency, store));
  const approver = z.approved_by ? String(z.breakdowns.labels.approved_by_name || z.approved_by) : null;
  // The envelope carries every closure field; its type names only the ones it adds.
  const unsynced = Number((z as { unsynced_count?: unknown }).unsynced_count ?? 0);
  const movements = z.breakdowns.movements as (typeof z.breakdowns.movements[number] & { id?: unknown; reason?: unknown })[];
  return <Dialog open onOpenChange={onOpenChange}>
    <DialogContent testID="last-closure" className="flex-col overflow-hidden" style={{ maxHeight: Math.max(280, height - 64) }}>
      <DialogTitle>{`Last closure · Closure #${fiscal.receipt_number}`}</DialogTitle>
      <ScrollView className="flex-1" contentContainerClassName="gap-1">
        <Row label="Opened" value={z.opened_at.datetime} />
        <Row label="Closed" value={z.closed_at.datetime} />
        <Row label="Sales" value={z.period_sales_total_display} testID="last-closure-sales" />
        <Row label="Opening float" value={z.breakdowns.opening_float.counted_display} testID="last-closure-float" />
        {z.tenders.map((tender) => <View key={tender.name} testID={`last-closure-tender-${tender.name}`} className="border-t border-border pt-2">
          <Text className="font-semibold">{String(tender.label)}</Text>
          <Row label="Expected" value={tender.expected_display} testID={`last-closure-expected-${tender.name}`} />
          <Row label="Counted" value={tender.counted_display} testID={`last-closure-counted-${tender.name}`} />
          <Row label="Variance" testID={`last-closure-variance-${tender.name}`}
            value={tender.has_variance ? `${tender.variance_label} ${tender.variance_absolute_display}` : tender.variance_label} />
        </View>)}
        {movements.length ? <View testID="last-closure-movements" className="border-t border-border pt-2">
          <Text className="font-semibold">Paid in / out</Text>
          {movements.map((movement) => <Row key={String(movement.id)} label={String(movement.type_label)}
            value={`${movement.amount_display}${movement.reason ? ` · ${String(movement.reason)}` : ''}${movement.voided ? ' · undone' : ''}`} />)}
        </View> : null}
        {unsynced > 0 ? <Text testID="last-closure-unsynced" accessibilityRole="alert" className="text-warning">
          {`${unsynced} ${unsynced === 1 ? 'sale' : 'sales'} not sent yet · ${z.unsynced_total_display}`}</Text> : null}
        {approver ? <Text testID="last-closure-approved-by" className="min-h-11">{`Approved by ${approver}`}</Text> : null}
      </ScrollView>
      <Button testID="last-closure-done" variant="outline" className="min-h-11" onPress={() => onOpenChange(false)}><Text>Done</Text></Button>
    </DialogContent>
  </Dialog>;
}
