import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { OpenRegisterCard, RegisterBar, RegisterColumn, RegisterPanel, RegisterPicker } from '@tallyui/components';
import { RegisterSessionRequiredError, type useRegisterSession, type useSale } from '@tallyui/pos';
import { useRegister } from '../lib/register-context';

// The refusal at tender start (ADR 0017): paying needs an open register; browsing and the cart don't.
export const OPEN_TO_PAY = 'Open the register to take payment.';

type Sale = ReturnType<typeof useSale>;

/**
 * The sale the Cart gets: its Cash and Card start the tender only once `requireOpen()` confirms an open session
 * (TallyUI c1's gate at tender start; `complete()` stamps the session). Also reports the tender to the register.
 */
export function useGatedSale(sale: Sale): { sale: Sale; refused: string | null } {
  const { register, setTenderInProgress } = useRegister();
  const latest = useRef(sale);
  latest.current = sale;
  const [refused, setRefused] = useState<string | null>(null);
  const open = register.session?.status === 'open';
  useEffect(() => { if (open) setRefused(null); }, [open]);
  const tender = sale.stage.kind === 'tender';
  useEffect(() => setTenderInProgress(tender), [tender, setTenderInProgress]);
  useEffect(() => () => setTenderInProgress(false), [setTenderInProgress]);
  const startTender = (method: 'cash' | 'external') => {
    // Before the order store opens there is no session to check, nor one to stamp the sale with.
    if (!register.enabled) return setRefused(OPEN_TO_PAY);
    // Resolves null only while sessions are off; then the tender starts as it did before registers.
    register.requireOpen().then(() => { setRefused(null); latest.current.startTender(method); },
      (error: unknown) => setRefused(error instanceof RegisterSessionRequiredError ? OPEN_TO_PAY : String(error)));
  };
  return { sale: { ...sale, startTender }, refused };
}

// RegisterBar inside an existing row (a phone's "‹ Products" row, Catalogue's status line): no strip of its own.
export const IN_ROW = 'h-auto border-b-0 bg-transparent px-0';

/**
 * TallyUI's RegisterBar for this till: the strip under the header when wide, or `IN_ROW` on a phone. Its pill is
 * never a dead label: without a session it brings up the gate (`onGate`), with one it opens the panel.
 */
export function TillRegisterBar({ online, onOpenPanel, onGate, className }: {
  online: boolean; onOpenPanel: () => void; onGate: () => void; className?: string;
}) {
  const { register, boundRegisterId, registerName } = useRegister();
  if (boundRegisterId === undefined) return null;
  return <View dataSet={{ print: 'hide' }}>
    <RegisterBar register={register} registerId={boundRegisterId} online={online} registerName={registerName ?? undefined}
      multiRegister={false} onOpenPanel={onOpenPanel} onPressPill={register.session ? onOpenPanel : onGate} className={className} />
  </View>;
}

/** The register panel (movements with Undo, Close register), opened from the control. */
export function RegisterPanelSheet({ currency, open, onOpenChange }: { currency: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { register, registerName } = useRegister();
  return <RegisterPanel register={register} currency={currency} registerName={registerName ?? undefined} open={open}
    onOpenChange={onOpenChange} />;
}

/**
 * Above the cart until a session is open: the picker while unbound, then the open card, with the cart still
 * usable below. RegisterColumn swaps the cart out wholesale, so it is used only once a session exists, for
 * the count slot while counting.
 */
export function RegisterGate({ currency, refused, cartEmpty, focusKey, children }: {
  currency: string; refused: string | null; cartEmpty: boolean; focusKey: number; children: ReactNode;
}) {
  const { register, boundRegisterId, registers, bind } = useRegister();
  const pick = (id: string) => { bind(id).catch((error: unknown) => console.warn('Could not bind the register:', error)); };
  // A pill tap (a new focusKey) scrolls the gate into view and focuses its first control (web).
  const gate = useRef<View>(null);
  const focused = useRef(focusKey);
  useEffect(() => {
    if (focused.current === focusKey) return;
    focused.current = focusKey;
    const node = gate.current as unknown as HTMLElement | null;
    node?.scrollIntoView?.({ block: 'nearest' });
    node?.querySelector?.<HTMLElement>('input, [role="button"]')?.focus();
  }, [focusKey]);
  return <View ref={gate} className="flex-1">
    {boundRegisterId === null ? <RegisterPicker registers={registers} onPick={pick} /> : null}
    {boundRegisterId && !register.session ? <OpenRegisterCard register={register} currency={currency} /> : null}
    {refused ? <Text accessibilityRole="alert" className="px-3 py-2 text-destructive">{refused}</Text> : null}
    {boundRegisterId && register.session ? <RegisterColumn register={register} registerId={boundRegisterId} registers={registers}
      onPick={pick} currency={currency} cartEmpty={cartEmpty} countSlot={<RegisterCountSlot register={register} />}>
      {children}
    </RegisterColumn> : children}
  </View>;
}

/** Job B's count UI goes here (RegisterColumn's `countSlot`); until it lands, counting can only go back to selling. */
export function RegisterCountSlot({ register }: { register: ReturnType<typeof useRegisterSession> }) {
  const [error, setError] = useState('');
  return <View className="flex-1 items-center justify-center gap-4 p-4">
    <Text className="text-foreground">Counting arrives in the next update.</Text>
    <Pressable accessibilityRole="button" onPress={() => { register.actions.backToSelling().catch((e: unknown) => setError(String(e))); }}
      className="min-h-11 justify-center rounded-md border border-border bg-card px-4 py-3">
      <Text className="text-center text-foreground">Back to selling</Text>
    </Pressable>
    {error ? <Text accessibilityRole="alert" className="text-destructive">{error}</Text> : null}
  </View>;
}
