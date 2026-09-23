import '../global.css';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SessionProvider } from '../lib/session-context';
import { OutboxProvider } from '../lib/outbox-context';

export default function RootLayout() {
  return (
    <SessionProvider>
      <StatusBar style="dark" />
      <OutboxProvider><Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#f8f9fa' },
          headerTitleStyle: { fontWeight: '600' },
        }}
      /></OutboxProvider>
    </SessionProvider>
  );
}
