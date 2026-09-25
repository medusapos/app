import '../global.css';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Uniwind, useCSSVariable } from 'uniwind';
import { LiveTabGate } from '../components/live-tab-gate';
import { StorageHealth } from '../components/storage-health';
import { SessionProvider, useSession } from '../lib/session-context';
import { OutboxProvider } from '../lib/outbox-context';
import { OutboxStrip } from '../components/store-refused';

// The POS ships the light theme; no dark design yet.
Uniwind.setTheme('light');

// Needs SessionProvider above it, so it is its own component under RootLayout.
function GatedApp() {
  const { session } = useSession();
  const card = useCSSVariable('--color-card');
  const foreground = useCSSVariable('--color-foreground');
  const background = useCSSVariable('--color-background');
  return (
    <LiveTabGate scope={session?.baseUrl}>
      <StorageHealth><OutboxProvider><Stack
        screenLayout={({ children, options, navigation }) => <SafeAreaView style={{ flex: 1 }}
          edges={options.headerShown === false ? ['top', 'left', 'right'] : ['left', 'right']}>
          <OutboxStrip header={options.headerShown === false ? undefined : navigation}>{children}</OutboxStrip>
        </SafeAreaView>}
        screenOptions={{
          headerStyle: { backgroundColor: card as string },
          headerTintColor: foreground as string,
          contentStyle: { backgroundColor: background as string },
          headerTitleStyle: { fontWeight: '600' },
        }}
      /></OutboxProvider></StorageHealth>
    </LiveTabGate>
  );
}

export default function RootLayout() {
  return (
    <SessionProvider>
      <StatusBar style="dark" />
      <GatedApp />
    </SessionProvider>
  );
}
