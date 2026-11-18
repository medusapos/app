import { useState, type JSX } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { Path } from 'react-native-svg';
import { createSvgIcon, TableCell, TableRow } from '@tallyui/components';
import { formatClosureDate, minorToDecimal, type ClosureContext } from '@tallyui/pos';
import { AppText as Text } from './app-text';
import { X_PRINT_FAILED } from '../lib/closure-print';
import type { OpenSessionSummary } from '../lib/open-session';

// The same breakpoint as closure-table.tsx (ADR 0009): below it the expected block and the button stack in one cell.
const PHONE_BREAKPOINT = 600;

// v2's outline printer, as on Reports' Print X report button: paper tray, body, output sheet.
const PrinterIcon = createSvgIcon('PrinterIcon', () => <>
  <Path d="M6 9V2h12v7" />
  <Path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
  <Path d="M6 14h12v8H6z" />
</>);

/** v2's open session at the head of Today in Closures: "● Open · Register 1", since · cashier · sales, Expected, Print X-report. */
export function OpenSessionRow({ summary, registerName, cashierName, ctx, print }: {
  summary: OpenSessionSummary; registerName: string; cashierName: string | null; ctx: ClosureContext;
  print?: () => Promise<void>;
}): JSX.Element {
  const phone = useWindowDimensions().width < PHONE_BREAKPOINT;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = summary.status === 'open';
  const expected = summary.expectedCashMinor === null ? null : <View className="items-end">
    <Text testID="closures-open-session-expected" className="tabular-nums text-foreground text-right">
      {ctx.formatMoney(minorToDecimal(summary.expectedCashMinor, ctx.exponent))}
    </Text>
    <Text className="text-sm text-muted-foreground">Expected</Text>
  </View>;
  const button = print ? <Pressable testID="closures-open-session-print" accessibilityRole="button" disabled={busy}
    className="min-h-11 flex-row items-center justify-center gap-2 rounded-md px-4 border border-border"
    onPress={async () => {
      setBusy(true);
      setError(null);
      try {
        await print();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : X_PRINT_FAILED);
      } finally { setBusy(false); }
    }}>
    <View className="text-foreground"><PrinterIcon size={18} /></View>
    <Text className="text-foreground">{busy ? 'Printing…' : 'Print X-report'}</Text>
  </Pressable> : null;
  const printError = error ? <Text testID="closures-open-session-print-error" accessibilityRole="alert"
    className="text-right text-foreground">{error}</Text> : null;

  return <TableRow testID="closures-open-session" className="items-center bg-muted/50">
    <TableCell className="min-w-0 gap-0.5">
      <View testID="closures-open-session-title" className="flex-row items-center gap-2">
        <View className={`h-2 w-2 rounded-full ${open ? 'bg-success' : 'bg-muted-foreground'}`} />
        <Text numberOfLines={1} className="text-foreground">{`${open ? 'Open' : 'Counting'} · ${registerName}`}</Text>
      </View>
      <Text testID="closures-open-session-detail" className="text-sm text-muted-foreground">
        {`since ${formatClosureDate(summary.openedAt, ctx).time}${cashierName === null ? '' : ` · ${cashierName}`}`
          + ` · ${summary.salesCount} ${summary.salesCount === 1 ? 'sale' : 'sales'}`}
      </Text>
    </TableCell>
    {expected || button || printError ? <TableCell className="flex-none items-end gap-2">
      <View className={phone ? 'items-end gap-2' : 'flex-row items-center gap-4'}>{expected}{button}</View>
      {printError}
    </TableCell> : null}
  </TableRow>;
}
