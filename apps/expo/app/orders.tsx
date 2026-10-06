import { Platform, Pressable, Text, View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { OrdersList } from '@tallyui/components';
import { ProductsBack } from '../components/products-back';
import { version as appVersion } from '../package.json';
import { feedbackUrl, openFeedbackUrl } from '../lib/feedback-url';
import { useOutboxContext } from '../lib/outbox-context';
import { useSession } from '../lib/session-context';
import { formatDate } from '../lib/format-date';

export default function OrdersScreen() {
  const { session } = useSession();
  const { recent, requeue } = useOutboxContext();
  if (!session) return <Redirect href="/login" />;
  return <>
    <Stack.Screen options={{ title: 'Orders', headerLeft: () => <ProductsBack /> }} />
    <OrdersList orders={recent} onRetry={requeue} formatDate={formatDate} footer={
      <View>
        {recent.length === 0 ? <Text className="text-center text-sm text-muted-foreground">No sales on this till yet. Completed sales show here.</Text> : null}
        <Pressable accessibilityRole="link" className="min-h-11 justify-center" onPress={() => { openFeedbackUrl(feedbackUrl({
          appVersion, platform: Platform.OS,
          userAgent: Platform.OS === 'web' ? navigator.userAgent : undefined,
          backendUrl: session.baseUrl,
        })); }}>
          <Text className="text-center text-sm text-muted-foreground">Send feedback</Text>
        </Pressable>
      </View>
    } />
  </>;
}
