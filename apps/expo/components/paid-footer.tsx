import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { Button, Text } from '@tallyui/components';

type PrintStatus = 'idle' | 'printing' | 'failed';

/**
 * v2's paid-screen footer bar along the bottom of the left pane: Email receipt, Print receipt, then New sale (primary);
 * screen only, not printed. A print that returns a promise (a thermal page through the print queue) holds Print until it
 * settles and says so when it fails; the plain window.print returns nothing and shows no status.
 */
export function PaidFooter({ emailReceipt, print, newSale }: {
  emailReceipt?: ReactNode;
  print: () => void | Promise<void>;
  newSale: () => void;
}) {
  const [status, setStatus] = useState<PrintStatus>('idle');
  const onPrint = () => {
    const result = print();
    if (!(result instanceof Promise)) { setStatus('idle'); return; }
    setStatus('printing');
    result.then(() => setStatus('idle'), () => setStatus('failed'));
  };
  return <View testID="paid-footer" dataSet={{ print: 'hide' }}
    className="flex-row flex-wrap items-start gap-3 border-t border-border bg-card p-4">
    {emailReceipt}
    <Button variant="outline" testID="paid-print" disabled={status === 'printing'} onPress={onPrint}>
      <Text>Print receipt</Text>
    </Button>
    <Button testID="paid-new-sale" onPress={newSale}><Text>New sale</Text></Button>
    {status === 'failed' ? <Text testID="paid-print-status" className="w-full text-sm text-destructive">Couldn't print. Try again.</Text> : null}
  </View>;
}
