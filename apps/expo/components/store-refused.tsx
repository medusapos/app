import { createContext, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useOutboxContext } from '../lib/outbox-context';
import { useSession } from '../lib/session-context';
import { COLLAPSED_STRIP_HEIGHT, SignInAgain } from './sign-in-again';

export const StripHeightContext = createContext(0);

export function OutboxStrip({ children, header }: { children: ReactNode; header?: ComponentProps<typeof SignInAgain>['header'] }) {
  const { state } = useOutboxContext();
  const { session } = useSession();
  return <StripHeightContext.Provider value={!header && session && (state.authRequired || state.refused) ? COLLAPSED_STRIP_HEIGHT : 0}>
    <View style={{ flex: 1 }}>
      {children}
      {state.authRequired || !state.refused ? <SignInAgain header={header} />
        : <StoreRefused header={header} />}
    </View>
  </StripHeightContext.Provider>;
}

export function StoreRefused({ header }: ComponentProps<typeof SignInAgain>) {
  const { state, flush } = useOutboxContext();
  const [expanded, setExpanded] = useState(false);
  const visible = !!state.refused && !state.authRequired;
  const strip = useMemo(() => <View dataSet={{ print: 'hide' }} className="flex-row items-center gap-1">
    <Text numberOfLines={1} className="shrink text-foreground">{state.pending} {state.pending === 1 ? 'sale' : 'sales'} saved, not accepted by the store ·</Text>
    <Pressable accessibilityRole="button" onPress={() => setExpanded(true)}>
      <Text className="font-semibold text-primary">Details</Text>
    </Pressable>
  </View>, [state.pending]);
  useEffect(() => {
    if (!header) return;
    header.setOptions({ headerTitle: visible && !expanded ? () => strip : undefined });
    return () => header.setOptions({ headerTitle: undefined });
  }, [header, visible, expanded, strip]);
  if (!visible || (header && !expanded)) return null;
  return <View dataSet={{ print: 'hide' }} style={{ height: expanded ? undefined : COLLAPSED_STRIP_HEIGHT, position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 }}
    className="gap-2 border-b border-border bg-card px-4 py-3">
    {!expanded ? strip : <>
      <Text accessibilityRole="header" className="font-semibold text-foreground">Not accepted by the store</Text>
      <Text className="text-foreground">{state.pending === 1 ? '1 sale is' : `${state.pending} sales are`} kept on this register and have not been sent. The store said: {state.refused!.reason} (HTTP {state.refused!.status}).</Text>
      <Pressable accessibilityRole="button" disabled={state.sending} onPress={() => { void flush(); }}
        className={`rounded-md bg-primary px-4 py-2 ${state.sending ? 'opacity-50' : ''}`}>
        <Text className="text-center font-semibold text-primary-foreground">Try again</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => setExpanded(false)}>
        <Text className="text-center text-primary">Later</Text>
      </Pressable>
    </>}
  </View>;
}
