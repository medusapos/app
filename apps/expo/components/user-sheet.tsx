import { useEffect, useMemo, useState } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { Avatar, avatarInitials, Button, Dialog, DialogContent, DialogTitle, IconButton, SwitchConfirm, Text, XIcon, type SalesFilters } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import { formatClosureDate, presetRange, switchWarnings, watchFresh, type PosOrder, type SwitchWarningInput } from '@tallyui/pos';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { medusaAdminUrl, openMedusaAdmin } from '../lib/medusa-admin';
import { localDayStartIso, salesRoomFigures } from '../lib/reports';
import { formatShiftDuration, SHIFT_TICK_MS } from '../lib/shift-duration';
import type { Session } from '../lib/session';
import { closureContext } from './register-close';
import { DrawerIcon } from './drawer-icon';
import { ExternalLinkIcon } from './external-link-icon';
import { WarningIcon } from './warning-icon';

const SIGN_OUT_LOCKED_ID = 'sign-out-locked';
// Read by assistive tech as Sign out's description, out of the layout, so the sheet never shifts.
const VISUALLY_HIDDEN = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 } as const;
// ADR 0009: phone mode below 600 px.
const PHONE_BREAKPOINT = 600;

export function UserSheet({ session, displayName, initials, storeName, currency, open, onOpenChange, onRegister, onChooseRegister, signOut, signOutLocked, lockMessage, outbox, parkedSales, paidMinor }: {
  session: Session; displayName: string; initials: string; storeName: string; currency: string;
  open: boolean; onOpenChange: (open: boolean) => void; onRegister: () => void; onChooseRegister: () => void;
  signOut: () => void; signOutLocked: boolean; lockMessage: string;
  outbox: SwitchWarningInput['outbox']; parkedSales: number; paidMinor: number;
}) {
  const { register, registerName, boundRegisterId, unbind } = useRegister();
  const phone = useWindowDimensions().width < PHONE_BREAKPOINT;
  // Any session, even a closed one with an unfinished closure: unbinding would strand it.
  const sessionExists = register.session != null;
  const { orders } = useOutboxContext();
  const [sales, setSales] = useState<PosOrder[]>([]);
  const filters = useMemo<SalesFilters>(() => ({
    preset: 'today', range: presetRange('today', new Date(), 'device'), compare: 'previous',
    // The local outbox holds only this till's sales, recorded under the device id, not the bound register's id.
    status: 'all', cashierId: null, registerId: null,
  }), [open]);
  useEffect(() => {
    if (!open || !orders) return;
    const subscription = watchFresh(orders, { selector: { createdAt: { $gte: localDayStartIso(filters.range.from) } } }).subscribe(setSales);
    return () => subscription.unsubscribe();
  }, [open, orders, filters]);
  const [confirm, setConfirm] = useState<'signOut' | 'cashier' | null>(null);
  const warningInput = { outbox, parkedSales, paidMinor, sessionStatus: register.session?.status };
  const drawerOpen = register.session?.status === 'open' || register.session?.status === 'counting';
  // Only while shown: closureContext reads the device locale.
  const since = open && drawerOpen && register.session
    ? formatClosureDate(register.session.opened_at_gmt, closureContext(currency, { name: storeName })).time : null;
  // The shift duration ticks only while the sheet shows it.
  const ticking = open && drawerOpen;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), SHIFT_TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);
  const duration = since && register.session ? formatShiftDuration(register.session.opened_at_gmt, now) : null;
  const openedBy = register.session?.opened_by;
  // opened_by is the opener's cashier id, which this app records as the cashier's email.
  const opener = !openedBy ? null : openedBy === session.email ? displayName : openedBy;
  // The signed-in cashier's own sales: the app records every local order with cashierRef = session.email.
  const totals = salesRoomFigures(sales.filter((order) => order.cashierRef === session.email), filters, currency).figures.totals;
  // On a phone, as v2: Close on top and Sign out under it, both full width; from 600 px Sign out left, Close right.
  const close = <Button testID="user-sheet-close" variant="outline" className={phone ? 'min-h-11 w-full' : 'min-h-11'}
    onPress={() => onOpenChange(false)}><Text>Close</Text></Button>;
  return <><Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent side="right" testID="user-sheet" className="flex-col gap-4">
      {/* As v2: the avatar beside the name and the ✕ at the top right, both on the first line, not centred on the block. */}
      <View className="flex-row items-start gap-2">
        <Avatar testID="user-sheet-avatar" aria-hidden size="sm" tone="primary" fallback={initials} />
        <View className="min-w-0 flex-1 gap-2">
          <DialogTitle testID="user-sheet-name">{displayName}</DialogTitle>
          <Text testID="user-sheet-context" className="text-muted-foreground">
            {[session.email !== displayName && session.email, storeName, registerName, since && `since ${since}`, duration].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <IconButton testID="user-sheet-x" accessibilityLabel="Close" className="h-11 w-11" onPress={() => onOpenChange(false)}>
          <View className="text-foreground"><XIcon size={24} /></View>
        </IconButton>
      </View>
      {orders && <View testID="user-sheet-sales-today" className="flex-row items-center justify-between gap-2">
        <View>
          <Text className="text-muted-foreground">Your sales today</Text>
          <Text testID="user-sheet-sales-count" className="text-sm text-muted-foreground">{totals.orderCount === 1 ? '1 sale' : `${totals.orderCount} sales`}</Text>
        </View>
        <Text className="font-semibold tabular-nums">{formatMoney({ amount: totals.grossMinor, currency })}</Text>
      </View>}
      {drawerOpen && <View testID="user-sheet-drawer" className="gap-2 rounded-md border border-border p-3">
        {/* As v2: the cash badge, the label over the opened line, and the amount at the row's end. */}
        <View className="flex-row items-center gap-3">
          <View testID="user-sheet-drawer-icon" aria-hidden className="h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <DrawerIcon size={20} />
          </View>
          <View className="min-w-0 flex-1 gap-1">
            <Text className="text-sm text-muted-foreground">In the drawer</Text>
            {since && <View className="flex-row items-center gap-2">
              <Text testID="user-sheet-drawer-opened" className="text-sm text-muted-foreground">
                {[registerName, `opened ${since}${opener ? ` by ${opener}` : ''}`].filter(Boolean).join(' · ')}
              </Text>
              {opener && <Avatar testID="user-sheet-drawer-opener-avatar" aria-hidden size="sm" tone="primary" fallback={avatarInitials(opener)} />}
            </View>}
          </View>
          {!register.blind && <Text className="text-xl font-semibold tabular-nums">{formatMoney({ amount: register.expected.cash ?? 0, currency })}</Text>}
        </View>
        <Pressable testID="user-sheet-register" accessibilityRole="button" className="min-h-11 flex-row items-center justify-between gap-2"
          onPress={() => { onOpenChange(false); onRegister(); }}>
          <Text>Pay in · Pay out · Close register</Text><Text>›</Text>
        </Pressable>
        <Pressable testID="user-sheet-handover" accessibilityRole="button" className="min-h-11 flex-row items-center justify-between gap-2"
          disabled={signOutLocked} accessibilityHint={signOutLocked ? lockMessage : undefined}
          onPress={() => { if (!signOutLocked) { onOpenChange(false); setConfirm('cashier'); } }}>
          <Text>Hand the till to the next cashier</Text><Text>›</Text>
        </Pressable>
      </View>}
      {/* As v2 offline: the till's unsent sales (stuck ones included), never till updates or rejected sales. */}
      {outbox.sales.pending > 0 && <View testID="user-sheet-awaiting" className="flex-row items-start gap-2 rounded-md border border-warning bg-warning/15 p-3">
        <View className="text-foreground"><WarningIcon size={16} /></View>
        <View className="min-w-0 flex-1">
          <Text testID="user-sheet-awaiting-title" className="font-semibold">
            {outbox.sales.pending === 1 ? 'Awaiting store · 1 sale' : `Awaiting store · ${outbox.sales.pending} sales`}
          </Text>
          <Text className="text-sm text-muted-foreground">Sent when you are signed in online</Text>
        </View>
      </View>}
      {boundRegisterId ? <View testID="user-sheet-register-row">
        <View className="min-h-11 flex-row items-center gap-2">
          <Text className="w-32 text-sm text-muted-foreground">Register</Text>
          <Text testID="user-sheet-register-name" className="min-w-0 flex-1" numberOfLines={1}>{registerName ?? boundRegisterId}</Text>
          <Button testID="user-sheet-register-switch" variant="link" accessibilityLabel="Switch register" disabled={sessionExists}
            accessibilityHint={sessionExists ? 'Close the register first' : undefined}
            onPress={() => {
              if (sessionExists) return;
              onOpenChange(false);
              unbind().then(onChooseRegister, (error) => console.warn('Could not unbind the register:', error));
            }}><Text>Switch</Text></Button>
        </View>
        {/* Starts under the name: the label column (w-32) plus the line's gap-2. */}
        {sessionExists && <Text testID="user-sheet-register-locked" className="ml-34 text-sm text-muted-foreground">Close the register first</Text>}
      </View> : null}
      <View className="mt-auto border-t border-border">
      <Pressable testID="user-sheet-admin" accessibilityRole="link" className="min-h-11 flex-row items-center gap-2 text-muted-foreground"
        onPress={() => openMedusaAdmin(medusaAdminUrl(session.baseUrl))}><ExternalLinkIcon size={14} /><Text className="text-sm text-muted-foreground">Medusa Admin</Text></Pressable>
      <View testID="user-sheet-footer" dataSet={{ layout: phone ? 'stacked' : 'row' }}
        className={(phone ? 'flex-col' : 'flex-row justify-between') + ' gap-2 border-t border-border pt-4'}>
        {phone && close}
        <Button testID="user-sheet-sign-out" variant="outline" className={phone ? 'min-h-11 w-full border-destructive' : 'min-h-11'} accessibilityLabel="Sign out"
          disabled={signOutLocked} accessibilityHint={signOutLocked ? lockMessage : undefined}
          aria-describedby={signOutLocked ? SIGN_OUT_LOCKED_ID : undefined}
          onPress={() => {
            if (signOutLocked) return;
            if (switchWarnings({ kind: 'signOut', ...warningInput }).warnings.length === 0) signOut();
            // As v2: the confirm opens over the sheet, so Cancel returns to it.
            else setConfirm('signOut');
          }}>
          <Text className="text-destructive">Sign out</Text>
        </Button>
        {signOutLocked ? <Text nativeID={SIGN_OUT_LOCKED_ID} style={VISUALLY_HIDDEN}>{lockMessage}</Text> : null}
        {!phone && close}
      </View>
      </View>
    </DialogContent>
  </Dialog>
    {confirm && !signOutLocked && <SwitchConfirm kind={confirm} warnings={switchWarnings({ kind: confirm, ...warningInput })}
      targetName="the next cashier" registerName={registerName || undefined}
      amount={confirm === 'signOut' && !register.blind ? formatMoney({ amount: register.expected.cash ?? 0, currency }) : undefined}
      onConfirm={signOut} onCancel={() => setConfirm(null)}
      onCloseRegister={confirm === 'signOut' ? () => { setConfirm(null); onOpenChange(false); onRegister(); } : undefined} />}
  </>;
}
