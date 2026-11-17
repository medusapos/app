import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { ClosureSheet, SalesRoom, type SalesFilters } from '@tallyui/components';
import { comparisonRange, exportCsv, presetRange, selectClosureRows, watchFresh, type Closure, type PosOrder } from '@tallyui/pos';
import { FrameMenuButton } from '../components/app-frame';
import { ClosureTable } from '../components/closure-table';
import { EarlierClosures } from '../components/earlier-closures';
import { closureContext, printClosure } from '../components/register-close';
import { loadApprovers } from '../lib/approval';
import { printXReport, X_PRINT_FAILED } from '../lib/closure-print';
import { useOutboxContext } from '../lib/outbox-context';
import { registerCollections } from '../lib/order-store';
import { useRegister } from '../lib/register-context';
import { closureScopeFor, closuresCsvFilename, closureTableRow, csvLabel, downloadCsv, localDay, localDayStartIso, salesRoomFigures } from '../lib/reports';
import { defaultStorage } from '../lib/session';
import { useSession } from '../lib/session-context';
import { loadCachedPricing, loadCachedSettings } from '../lib/store-settings';

export default function ReportsScreen() {
  const { session } = useSession();
  const { orders } = useOutboxContext();
  const { boundRegisterId, registers, register, registerName } = useRegister();
  const [today] = useState(() => localDay(new Date()));
  const [filters, setFilters] = useState<SalesFilters>(() => ({
    preset: 'today', range: presetRange('today', new Date(), 'device'), compare: 'previous',
    status: 'all', cashierId: null, registerId: null,
  }));
  const [sales, setSales] = useState<PosOrder[]>([]);
  const [closures, setClosures] = useState<Closure[]>([]);
  const [exportError, setExportError] = useState(false);
  const [xBusy, setXBusy] = useState(false);
  const [xError, setXError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ closure: Closure; frozen: boolean } | null>(null);

  useEffect(() => {
    if (!orders) return;
    const compare = comparisonRange(filters.range, filters.compare, filters.preset === 'custom' ? undefined : filters.preset);
    const from = filters.range.from < compare.from ? filters.range.from : compare.from;
    const subscription = watchFresh(orders, { selector: { createdAt: { $gte: localDayStartIso(from) } } }).subscribe(setSales);
    return () => subscription.unsubscribe();
  }, [orders, filters]);
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
  const registerNames = Object.fromEntries(registers.map((r) => [r.id, r.name]));
  const summary = currency ? salesRoomFigures(sales, filters, currency) : null;

  return <ScrollView className="flex-1 bg-background" contentContainerClassName="px-6 py-6">
    <Stack.Screen options={{ title: 'Reports', headerLeft: () => <FrameMenuButton /> }} />
    <View className="w-full max-w-5xl gap-4 self-center">
      <Text testID="reports-sales-heading" className="text-lg font-semibold text-foreground">Sales</Text>
      {orders === null ? <Text testID="reports-loading">Loading…</Text>
        : currency === null ? <Text testID="reports-no-currency">Store settings are not loaded yet.</Text>
        : ctx && summary ? <>
          <SalesRoom figures={summary.figures} currency={currency} filters={filters} onFiltersChange={setFilters} timezone="device"
            statusOptions={[{ value: 'all', label: 'All orders' }, { value: 'applied', label: 'Synced' }, { value: 'pending', label: 'Not sent' }]}
            cashierOptions={[]} registerOptions={registers.map(({ id, name }) => ({ value: id, label: name }))} />
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
        {rows.length === 0 ? <Text testID="closures-empty">No closures yet today</Text>
          : <ClosureTable testID="closures-table" rowTestID={(id) => `closure-row-${id}`} ctx={ctx} today={today}
            rows={rows.map((row) => closureTableRow(row, registerNames))} onOpen={(id) => {
              const closure = rows.find((row) => row.id === id);
              if (closure) setOpened({ closure, frozen: true });
            }} />}
        {Platform.OS === 'web' && rows.length > 0 ? <>
          <Pressable testID="closures-export" accessibilityRole="button"
            className="min-h-11 items-center justify-center rounded-md px-4 border border-border"
            onPress={() => {
              try {
                downloadCsv(closuresCsvFilename(scope), exportCsv(rows, ctx.exponent, csvLabel,
                  registerNames, storeName));
                setExportError(false);
              } catch { setExportError(true); }
            }}>
            <Text className="text-foreground">Export CSV</Text>
          </Pressable>
          {exportError ? <Text testID="closures-export-error" accessibilityRole="alert">Export failed. Try again.</Text> : null}
        </> : null}
        {boundRegisterId ? <EarlierClosures session={session} registerId={boundRegisterId} today={today} ctx={ctx}
          registerName={registerName ?? ''} cashierNames={loadApprovers(defaultStorage(), session.baseUrl)}
          localClosures={closures} onOpen={setOpened} /> : null}
      </> : null}
      {opened && currency ? <ClosureSheet currency={currency} onDone={() => setOpened(null)}
        register={{ ...register, lastClosure: opened.closure, closureApprovalStatus: register.closureApprovalStatus ?? {} }}
        onPrint={Platform.OS === 'web' && opened.frozen
          ? () => printClosure(opened.closure, currency, { name: storeName, address: settings?.location.addressLine }) : undefined} /> : null}
    </View>
  </ScrollView>;
}
