import { Platform, Pressable, Text } from 'react-native';
import * as Linking from 'expo-linking';
import { Redirect, Stack } from 'expo-router';
import { OrdersList } from '@tallyui/components';
import { version as appVersion } from '../package.json';
import { feedbackUrl } from '../lib/feedback-url';
import { useOutboxContext } from '../lib/outbox-context';
import { useSession } from '../lib/session-context';
import { formatDate } from '../lib/format-date';

export default function OrdersScreen() {
  const { session } = useSession();
  const { recent, requeue } = useOutboxContext();
  if (!session) return <Redirect href="/login" />;
  return <>
    <Stack.Screen options={{ title: 'Orders' }} />
    <OrdersList orders={recent} onRetry={requeue} formatDate={formatDate} footer={
      <Pressable accessibilityRole="link" onPress={() => { void Linking.openURL(feedbackUrl({
        appVersion, platform: Platform.OS,
        userAgent: Platform.OS === 'web' ? navigator.userAgent : undefined,
        backendUrl: session.baseUrl,
      })); }}>
        <Text className="text-center text-sm text-muted-foreground">Send feedback</Text>
      </Pressable>
    } />
  </>;
}
