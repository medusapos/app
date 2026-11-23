import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { AppText as Text } from './app-text';
import {
  ClosureSheet, OpenRegisterCard, orderReference, RegisterColumn, RegisterCount, RegisterPanel, RegisterPicker,
} from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import {
  RegisterSessionRequiredError, replacedOrderIds, watchFresh, type ApprovalNeeded, type PosOrder, type useRegisterSession, type useSale,
} from '@tallyui/pos';
import { printXReport } from '../lib/closure-print';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { useSession } from '../lib/session-context';
import { closureContext, LastClosureSheet, printClosure, storeApproval, useApprove, type RefusedSale } from './register-close';
import { RegisterConflictCard } from './register-conflict';
import { WarningIcon } from './warning-icon';

// RegisterColumn's Finish closing button's nativeID (TallyUI #175).
const FINISH_CLOSE_BUTTON = 'register-column-finish-close-button';
type CloseInput = Parameters<ReturnType<typeof useRegisterSession>['actions']['closeSession']>[0];

// The refusals at tender start (ADR 0017): paying needs an open register; browsing and the cart don't.
export const OPEN_TO_PAY = 'Open the register to take payment.';
// Before the order store opens (also the tender pane's wait for it).
export const GETTING_READY = 'Getting ready to save sales…';
export const CHECK_FAILED = "Couldn't check the register. Try again.";

type Sale = ReturnType<typeof useSale>;

/** v2's amber line on the count (row 09e.2): the till's open sales, which the close leaves open. Null for none. */
export function openCartsWarning(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? '1 cart still open · it stays open after the close' : `${count} carts still open · they stay open after the close`;
}

/**
 * The sale the Cart gets: its Cash and Card start the tender only once `requireSaleSession()` confirms an open
 * session (TallyUI c1's gate at tender start), and pin that session for the tender (`complete()` stamps it, TallyUI
 * #170, #172). Also reports the tender to the register.
 */
export function useGatedSale(sale: Sale): { sale: Sale; refused: string | null } {
  const { register, setTenderInProgress } = useRegister();
  const latest = useRef(sale);
  latest.current = sale;
  const [refused, setRefused] = useState<string | null>(null);
  // A check in flight: further Cash or Card taps are ignored until it settles.
  const checking = useRef(false);
  const open = register.session?.status === 'open';
  useEffect(() => { if (open) setRefused(null); }, [open]);
  const tender = sale.stage.kind === 'tender';
  useEffect(() => setTenderInProgress(tender), [tender, setTenderInProgress]);
  useEffect(() => () => setTenderInProgress(false), [setTenderInProgress]);
  const startTender = (method: 'cash' | 'external') => {
    if (checking.current) return;
    // Before the order store opens there is no session to check, nor one to stamp the sale with.
    if (!register.enabled) return setRefused(GETTING_READY);
    checking.current = true;
    // requireSaleSession() reads storage, which can be ahead of the render (a session opened just before the tap), so
    // the confirmed session is passed to startTender explicitly, and useSale pins it for this tender (TallyUI #172).
    // It resolves null only while sessions are off; the tender then starts as it did before registers.
    register.requireSaleSession().then((session) => {
      checking.current = false;
      if (latest.current.stage.kind !== 'cart') return;
      setRefused(null);
      latest.current.startTender(method, { session: session ?? undefined });
    }, (error: unknown) => {
      checking.current = false;
      if (error instanceof RegisterSessionRequiredError) return setRefused(OPEN_TO_PAY);
      console.warn('Could not check the register at tender start:', error);
      setRefused(CHECK_FAILED);
    });
  };
  return { sale: { ...sale, startTender }, refused };
}

/**
 * The session's sales the store refused, read from the till's pos_orders: TallyUI's drawer rule (`replacedOrderIds` over
 * the session's sales), so a sale a successor replaced is left out, and the rest still count their cash in the drawer.
 */
function useRefusedSales(sessionId: string | undefined): RefusedSale[] {
  const { orders } = useOutboxContext();
  const [sales, setSales] = useState<PosOrder[]>([]);
  useEffect(() => {
    setSales([]);
    if (!orders || !sessionId) return;
    const subscription = watchFresh(orders, { selector: { sessionId }, sort: [{ createdAt: 'asc' }] }).subscribe(setSales);
    return () => subscription.unsubscribe();
  }, [orders, sessionId]);
  return useMemo(() => {
    const replaced = replacedOrderIds(sales);
    return sales.filter((order) => order.syncStatus === 'rejected' && !replaced.has(order.id)).map((order) => ({
      id: order.id, reference: orderReference(order), code: order.error?.code ?? 'no code',
      // The cash this till took; a payment already on the store (storePaymentId) never reached this drawer.
      amount: formatMoney({ currency: order.currency, amount: order.payments
        .filter((payment) => payment.method === 'cash' && payment.storePaymentId === undefined)
        .reduce((total, payment) => total + payment.amountMinor, 0) }) ?? '',
    }));
  }, [sales]);
}

/**
 * The register panel (movements with Undo, Close register), opened from the control as v2's side sheet; between sessions, the last
 * closure's figures, unless the store refused a closure's approval: then the panel, whose card asks a manager again.
 */
export function RegisterPanelSheet({ currency, store, online, open, onOpenChange }: {
  currency: string; store: { name: string; address?: string }; online: boolean; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const { register, registerName } = useRegister();
  const { session: signedIn } = useSession();
  // Desk, 2026-11-23: the re-approval lists the refused sales behind the store's variance.
  const refused = useRefusedSales(register.approvalNeeded?.sessionId);
  const { approve, dialog } = useApprove(signedIn?.baseUrl ?? '', online, refused);
  if (!register.session && register.lastClosure && !register.approvalNeeded) {
    return <LastClosureSheet register={register} currency={currency} store={store} open={open} onOpenChange={onOpenChange} />;
  }
  // ADR 0023: the store's new proof for the refused closure's session and variance; not live at the store, offline.
  const reapprove = async (needed: ApprovalNeeded) => {
    const result = await approve(signedIn && needed.liveAtStore
      ? storeApproval(signedIn.baseUrl, signedIn.token, needed.sessionId, async () => needed.variance) : undefined, needed.liveAtStore);
    return result?.approval ? { approvedBy: result.approvedBy, approval: result.approval } : null;
  };
  return <>
    <RegisterPanel register={register} currency={currency} registerName={registerName ?? undefined} open={open}
      presentation="side" storeName={store.name}
      onPrintXReport={Platform.OS === 'web' && register.session?.status === 'open'
        ? () => printXReport({ session: register.session!, expected: register.expected,
          salesCount: register.salesCount, registerName, context: closureContext(currency, store) }) : undefined}
      onOpenChange={onOpenChange} reapprove={reapprove} />
    {dialog}
  </>;
}

/**
 * Above the cart until a session is open: the picker while unbound, then the open card, with the cart still
 * usable below. RegisterColumn swaps the cart out wholesale, so it is used only for a non-conflict session, for
 * the count (RegisterCount, ADR 0018) while counting, and for its Finish closing card when a session closed but its
 * closure didn't finish. A close here shows the closure sheet.
 */
export function RegisterGate({ currency, online, refused, cartEmpty, openSaleCount, focus, children }: {
  currency: string; online: boolean; refused: string | null; cartEmpty: boolean; children: ReactNode;
  /** The till's open sales (the current one with lines, plus parked ones), warned of on the count; never a gate. */
  openSaleCount: number;
  /** A pill tap's request (`key`) and the last one handled, kept by the screen so a gate that mounts for it (a
   *  phone's cart view) still honours it. */
  focus: { key: number; handled: { current: number } };
}) {
  const { register, boundRegisterId, registers, bind, close } = useRegister();
  const { session: signedIn } = useSession();
  const pick = (id: string) => { bind(id).catch((error: unknown) => console.warn('Could not bind the register:', error)); };
  // A pill tap scrolls the gate into view and focuses its first control (web): for "Close not finished" (TallyUI
  // #175), the Finish closing button, even with the app's error line above it.
  const gate = useRef<View>(null);
  useEffect(() => {
    if (focus.handled.current === focus.key) return;
    focus.handled.current = focus.key;
    const node = gate.current as unknown as HTMLElement | null;
    node?.scrollIntoView?.({ block: 'nearest' });
    (node?.querySelector?.<HTMLElement>(`#${FINISH_CLOSE_BUTTON}`) ?? node?.querySelector?.<HTMLElement>('input, [role="button"]'))?.focus();
  }, [focus.key, focus.handled]);
  const { approve, dialog } = useApprove(signedIn?.baseUrl ?? '', online);
  const session = register.session;
  // ADR 0023: store-verified at register contract 3 with the store's registerApproval while the store holds the
  // session; otherwise ADR 0018's second login, with no proof.
  const capabilities = signedIn?.capabilities;
  const storeVerified = (capabilities?.register ?? 0) >= 3 && capabilities?.registerApproval != null && register.liveAtStore;
  const approveCount = ({ counted }: { counted: Record<string, number> }) => approve(storeVerified && signedIn && session
    ? storeApproval(signedIn.baseUrl, signedIn.token, session.id, () => register.actions.closureVariance(counted)) : undefined);
  // Both closes go through the provider's close flow, so its sheet and masking outlive this gate (a phone's cart view).
  const counting = { ...register, actions: { ...register.actions, closeSession: (input: CloseInput) => close.run(input, true) } };
  // A session closed but whose closure didn't finish (a restart mid-close, #88 review) gets RegisterColumn's own
  // Finish closing card (TallyUI #174), which resumes with the count and approver stored on the session. During a
  // close (`register.closing`, TallyUI #175) the column keeps the count instead, so the card never flashes.
  const column = { ...register, actions: { ...register.actions, closeSession: (input: CloseInput) => close.run(input, false) } };
  const openCarts = openCartsWarning(openSaleCount);
  return <View ref={gate} className="flex-1">
    {boundRegisterId === null ? <RegisterPicker registers={registers} onPick={pick} /> : null}
    {boundRegisterId && !session ? <OpenRegisterCard register={register} currency={currency} /> : null}
    {session?.status === 'conflict' ? <RegisterConflictCard /> : null}
    {refused ? <Text accessibilityRole="alert" className="px-3 py-2 text-destructive">{refused}</Text> : null}
    {/* Why the count's own close failed, above the Finish closing card (which shows only its own run's error). */}
    {session?.status === 'closed' && !register.closing && close.error
      ? <Text testID="close-error" accessibilityRole="alert" className="px-4 pt-3 text-destructive">{close.error}</Text> : null}
    {boundRegisterId && session && session.status !== 'conflict' ? <RegisterColumn register={column} registerId={boundRegisterId} registers={registers}
      onPick={pick} currency={currency} cartEmpty={cartEmpty}
      countSlot={<View className="flex-1">
        {/* mx-4 lines up with the count's own p-4 content. */}
        {openCarts ? <View testID="count-open-carts" accessibilityRole="alert"
          className="mx-4 mt-3 flex-row items-center gap-2 rounded-md border border-warning bg-warning/15 px-3 py-2">
          <WarningIcon size={16} />
          <Text className="flex-1 text-sm text-foreground">{openCarts}</Text>
        </View> : null}
        <RegisterCount register={counting} currency={currency} approve={approveCount} />
      </View>}>
      {children}
    </RegisterColumn> : children}
    {dialog}
  </View>;
}

/**
 * TallyUI's ClosureSheet for the closure a close through the app resolved with (it shows "Approved by …" itself,
 * #174), until Done. Mounted by the sale screen, not the gate, so a phone's cart view closing doesn't lose it.
 * On the web it passes `onPrint`, which prints the Z report.
 */
export function RegisterClosedSheet({ currency, store }: { currency: string; store: { name: string; address?: string } }) {
  const { register, close } = useRegister();
  if (!close.shown || register.lastClosure?.id !== close.shown) return null;
  const closure = register.lastClosure;
  return <ClosureSheet register={register} currency={currency} onDone={close.dismiss}
    onPrint={Platform.OS === 'web' ? () => printClosure(closure, currency, store) : undefined} />;
}
