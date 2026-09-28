import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import {
  ClosureSheet, OpenRegisterCard, RegisterBar, RegisterColumn, RegisterCount, RegisterPanel, RegisterPicker,
} from '@tallyui/components';
import { RegisterSessionRequiredError, type useRegisterSession, type useSale } from '@tallyui/pos';
import { useRegister } from '../lib/register-context';
import { useSession } from '../lib/session-context';
import { LastClosureSheet, useApprove } from './register-close';

type CloseInput = Parameters<ReturnType<typeof useRegisterSession>['actions']['closeSession']>[0];

// The refusals at tender start (ADR 0017): paying needs an open register; browsing and the cart don't.
export const OPEN_TO_PAY = 'Open the register to take payment.';
// Before the order store opens (also the tender pane's wait for it).
export const GETTING_READY = 'Getting ready to save sales…';
export const CHECK_FAILED = "Couldn't check the register. Try again.";

type Sale = ReturnType<typeof useSale>;

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

// RegisterBar inside an existing row (a phone's "‹ Products" row, Catalogue's status line): no strip of its own.
export const IN_ROW = 'h-auto border-b-0 bg-transparent px-0';

/**
 * TallyUI's RegisterBar for this till: the strip under the header when wide, or `IN_ROW` on a phone. Its pill is
 * never a dead label: with an open session it opens the panel; otherwise it brings up the gate (`onGate`), which
 * also holds the count and Finish closing.
 */
export function TillRegisterBar({ online, onOpenPanel, onGate, className }: {
  online: boolean; onOpenPanel: () => void; onGate: () => void; className?: string;
}) {
  const { register, boundRegisterId, registerName } = useRegister();
  if (boundRegisterId === undefined) return null;
  return <View dataSet={{ print: 'hide' }}>
    <RegisterBar register={register} registerId={boundRegisterId} online={online} registerName={registerName ?? undefined}
      multiRegister={false} onOpenPanel={onOpenPanel} onPressPill={register.session?.status === 'open' ? onOpenPanel : onGate} className={className} />
  </View>;
}

/** The register panel (movements with Undo, Close register), opened from the control; between sessions, the last closure's figures. */
export function RegisterPanelSheet({ currency, store, open, onOpenChange }: {
  currency: string; store: { name: string; address?: string }; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const { register, registerName } = useRegister();
  if (!register.session && register.lastClosure) {
    return <LastClosureSheet register={register} currency={currency} store={store} open={open} onOpenChange={onOpenChange} />;
  }
  return <RegisterPanel register={register} currency={currency} registerName={registerName ?? undefined} open={open}
    onOpenChange={onOpenChange} />;
}

/**
 * Above the cart until a session is open: the picker while unbound, then the open card, with the cart still
 * usable below. RegisterColumn swaps the cart out wholesale, so it is used only once a session exists, for
 * the count (RegisterCount, ADR 0018) while counting, and for its Finish closing card when a session closed but its
 * closure didn't finish. A close here shows the closure sheet.
 */
export function RegisterGate({ currency, online, refused, cartEmpty, focus, children }: {
  currency: string; online: boolean; refused: string | null; cartEmpty: boolean; children: ReactNode;
  /** A pill tap's request (`key`) and the last one handled, kept by the screen so a gate that mounts for it (a
   *  phone's cart view) still honours it. */
  focus: { key: number; handled: { current: number } };
}) {
  const { register, boundRegisterId, registers, bind, close } = useRegister();
  const { session: signedIn } = useSession();
  const pick = (id: string) => { bind(id).catch((error: unknown) => console.warn('Could not bind the register:', error)); };
  // A pill tap scrolls the gate into view and focuses its first control (web).
  const gate = useRef<View>(null);
  useEffect(() => {
    if (focus.handled.current === focus.key) return;
    focus.handled.current = focus.key;
    const node = gate.current as unknown as HTMLElement | null;
    node?.scrollIntoView?.({ block: 'nearest' });
    node?.querySelector?.<HTMLElement>('input, [role="button"]')?.focus();
  }, [focus.key, focus.handled]);
  const { approve, dialog } = useApprove(signedIn?.baseUrl ?? '', online);
  const session = register.session;
  // Both closes go through the provider's close flow, so its sheet and masking outlive this gate (a phone's cart view).
  const counting = { ...register, actions: { ...register.actions, closeSession: (input: CloseInput) => close.run(input, true) } };
  // A session closed but whose closure didn't finish (a restart mid-close, #88 review) gets RegisterColumn's own
  // Finish closing card (TallyUI #174), which resumes with the count and approver stored on the session. The count's
  // own close is masked: while its closure writes, and after it resolves until the session leaves the render, that
  // session is already `closed`, and the column keeps the count instead of flashing the card (whose button would
  // start a second close).
  const masked = session?.status === 'closed' && session.id === close.maskedSession;
  const column = { ...register, actions: { ...register.actions, closeSession: (input: CloseInput) => close.run(input, false) },
    session: masked ? { ...session, status: 'counting' as const } : session };
  return <View ref={gate} className="flex-1">
    {boundRegisterId === null ? <RegisterPicker registers={registers} onPick={pick} /> : null}
    {boundRegisterId && !session ? <OpenRegisterCard register={register} currency={currency} /> : null}
    {refused ? <Text accessibilityRole="alert" className="px-3 py-2 text-destructive">{refused}</Text> : null}
    {/* Why the last close failed, above the Finish closing card. */}
    {session?.status === 'closed' && !masked && close.error
      ? <Text testID="close-error" accessibilityRole="alert" className="px-4 pt-3 text-destructive">{close.error}</Text> : null}
    {boundRegisterId && session ? <RegisterColumn register={column} registerId={boundRegisterId} registers={registers}
      onPick={pick} currency={currency} cartEmpty={cartEmpty}
      countSlot={<RegisterCount register={counting} currency={currency} approve={approve} />}>
      {children}
    </RegisterColumn> : children}
    {dialog}
  </View>;
}

/**
 * TallyUI's ClosureSheet for the closure a close through the app resolved with (it shows "Approved by …" itself,
 * #174), until Done. Mounted by the sale screen, not the gate, so a phone's cart view closing doesn't lose it.
 */
export function RegisterClosedSheet({ currency }: { currency: string }) {
  const { register, close } = useRegister();
  if (!close.shown || register.lastClosure?.id !== close.shown) return null;
  return <ClosureSheet register={register} currency={currency} onDone={close.dismiss} />;
}
