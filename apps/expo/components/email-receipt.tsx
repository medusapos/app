import { useState, type JSX } from 'react';
import { View } from 'react-native';
import { Button, Dialog, DialogContent, DialogFooter, DialogTitle, IconButton, Input, Label, Text, XIcon } from '@tallyui/components';
import { ConnectorUnauthorizedError, CustomerServiceError } from '@tallyui/core';
import { RECEIPT_EMAIL_FAILED } from '../lib/receipt-email';

/** The paid screen's "Email receipt" button, opening v2's Email Receipt dialog; a sent receipt is confirmed under it. */
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
  function openDialog() {
    setText(defaultEmail ?? '');
    setMessage(null);
    setSentTo(null);
    setOpen(true);
  }
  // While a send is in flight the dialog stays open, so its result always lands.
  function close() {
    if (!sending) setOpen(false);
  }
  async function submit() {
    const email = text.trim();
    if (!email || sending || !online || orderId === undefined) return;
    setSending(true);
    setMessage(null);
    try {
      await send(orderId, email);
      setSentTo(email);
      setOpen(false);
    } catch (error) {
      if (error instanceof ConnectorUnauthorizedError && error.code === 'unauthorized') onUnauthorized();
      setMessage(error instanceof CustomerServiceError ? error.message : RECEIPT_EMAIL_FAILED);
    } finally {
      setSending(false);
    }
  }
  return <View dataSet={{ print: 'hide' }} className="gap-2">
    <Button variant="outline" testID="receipt-email-open" onPress={openDialog}>
      <Text>Email receipt</Text>
    </Button>
    {sentTo !== null ? <Text accessibilityRole="alert">{`Receipt sent to ${sentTo}.`}</Text> : null}
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent testID="receipt-email-dialog" className="gap-4">
        <View className="flex-row items-center justify-between">
          <DialogTitle>Email Receipt</DialogTitle>
          <IconButton testID="receipt-email-x" accessibilityLabel="Close" className="h-11 w-11" disabled={sending} onPress={close}>
            <View className="text-foreground"><XIcon size={24} /></View>
          </IconButton>
        </View>
        <View className="gap-2">
          <Label nativeID="receipt-email-label">Email Address</Label>
          <Input><Input.Field testID="receipt-email-field" value={text} onChangeText={setText} autoFocus
            accessibilityLabel="Email Address" accessibilityLabelledBy="receipt-email-label" keyboardType="email-address"
            autoCapitalize="none" autoComplete="email" onSubmitEditing={() => { void submit(); }} /></Input>
          {!online ? <Text className="text-muted-foreground">Connect to the store to email this receipt.</Text>
            : orderId === undefined ? <Text className="text-muted-foreground">You can email the receipt once this sale reaches the store.</Text> : null}
          {message !== null ? <Text className="text-destructive" accessibilityRole="alert">{message}</Text> : null}
        </View>
        <DialogFooter>
          <Button variant="outline" testID="receipt-email-cancel" disabled={sending} onPress={close}><Text>Cancel</Text></Button>
          <Button testID="receipt-email-send" disabled={!text.trim() || sending || !online || orderId === undefined}
            onPress={() => { void submit(); }}><Text>{sending ? 'Sending…' : 'Send'}</Text></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </View>;
}
