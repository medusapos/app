import { Pressable, View } from 'react-native';
import { Button, describeRegisterBarPill, Text } from '@tallyui/components';
import type { useRegisterSession } from '@tallyui/pos';
import { useRegister } from '../lib/register-context';

export type WideRegisterState = 'Choose register' | 'Closed' | 'Counting' | 'Close not finished' | 'Offline' | 'Approval needed' | 'Overdue';

// v2's header state: an amber dot and the register's state, wide beside the store and register (row 09a.3), on a phone
// before the avatar (row 17a.2). Plain dot and text, no pill. A phone has no other register row, so this is its way to
// the gate and, while open, the panel.
export function HeaderRegisterState({ label, salesToSend, onPress }: { label: WideRegisterState; salesToSend?: number; onPress: () => void }) {
  const text = headerStateText(label, salesToSend);
  return <Pressable testID="header-register-state" accessibilityRole="button"
    accessibilityLabel={label === 'Choose register' ? text : `Register: ${text}`} onPress={onPress}
    className="min-h-11 shrink-0 flex-row pl-3 items-center gap-2">
    <View className="h-2 w-2 rounded-full bg-warning" />
    <Text numberOfLines={1} className="shrink-0 text-sm text-foreground">{text}</Text>
  </Pressable>;
}

/** The header state's words: offline, the sales waiting in the outbox follow ("Offline · 2 sales to send"). */
export function headerStateText(label: WideRegisterState, salesToSend = 0): string {
  if (label !== 'Offline' || salesToSend <= 0) return label;
  return `Offline · ${salesToSend} ${salesToSend === 1 ? 'sale' : 'sales'} to send`;
}

/** TallyUI RegisterBar's pill for this till, in v2's header wording ("Choose register", "Closed"); the phone header's too. */
export function wideRegisterState(boundRegisterId: string | null | undefined, online: boolean,
  register: Pick<ReturnType<typeof useRegisterSession>, 'session' | 'overdue' | 'enabled' | 'closing'>): WideRegisterState | null {
  if (boundRegisterId === undefined) return null;
  const { session, overdue, enabled, closing } = register;
  const pill = describeRegisterBarPill({ registerId: boundRegisterId, online, sessionStatus: session?.status ?? null, overdue,
    approvalRequired: session?.approval_required, sessionsOn: enabled, closing });
  return pill === 'Choose a register' ? 'Choose register' : pill === 'Register closed' ? 'Closed' : pill;
}

export function WideHeaderRegister({ online, salesToSend, onOpenPanel, onGate }:
  { online: boolean; salesToSend?: number; onOpenPanel: () => void; onGate: () => void }) {
  const { register, boundRegisterId } = useRegister();
  if (boundRegisterId === undefined) return null;
  const label = wideRegisterState(boundRegisterId, online, register);
  // v2's wide header (row 09a.3): the state right after "Store · Register", "Register ›" before the avatar.
  return <View testID="wide-header-register" className="min-w-0 flex-1 flex-row items-center">
    {label && <HeaderRegisterState label={label} salesToSend={salesToSend} onPress={register.session?.status === 'open' ? onOpenPanel : onGate} />}
    <View className="flex-1" />
    {(register.session || register.lastClosure) && <Button variant="ghost" size="sm" testID="register-bar-open-panel"
      accessibilityLabel="Open register panel" onPress={register.session?.status === 'conflict' ? onGate : onOpenPanel}>
      <Text className={register.overdue ? 'text-warning' : undefined}>Register ›</Text>
    </Button>}
  </View>;
}
