import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { OpenRegisterCard, RegisterBar, RegisterColumn, RegisterCount, RegisterPanel, RegisterPicker } from '@tallyui/components';
import { RegisterSessionRequiredError, type useRegisterSession, type useSale } from '@tallyui/pos';
import { useRegister } from '../lib/register-context';
import { useSession } from '../lib/session-context';
import { FinishClose, LastClosureSheet, RegisterClosedSheet, useApprove } from './register-close';

type Register = ReturnType<typeof useRegisterSession>;

// The refusals at tender start (ADR 0017): paying needs an open register; browsing and the cart don't.
export const OPEN_TO_PAY = 'Open the register to take payment.';
// Before the order store opens (also the tender pane's wait for it).
export const GETTING_READY = 'Getting ready to save sales…';
export const CHECK_FAILED = "Couldn't check the register. Try again.";

type Sale = ReturnType<typeof useSale>;
// How long a confirmed session may take to reach the render before the tender start gives up (a second tap retries).
const PENDING_SESSION_MS = 3000;

/**
 * The sale the Cart gets: its Cash and Card start the tender only once `requireOpen()` confirms an open session
 * (TallyUI c1's gate at tender start; `complete()` stamps the session useSale pinned then, TallyUI #170). Also
 * reports the tender to the register.
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
  // useSale pins the RENDERED session at startTender (TallyUI #170), and requireOpen() reads storage, which can be
  // ahead of the render (a session just opened). So the tender starts only once the rendered session is the one
  // requireOpen() confirmed; until then it waits as `pending`, and taps stay ignored.
  const saleSessionId = register.saleSession?.id;
  const saleSessionRef = useRef(saleSessionId);
  saleSessionRef.current = saleSessionId;
  const [pending, setPending] = useState<{ method: 'cash' | 'external'; id: string } | null>(null);
  useEffect(() => {
    if (!pending) return;
    const settle = () => { setPending(null); checking.current = false; };
    if (saleSessionId === pending.id) {
      settle();
      if (latest.current.stage.kind === 'cart') latest.current.startTender(pending.method);
      return;
    }
    if (saleSessionId) return settle(); // Another session: drop it.
    const timer = setTimeout(() => { settle(); setRefused(CHECK_FAILED); }, PENDING_SESSION_MS);
    return () => clearTimeout(timer);
  }, [pending, saleSessionId]);
  const startTender = (method: 'cash' | 'external') => {
    if (checking.current) return;
    // Before the order store opens there is no session to check, nor one to stamp the sale with.
    if (!register.enabled) return setRefused(GETTING_READY);
    checking.current = true;
    // Resolves null only while sessions are off; then the tender starts as it did before registers.
    register.requireOpen().then((id) => {
      if (latest.current.stage.kind !== 'cart') { checking.current = false; return; }
      setRefused(null);
      if (id && saleSessionRef.current !== id) return setPending({ method, id });
      checking.current = false;
      latest.current.startTender(method);
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
 * the count (RegisterCount, ADR 0018) while counting. A close here shows the closure sheet; a session closed but
 * whose closure didn't finish offers Finish closing above the cart.
 */
export function RegisterGate({ currency, online, refused, cartEmpty, focus, children }: {
  currency: string; online: boolean; refused: string | null; cartEmpty: boolean; children: ReactNode;
  /** A pill tap's request (`key`) and the last one handled, kept by the screen so a gate that mounts for it (a
   *  phone's cart view) still honours it. */
  focus: { key: number; handled: { current: number } };
}) {
  const { register, boundRegisterId, registers, bind } = useRegister();
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
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState('');
  // The closure a close here resolved with: its sheet shows until Done.
  const [closed, setClosed] = useState<string | null>(null);
  const closeSession: Register['actions']['closeSession'] = async (input) => {
    setClosing(true);
    setCloseError('');
    try {
      const closure = await register.actions.closeSession(input);
      setClosed(closure.id);
      return closure;
    } catch (error) {
      setCloseError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setClosing(false);
    }
  };
  const counting = { ...register, actions: { ...register.actions, closeSession } };
  const session = register.session;
  return <View ref={gate} className="flex-1">
    {boundRegisterId === null ? <RegisterPicker registers={registers} onPick={pick} /> : null}
    {boundRegisterId && !session ? <OpenRegisterCard register={register} currency={currency} /> : null}
    {/* A resumed close keeps the count and approver already stored on the session (TallyUI's closeSession). */}
    {session?.status === 'closed' ? <FinishClose closing={closing} error={closeError}
      onFinish={() => { closeSession({ counted: session.counted ?? {} }).catch(() => {}); }} /> : null}
    {refused ? <Text accessibilityRole="alert" className="px-3 py-2 text-destructive">{refused}</Text> : null}
    {boundRegisterId && session ? <RegisterColumn register={register} registerId={boundRegisterId} registers={registers}
      onPick={pick} currency={currency} cartEmpty={cartEmpty}
      countSlot={<RegisterCount register={counting} currency={currency} approve={approve} />}>
      {children}
    </RegisterColumn> : children}
    {dialog}
    {closed && register.lastClosure?.id === closed
      ? <RegisterClosedSheet register={register} currency={currency} onDone={() => setClosed(null)} /> : null}
  </View>;
}
