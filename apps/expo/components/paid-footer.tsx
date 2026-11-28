import { useEffect, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { Button, Text } from '@tallyui/components';
import type { PrinterProfile } from '@tallyui/pos';
import { printerLabel } from './receipt-pickers';

type PrintStatus = 'idle' | 'printing' | 'failed' | 'done';
type PrintJob = { status: PrintStatus; printed: boolean; sequence: number; notify?: () => void };
const autoPrintJobs = new WeakMap<Promise<void>, PrintJob>();

export function paidPrintedLabel(networkPrinter: PrinterProfile | undefined, os: string): string | undefined {
  if (networkPrinter) return `Printed to ${printerLabel(networkPrinter)}`;
  return os === 'web' ? 'Sent to the print dialog' : undefined;
}

/**
 * v2's paid-screen footer bar along the bottom of the left pane: Email receipt, Print receipt, then New sale (primary);
 * screen only, not printed. A print that returns a promise (a thermal page through the print queue) holds Print until it
 * settles and says so when it fails; a successful print shows its destination when a label is provided.
 * The latest print decides the status, and an auto-print job's status survives a remount.
 */
export function PaidFooter({ emailReceipt, notice, print, autoPrint, printedLabel, newSale, doneLabel = 'New sale' }: {
  emailReceipt?: ReactNode;
  notice?: ReactNode;
  print: () => void | Promise<void>;
  autoPrint?: Promise<void> | null;
  printedLabel?: string;
  newSale: () => void;
  doneLabel?: string;
}) {
  const [status, setStatus] = useState<PrintStatus>('idle');
  const [printed, setPrinted] = useState(false);
  const job = useRef<PrintJob>({ status: 'idle', printed: false, sequence: 0 });
  const trackPrint = (result: void | Promise<void>) => {
    const current = job.current;
    const sequence = ++current.sequence;
    const report = (next: PrintStatus) => {
      if (sequence !== current.sequence) return;
      current.status = next;
      if (next === 'done') current.printed = true;
      current.notify?.();
    };
    if (!(result instanceof Promise)) { report('done'); return; }
    report('printing');
    result.then(() => report('done'), () => report('failed'));
  };
  useEffect(() => {
    const previous = autoPrint && autoPrintJobs.get(autoPrint);
    const current: PrintJob = previous || { status: 'idle', printed: false, sequence: 0 };
    job.current = current;
    current.notify = () => { setStatus(current.status); setPrinted(current.printed); };
    if (autoPrint && !previous) {
      autoPrintJobs.set(autoPrint, current);
      trackPrint(autoPrint);
    } else current.notify();
    return () => { current.notify = undefined; };
  }, [autoPrint]);
  return <View testID="paid-footer" dataSet={{ print: 'hide' }}
    className="flex-row flex-wrap items-start gap-3 border-t border-border bg-card p-4">
    {emailReceipt}
    <Button variant="outline" testID="paid-print" disabled={status === 'printing'} onPress={() => trackPrint(print())}>
      <Text>{printedLabel && printed ? 'Print again' : 'Print receipt'}</Text>
    </Button>
    <Button testID="paid-new-sale" onPress={newSale}><Text>{doneLabel}</Text></Button>
    {notice}
    {status === 'failed' ? <Text testID="paid-print-status" className="w-full text-sm text-destructive">Couldn't print. Try again.</Text> : null}
    {printedLabel && status === 'done' ? <Text testID="paid-print-done" className="w-full text-sm text-muted-foreground">{printedLabel}</Text> : null}
  </View>;
}
