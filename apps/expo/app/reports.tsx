import { useEffect, useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { buildClosureDocument, exportCsv, minorToDecimal, selectClosureRows, watchFresh, type Closure, type PosOrder } from '@tallyui/pos';
import { ProductsBack } from '../components/products-back';
import { EarlierClosures } from '../components/earlier-closures';
import { closureContext } from '../components/register-close';
import { printXReport, X_PRINT_FAILED } from '../lib/closure-print';
import { useOutboxContext } from '../lib/outbox-context';
import { registerCollections } from '../lib/order-store';
import { useRegister } from '../lib/register-context';
import { closureScopeFor, closuresCsvFilename, closureVarianceMinor, csvLabel, downloadCsv, localDay, localDayStartIso, summarizeSales } from '../lib/reports';
import { defaultStorage } from '../lib/session';
import { useSession } from '../lib/session-context';
import { loadCachedPricing, loadCachedSettings } from '../lib/store-settings';

const Row = ({ label, value, testID }: { label: string; value: ReactNode; testID?: string }) =>
  <View className="min-h-11 flex-row items-center justify-between gap-3">
    <Text className="shrink-0 text-muted-foreground">{label}</Text>
    <Text testID={testID} className="shrink text-right tabular-nums">{value}</Text>
  </View>;

export default function ReportsScreen() {
  const { session } = useSession();
  const { orders } = useOutboxContext();
  const { boundRegisterId, registers, register, registerName } = useRegister();
  const [today] = useState(() => localDay(new Date()));
  const [sales, setSales] = useState<PosOrder[]>([]);
  const [closures, setClosures] = useState<Closure[]>([]);
  const [exportError, setExportError] = useState(false);
  const [xBusy, setXBusy] = useState(false);
  const [xError, setXError] = useState<string | null>(null);

  useEffect(() => {
    if (!orders) return;
    const subscription = watchFresh(orders, { selector: { createdAt: { $gte: localDayStartIso(today) } } }).subscribe(setSales);
    return () => subscription.unsubscribe();
  }, [orders, today]);
  useEffect(() => {
    if (!orders) return;
    const subscription = watchFresh(registerCollections(orders).closures, { selector: {} }).subscribe(setClosures);
    return () => subscription.unsubscribe();
  }, [orders]);

  const settings = session?.baseUrl ? loadCachedSettings(defaultStorage(), session.baseUrl) : null;
  const pricing = session?.baseUrl ? loadCachedPricing(defaultStorage(), session.baseUrl) : null;
  const currency = pricing?.currency ?? settings?.currency ?? null;
  const storeName = settings?.storeName ?? '';
  const ctx = currency ? closureContext(currency, { name: storeName, address: settings?.location.addressLine }) : null;
  if (!session) return <Redirect href="/login" />;
  const scope = closureScopeFor({ today, boundRegisterId, storeKey: session.baseUrl });
  const rows = selectClosureRows(closures, scope, 'device');
  const summary = currency ? summarizeSales(sales, today, currency) : null;

  return <ScrollView className="flex-1 bg-background" contentContainerClassName="px-6 py-6">
    <Stack.Screen options={{ title: 'Reports', headerLeft: () => <ProductsBack /> }} />
    <View className="w-full max-w-md gap-4 self-center">
      <Text testID="reports-sales-heading" className="text-lg font-semibold text-foreground">Today's sales</Text>
      {orders === null ? <Text testID="reports-loading">Loading…</Text>
        : currency === null ? <Text testID="reports-no-currency">Store settings are not loaded yet.</Text>
        : ctx && summary ? <>
          {summary.count === 0 ? <Text testID="reports-sales-empty">No sales yet today</Text> : <>
            <Row label="Orders" value={String(summary.count)} testID="reports-sales-count" />
            <Row label="Total" value={ctx.formatMoney(minorToDecimal(summary.grossMinor, ctx.exponent))} testID="reports-sales-gross" />
            {summary.methods.map((entry) => <Row key={entry.method} label={entry.label}
              value={ctx.formatMoney(minorToDecimal(entry.amountMinor, ctx.exponent))} testID={`reports-method-${entry.method}`} />)}
          </>}
          {summary.notSentCount > 0 ? <Text testID="reports-not-sent">
            {`${summary.notSentCount} ${summary.notSentCount === 1 ? 'sale' : 'sales'} not sent yet`}
          </Text> : null}
          {summary.leftOutCount > 0 ? <Text testID="reports-left-out">
            {`${summary.leftOutCount} ${summary.leftOutCount === 1 ? 'order' : 'orders'} in another currency left out`}
          </Text> : null}
        </> : null}
      {Platform.OS === 'web' && ctx && register.session?.status === 'open' ? <>
        <Pressable testID="reports-x-print" accessibilityRole="button" disabled={xBusy}
          className="min-h-11 items-center justify-center rounded-md px-4 border border-border"
          onPress={async () => {
            setXBusy(true);
            setXError(null);
            try {
              await printXReport({ session: register.session!, expected: register.expected,
                salesCount: register.salesCount, registerName, context: ctx });
            } catch (error) {
              setXError(error instanceof Error ? error.message : X_PRINT_FAILED);
            } finally { setXBusy(false); }
          }}>
          <Text className="text-foreground">{xBusy ? 'Printing…' : 'Print X report'}</Text>
        </Pressable>
        {xError ? <Text testID="reports-x-print-error" accessibilityRole="alert">{xError}</Text> : null}
      </> : null}
      <Text testID="closures-heading" className="text-lg font-semibold text-foreground">Closures</Text>
      {orders !== null && ctx ? <>
        {rows.length === 0 ? <Text testID="closures-empty">No closures yet today</Text> : rows.map((row) => {
          const { closure: z, fiscal } = buildClosureDocument(row, ctx);
          const variance = closureVarianceMinor(row);
          return <View key={row.id} testID={`closure-row-${row.id}`}>
            <Text className="font-semibold">{`Closure #${fiscal.receipt_number}`}</Text>
            <Row label="Closed" value={z.closed_at.datetime} />
            <Row label="Sales" value={z.period_sales_total_display} />
            <Row label="Variance" testID={`closure-variance-${row.id}`} value={variance === 0 ? 'Exact'
              : `${variance > 0 ? 'Over' : 'Short'} ${ctx.formatMoney(minorToDecimal(Math.abs(variance), ctx.exponent))}`} />
          </View>;
        })}
        {Platform.OS === 'web' && rows.length > 0 ? <>
          <Pressable testID="closures-export" accessibilityRole="button"
            className="min-h-11 items-center justify-center rounded-md px-4 border border-border"
            onPress={() => {
              try {
                downloadCsv(closuresCsvFilename(scope), exportCsv(rows, ctx.exponent, csvLabel,
                  Object.fromEntries(registers.map((r) => [r.id, r.name])), storeName));
                setExportError(false);
              } catch { setExportError(true); }
            }}>
            <Text className="text-foreground">Export CSV</Text>
          </Pressable>
          {exportError ? <Text testID="closures-export-error" accessibilityRole="alert">Export failed. Try again.</Text> : null}
        </> : null}
        {boundRegisterId ? <EarlierClosures session={session} registerId={boundRegisterId} today={today} ctx={ctx} /> : null}
      </> : null}
    </View>
  </ScrollView>;
}
