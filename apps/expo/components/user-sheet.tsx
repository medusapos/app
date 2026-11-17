import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Path } from 'react-native-svg';
import { Button, createSvgIcon, Dialog, DialogContent, DialogTitle, SwitchConfirm, Text, type SalesFilters } from '@tallyui/components';
import { formatMoney } from '@tallyui/core';
import { formatClosureDate, presetRange, switchWarnings, watchFresh, type PosOrder, type SwitchWarningInput } from '@tallyui/pos';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { localDayStartIso, salesRoomFigures } from '../lib/reports';
import type { Session } from '../lib/session';
import { closureContext } from './register-close';

const ExternalLinkIcon = createSvgIcon('ExternalLinkIcon', () => <><Path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6" />
  <Path d="M11 13l9 -9" /><Path d="M15 4h5v5" /></>);
const SIGN_OUT_LOCKED_ID = 'sign-out-locked';
// Read by assistive tech as Sign out's description, out of the layout, so the sheet never shifts.
const VISUALLY_HIDDEN = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 } as const;

export function UserSheet({ session, displayName, initials, storeName, currency, open, onOpenChange, onRegister, onChooseRegister, signOut, signOutLocked, lockMessage, outbox, parkedSales, paidMinor }: {
  session: Session; displayName: string; initials: string; storeName: string; currency: string;
  open: boolean; onOpenChange: (open: boolean) => void; onRegister: () => void; onChooseRegister: () => void;
  signOut: () => void; signOutLocked: boolean; lockMessage: string;
  outbox: SwitchWarningInput['outbox']; parkedSales: number; paidMinor: number;
}) {
  const { register, registerName, boundRegisterId, unbind } = useRegister();
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
  const openedBy = register.session?.opened_by;
  // opened_by is the opener's cashier id, which this app records as the cashier's email.
  const opener = !openedBy ? null : openedBy === session.email ? displayName : openedBy;
  // The signed-in cashier's own sales: the app records every local order with cashierRef = session.email.
  const totals = salesRoomFigures(sales.filter((order) => order.cashierRef === session.email), filters, currency).figures.totals;
  return <><Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent side="right" testID="user-sheet" className="flex-col gap-4">
      <View className="flex-row items-center gap-2">
        <View className="h-10 w-10 items-center justify-center rounded-full bg-muted"><Text>{initials}</Text></View>
        <View className="min-w-0 flex-1 gap-2">
          <DialogTitle testID="user-sheet-name">{displayName}</DialogTitle>
          <Text testID="user-sheet-context" className="text-muted-foreground">
            {[session.email !== displayName && session.email, storeName, registerName, since && `since ${since}`].filter(Boolean).join(' · ')}
          </Text>
        </View>
      </View>
      {orders && <View testID="user-sheet-sales-today" className="flex-row items-center justify-between gap-2">
        <View>
          <Text className="text-muted-foreground">Your sales today</Text>
          <Text testID="user-sheet-sales-count" className="text-sm text-muted-foreground">{totals.orderCount === 1 ? '1 sale' : `${totals.orderCount} sales`}</Text>
        </View>
        <Text className="font-semibold tabular-nums">{formatMoney({ amount: totals.grossMinor, currency })}</Text>
      </View>}
      {drawerOpen && <View testID="user-sheet-drawer" className="gap-2 rounded-md border border-border p-3">
        <Text>In the drawer</Text>
        {since && <Text testID="user-sheet-drawer-opened" className="text-sm text-muted-foreground">
          {[registerName, `opened ${since}${opener ? ` by ${opener}` : ''}`].filter(Boolean).join(' · ')}
        </Text>}
        {!register.blind && <Text className="text-xl font-semibold tabular-nums">{formatMoney({ amount: register.expected.cash ?? 0, currency })}</Text>}
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
        onPress={() => {
          const url = `${session.baseUrl}/app`;
          if (Platform.OS === 'web') window.open(url, '_blank', 'noopener,noreferrer');
          else void import('expo-linking').then((Linking) => Linking.openURL(url))
            .catch((error) => console.warn('Failed to open admin URL:', error));
        }}><ExternalLinkIcon size={14} /><Text className="text-sm text-muted-foreground">Medusa Admin</Text></Pressable>
      <View className="flex-row justify-between gap-2 border-t border-border pt-4">
        <Button testID="user-sheet-sign-out" variant="outline" className="min-h-11" accessibilityLabel="Sign out"
          disabled={signOutLocked} accessibilityHint={signOutLocked ? lockMessage : undefined}
          aria-describedby={signOutLocked ? SIGN_OUT_LOCKED_ID : undefined}
          onPress={() => {
            if (signOutLocked) return;
            if (switchWarnings({ kind: 'signOut', ...warningInput }).warnings.length === 0) signOut();
            else { onOpenChange(false); setConfirm('signOut'); }
          }}>
          <Text className="text-destructive">Sign out</Text>
        </Button>
        {signOutLocked ? <Text nativeID={SIGN_OUT_LOCKED_ID} style={VISUALLY_HIDDEN}>{lockMessage}</Text> : null}
        <Button testID="user-sheet-close" variant="outline" className="min-h-11" onPress={() => onOpenChange(false)}><Text>Close</Text></Button>
      </View>
      </View>
    </DialogContent>
  </Dialog>
    {confirm && !signOutLocked && <SwitchConfirm kind={confirm} warnings={switchWarnings({ kind: confirm, ...warningInput })}
      targetName="the next cashier" registerName={registerName || undefined}
      amount={confirm === 'signOut' && !register.blind ? formatMoney({ amount: register.expected.cash ?? 0, currency }) : undefined}
      onConfirm={signOut} onCancel={() => setConfirm(null)}
      onCloseRegister={confirm === 'signOut' ? () => { setConfirm(null); onRegister(); } : undefined} />}
  </>;
}
