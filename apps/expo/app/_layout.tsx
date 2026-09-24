import '../global.css';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Uniwind, useCSSVariable } from 'uniwind';
import { SessionProvider } from '../lib/session-context';
import { OutboxProvider } from '../lib/outbox-context';
import { SignInAgain } from '../components/sign-in-again';

// The POS ships the light theme; no dark design yet.
Uniwind.setTheme('light');

export default function RootLayout() {
  const card = useCSSVariable('--color-card');
  const foreground = useCSSVariable('--color-foreground');
  const background = useCSSVariable('--color-background');
  return (
    <SessionProvider>
      <StatusBar style="dark" />
      <OutboxProvider><Stack
        screenLayout={({ children, options }) => <SafeAreaView style={{ flex: 1 }}
          edges={options.headerShown === false ? ['top', 'left', 'right'] : ['left', 'right']}>
          <SignInAgain />{children}
        </SafeAreaView>}
        screenOptions={{
          headerStyle: { backgroundColor: card as string },
          headerTintColor: foreground as string,
          contentStyle: { backgroundColor: background as string },
          headerTitleStyle: { fontWeight: '600' },
        }}
      /></OutboxProvider>
    </SessionProvider>
  );
}
