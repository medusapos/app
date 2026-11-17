import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import { Path } from 'react-native-svg';
import { ClosureSheet, createSvgIcon, SalesCards, SalesFiltersBar, SalesHero, type SalesFilters } from '@tallyui/components';
import { comparisonRange, exportCsv, presetRange, selectClosureRows, watchFresh, type Closure, type PosOrder } from '@tallyui/pos';
import { FrameMenuButton } from '../components/app-frame';
import { ClosureFiltersBar } from '../components/closure-filters';
import { ClosureTable } from '../components/closure-table';
import { EarlierClosures } from '../components/earlier-closures';
import { closureContext, printClosure } from '../components/register-close';
import { RegisterStrip } from '../components/register-strip';
import { loadApprovers } from '../lib/approval';
import { printSalesSummary, printXReport, SUMMARY_PRINT_FAILED, X_PRINT_FAILED } from '../lib/closure-print';
import { useOutboxContext } from '../lib/outbox-context';
import { registerCollections } from '../lib/order-store';
import { useRegister } from '../lib/register-context';
import { byCashier, closureCashierOptions, closureDayLabel, closureHistoryWindow, closureScopeFor, closuresCsvFilename, closureTableRow, csvLabel, downloadCsv, localDay, localDayStartIso, salesRoomFigures, showsTodayClosures, type ClosureFilters } from '../lib/reports';
import { defaultStorage } from '../lib/session';
import { useSession } from '../lib/session-context';
import { loadCachedPricing, loadCachedSettings } from '../lib/store-settings';

// The Sales room's status menu; the printed summary's scope line reads the same labels.
const STATUS_OPTIONS = [{ value: 'all', label: 'All orders' }, { value: 'applied', label: 'Synced' }, { value: 'pending', label: 'Not sent' }];

// v2's outline printer on the Print summary button: paper tray, body, output sheet.
const PrinterIcon = createSvgIcon('PrinterIcon', () => <>
  <Path d="M6 9V2h12v7" />
  <Path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
  <Path d="M6 14h12v8H6z" />
</>);

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
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ closure: Closure; frozen: boolean } | null>(null);
  const [closureFilters, setClosureFilters] = useState<ClosureFilters>(() => ({
    preset: 'today', range: presetRange('today', new Date(), 'device'), registerId: null, cashierId: null,
  }));
  const [historyCashiers, setHistoryCashiers] = useState<string[]>([]);

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
  const { range, cashierId } = closureFilters;
  const chosenRegister = closureFilters.registerId ?? boundRegisterId ?? registers[0]?.id ?? null;
  const ownRegister = !!boundRegisterId && chosenRegister === boundRegisterId;
  const showsToday = showsTodayClosures(range, today, ownRegister);
  const historyWindow = closureHistoryWindow(range, today, ownRegister);
  const cashierNames = loadApprovers(defaultStorage(), session.baseUrl);
  const names = { ...cashierNames, ...Object.fromEntries(rows.flatMap((row) => row.closed_by
    && typeof row.breakdowns.closed_by_name === 'string' ? [[row.closed_by, row.breakdowns.closed_by_name]] : [])) };
  const cashierOptions = closureCashierOptions([...rows.flatMap((row) => row.closed_by ? [row.closed_by] : []), ...historyCashiers], names);
  const shownRows = byCashier(rows, cashierId, (row) => row.closed_by);
  const summary = currency ? salesRoomFigures(sales, filters, currency) : null;

  return <ScrollView className="flex-1 bg-background" contentContainerClassName="px-6 py-6">
    <Stack.Screen options={{ title: 'Reports', headerLeft: () => <FrameMenuButton /> }} />
    <View className="w-full max-w-5xl gap-4 self-center">
      {ctx && boundRegisterId ? <>
        <RegisterStrip register={register} ctx={ctx}
          panel={{ currency: currency!, store: { name: storeName, address: settings?.location.addressLine } }} action={Platform.OS === 'web' && register.session?.status === 'open' ?
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
          </Pressable> : null} />
        {Platform.OS === 'web' && register.session?.status === 'open' && xError ?
          <Text testID="reports-x-print-error" accessibilityRole="alert">{xError}</Text> : null}
      </> : null}
      <Text testID="reports-sales-heading" className="text-lg font-semibold text-foreground">Sales</Text>
      {orders === null ? <Text testID="reports-loading">Loading…</Text>
        : currency === null ? <Text testID="reports-no-currency">Store settings are not loaded yet.</Text>
        : ctx && summary ? <>
          <View testID="sales-room" className="gap-4">
            <View className="flex-row flex-wrap items-start gap-2">
              <View className="flex-1">
                <SalesFiltersBar filters={filters} onFiltersChange={setFilters} timezone="device" statusOptions={STATUS_OPTIONS}
                  cashierOptions={[]} registerOptions={registers.map(({ id, name }) => ({ value: id, label: name }))} />
              </View>
              {Platform.OS === 'web' ? <Pressable testID="reports-print-summary" accessibilityRole="button" disabled={summaryBusy}
                className="min-h-11 flex-row items-center justify-center gap-2 rounded-md px-4 border border-border"
                onPress={async () => {
                  setSummaryBusy(true);
                  setSummaryError(null);
                  const { from, to } = filters.range;
                  const period = from === to ? closureDayLabel(from, today, ctx.locale)
                    : `${closureDayLabel(from, today, ctx.locale)} – ${closureDayLabel(to, today, ctx.locale)}`;
                  const registerLabel = filters.registerId === null ? 'All registers'
                    : registers.find((r) => r.id === filters.registerId)?.name ?? '';
                  const statusLabel = STATUS_OPTIONS.find((option) => option.value === filters.status)?.label ?? '';
                  try {
                    await printSalesSummary({ figures: summary.figures, context: ctx, notSentCount: summary.notSentCount,
                      period, scope: `${registerLabel} · ${statusLabel}` });
                  } catch (error) {
                    setSummaryError(error instanceof Error ? error.message : SUMMARY_PRINT_FAILED);
                  } finally { setSummaryBusy(false); }
                }}>
                <View testID="reports-print-summary-icon" className="text-foreground"><PrinterIcon size={18} /></View>
                <Text className="text-foreground">{summaryBusy ? 'Printing…' : 'Print summary'}</Text>
              </Pressable> : null}
            </View>
            {Platform.OS === 'web' && summaryError ?
              <Text testID="reports-print-summary-error" accessibilityRole="alert">{summaryError}</Text> : null}
            <SalesHero figures={summary.figures} filters={filters} onFiltersChange={setFilters} currency={currency} />
            <SalesCards figures={summary.figures} currency={currency} />
          </View>
          {summary.notSentCount > 0 ? <Text testID="reports-not-sent">
            {`${summary.notSentCount} ${summary.notSentCount === 1 ? 'sale' : 'sales'} not sent yet`}
          </Text> : null}
          {summary.leftOutCount > 0 ? <Text testID="reports-left-out">
            {`${summary.leftOutCount} ${summary.leftOutCount === 1 ? 'order' : 'orders'} in another currency left out`}
          </Text> : null}
        </> : null}
      <Text testID="closures-heading" className="text-lg font-semibold text-foreground">Closures</Text>
      {orders !== null && ctx ? <>
        <ClosureFiltersBar filters={{ ...closureFilters, registerId: chosenRegister }} onChange={setClosureFilters}
          registerOptions={registers.map((r) => ({ value: r.id, label: storeName ? `${storeName} · ${r.name}` : r.name }))}
          cashierOptions={cashierOptions} />
        {!showsToday ? null : shownRows.length === 0 ? <Text testID="closures-empty">No closures yet today</Text>
          : <ClosureTable testID="closures-table" rowTestID={(id) => `closure-row-${id}`} ctx={ctx} today={today}
            rows={shownRows.map((row) => closureTableRow(row, registerNames))} onOpen={(id) => {
              const closure = rows.find((row) => row.id === id);
              if (closure) setOpened({ closure, frozen: true });
            }} />}
        {showsToday && Platform.OS === 'web' && rows.length > 0 ? <>
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
        {chosenRegister && historyWindow ? <EarlierClosures session={session} registerId={chosenRegister} today={today} ctx={ctx}
          registerName={registerNames[chosenRegister] ?? ''} cashierNames={cashierNames}
          localClosures={closures} onOpen={setOpened} from={historyWindow.from} to={historyWindow.to}
          cashierId={cashierId} onCashiers={setHistoryCashiers} heading={showsToday ? 'Earlier closures' : null} /> : null}
      </> : null}
      {opened && currency ? <ClosureSheet currency={currency} onDone={() => setOpened(null)}
        register={{ ...register, lastClosure: opened.closure, closureApprovalStatus: register.closureApprovalStatus ?? {} }}
        onPrint={Platform.OS === 'web' && opened.frozen
          ? () => printClosure(opened.closure, currency, { name: storeName, address: settings?.location.addressLine }) : undefined} /> : null}
    </View>
  </ScrollView>;
}
