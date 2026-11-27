import { useEffect, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { Button, Text } from '@tallyui/components';

type PrintStatus = 'idle' | 'printing' | 'failed';
type PrintJob = { status: PrintStatus; sequence: number; notify?: (status: PrintStatus) => void };
const autoPrintJobs = new WeakMap<Promise<void>, PrintJob>();

/**
 * v2's paid-screen footer bar along the bottom of the left pane: Email receipt, Print receipt, then New sale (primary);
 * screen only, not printed. A print that returns a promise (a thermal page through the print queue) holds Print until it
 * settles and says so when it fails; the plain window.print returns nothing and shows no status.
 * The latest print decides the status, and an auto-print job's status survives a remount.
 */
export function PaidFooter({ emailReceipt, print, autoPrint, newSale, doneLabel = 'New sale' }: {
  emailReceipt?: ReactNode;
  print: () => void | Promise<void>;
  autoPrint?: Promise<void> | null;
  newSale: () => void;
  doneLabel?: string;
}) {
  const [status, setStatus] = useState<PrintStatus>('idle');
  const job = useRef<PrintJob>({ status: 'idle', sequence: 0 });
  const trackPrint = (result: void | Promise<void>) => {
    const current = job.current;
    const sequence = ++current.sequence;
    const report = (next: PrintStatus) => {
      if (sequence !== current.sequence) return;
      current.status = next;
      current.notify?.(next);
    };
    if (!(result instanceof Promise)) { report('idle'); return; }
    report('printing');
    result.then(() => report('idle'), () => report('failed'));
  };
  useEffect(() => {
    const previous = autoPrint && autoPrintJobs.get(autoPrint);
    const current: PrintJob = previous || { status: 'idle', sequence: 0 };
    job.current = current;
    current.notify = setStatus;
    if (autoPrint && !previous) {
      autoPrintJobs.set(autoPrint, current);
      trackPrint(autoPrint);
    } else setStatus(current.status);
    return () => { current.notify = undefined; };
  }, [autoPrint]);
  return <View testID="paid-footer" dataSet={{ print: 'hide' }}
    className="flex-row flex-wrap items-start gap-3 border-t border-border bg-card p-4">
    {emailReceipt}
    <Button variant="outline" testID="paid-print" disabled={status === 'printing'} onPress={() => trackPrint(print())}>
      <Text>Print receipt</Text>
    </Button>
    <Button testID="paid-new-sale" onPress={newSale}><Text>{doneLabel}</Text></Button>
    {status === 'failed' ? <Text testID="paid-print-status" className="w-full text-sm text-destructive">Couldn't print. Try again.</Text> : null}
  </View>;
}
