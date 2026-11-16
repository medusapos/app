import { useState, type JSX } from 'react';
import { View } from 'react-native';
import { Button, Input, Text } from '@tallyui/components';
import { ConnectorUnauthorizedError, CustomerServiceError } from '@tallyui/core';
import { RECEIPT_EMAIL_FAILED } from '../lib/receipt-email';

export function EmailReceipt({ orderId, online, defaultEmail, send, onUnauthorized }: {
  orderId: string | undefined;
  online: boolean;
  defaultEmail?: string;
  send: (orderId: string, email: string) => Promise<void>;
  onUnauthorized: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(defaultEmail ?? '');
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function submit() {
    const email = text.trim();
    if (!email || sending || !online || orderId === undefined) return;
    setSending(true);
    setMessage(null);
    try {
      await send(orderId, email);
      setSentTo(email);
    } catch (error) {
      if (error instanceof ConnectorUnauthorizedError && error.code === 'unauthorized') onUnauthorized();
      setMessage(error instanceof CustomerServiceError ? error.message : RECEIPT_EMAIL_FAILED);
    } finally {
      setSending(false);
    }
  }
  return <View dataSet={{ print: 'hide' }} className="gap-2">
    {!open ? <Button variant="outline" testID="receipt-email-open" onPress={() => setOpen(true)}>
      <Text>Email receipt</Text>
    </Button> : sentTo !== null ? <>
      <Text accessibilityRole="alert">{`Receipt sent to ${sentTo}.`}</Text>
      <Button variant="link" onPress={() => { setSentTo(null); setText(''); }}>
        <Text>Send to another address</Text>
      </Button>
    </> : <>
      <View className="flex-row items-center gap-2">
        <Input className="flex-1"><Input.Field value={text} onChangeText={setText}
          accessibilityLabel="Receipt email address" placeholder="Email address" keyboardType="email-address"
          autoCapitalize="none" autoComplete="email" /></Input>
        <Button testID="receipt-email-send" disabled={!text.trim() || sending || !online || orderId === undefined}
          onPress={() => { void submit(); }}><Text>{sending ? 'Sending…' : 'Send'}</Text></Button>
      </View>
      {!online ? <Text className="text-muted-foreground">Connect to the store to email this receipt.</Text>
        : orderId === undefined ? <Text className="text-muted-foreground">You can email the receipt once this sale reaches the store.</Text> : null}
      {message !== null ? <Text className="text-destructive" accessibilityRole="alert">{message}</Text> : null}
    </>}
  </View>;
}
