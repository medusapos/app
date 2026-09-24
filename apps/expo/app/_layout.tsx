import '../global.css';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Uniwind, useCSSVariable } from 'uniwind';
import { SessionProvider } from '../lib/session-context';
import { OutboxProvider } from '../lib/outbox-context';

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
