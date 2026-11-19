import { useContext, useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { AppText as Text } from '../components/app-text';
import { Redirect, Stack } from 'expo-router';
import { Path } from 'react-native-svg';
import { createSvgIcon, SalesCards, SalesFiltersBar, SalesHero, type SalesCardId, type SalesFilters } from '@tallyui/components';
import { comparisonRange, presetRange, watchFresh, type PosOrder } from '@tallyui/pos';
import { AreaAccountButton, FrameMenuButton, useFrameAccount, useFrameMenu } from '../components/app-frame';
import { ClosuresView } from '../components/closures-view';
import { ReportSheet } from '../components/report-sheet';
import { closureContext, printClosure } from '../components/register-close';
import { RegisterStrip } from '../components/register-strip';
import { StripHeightContext } from '../components/store-refused';
import { reportCashierOptions } from '../lib/cashiers';
import { PRINT_FAILED, printHtml, printSalesSummary, printXReport, SUMMARY_PRINT_FAILED, X_PRINT_FAILED } from '../lib/closure-print';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { reportPanel, reportPanelCsv, reportPanelHtml } from '../lib/report-panels';
import { downloadCsv, localDay, localDayStartIso, reportScope, salesRoomFigures, STATUS_OPTIONS } from '../lib/reports';
import { defaultStorage } from '../lib/session';
import { useSession } from '../lib/session-context';
import { loadCachedPricing, loadCachedSettings } from '../lib/store-settings';

// v2's outline printer on the Print summary, Print X report and Print closure buttons: paper tray, body, output sheet.
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
  // v2 opens Closures from the strip's › as its own view; it is state here, so the rail keeps Reports active.
  const [view, setView] = useState<'sales' | 'closures'>('sales');
  const [xBusy, setXBusy] = useState(false);
  const [xError, setXError] = useState<string | null>(null);
  const [zBusy, setZBusy] = useState(false);
  const [zError, setZError] = useState<string | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  // The Sales card whose report is open in the side sheet, as v2 opens a card's panel.
  const [openCard, setOpenCard] = useState<SalesCardId | null>(null);
  const [panelPrinting, setPanelPrinting] = useState(false);
  const [panelPrintError, setPanelPrintError] = useState<string | null>(null);
  const closeCard = () => { setOpenCard(null); setPanelPrintError(null); };
  const showClosures = () => { closeCard(); setView('closures'); };

  useEffect(() => {
    if (!orders) return;
    const compare = comparisonRange(filters.range, filters.compare, filters.preset === 'custom' ? undefined : filters.preset);
    const from = filters.range.from < compare.from ? filters.range.from : compare.from;
    const subscription = watchFresh(orders, { selector: { createdAt: { $gte: localDayStartIso(from) } } }).subscribe(setSales);
    return () => subscription.unsubscribe();
  }, [orders, filters]);

  const settings = session?.baseUrl ? loadCachedSettings(defaultStorage(), session.baseUrl) : null;
  const pricing = session?.baseUrl ? loadCachedPricing(defaultStorage(), session.baseUrl) : null;
  const currency = pricing?.currency ?? settings?.currency ?? null;
  const storeName = settings?.storeName ?? '';
  const ctx = currency ? closureContext(currency, { name: storeName, address: settings?.location.addressLine }) : null;
  // v2's Reports has no title bar on a wide window; a phone keeps the header for the drawer's Menu.
  const openMenu = useFrameMenu();
  const account = useFrameAccount();
  // Without a header the sign-in / refused strip lies over the top of the screen (as on the Sale screen).
  const topInset = useContext(StripHeightContext);
  if (!session) return <Redirect href="/login" />;
  const summary = currency ? salesRoomFigures(sales, filters, currency) : null;
  const scope = ctx ? reportScope(filters, registers, today, ctx.locale) : null;
  const covers = scope ? `${scope.period} · ${scope.registerLabel}` : '';
  const panel = openCard && ctx && summary
    ? reportPanel(openCard, { figures: summary.figures, orders: summary.periodOrders, ctx, today }) : null;
  // v2's closed strip offers Print closure where the open strip has Print X report (reports/index.mdx#closures).
  const lastClosure = register.lastClosure;
  const closurePrint = Platform.OS === 'web' && !!lastClosure
    && !['open', 'counting', 'conflict'].includes(register.session?.status ?? '');

  return <ScrollView className="flex-1 bg-background" role="main" aria-label="Reports" contentContainerClassName="px-6 pb-6"
    contentContainerStyle={{ paddingTop: 24 + topInset }}>
    <Stack.Screen options={{ title: 'Reports', headerShown: !!openMenu, headerLeft: () => <FrameMenuButton />, headerRight: () => <View className="pr-4"><AreaAccountButton /></View> }} />
    {/* v2's avatar ends the window's top row, so it sits outside the centred column; Closures' header carries its own. */}
    {view === 'sales' && !openMenu && account && <View className="flex-row justify-end"><AreaAccountButton /></View>}
    <View className="w-full max-w-5xl gap-4 self-center">
      {view === 'sales' && ctx && boundRegisterId ? <>
        <RegisterStrip register={register} ctx={ctx} onOpenClosures={showClosures}
          panel={{ currency: currency!, store: { name: storeName, address: settings?.location.addressLine } }} action={Platform.OS === 'web' && register.session?.status === 'open' ?
          <Pressable testID="reports-x-print" accessibilityRole="button" disabled={xBusy}
            className="min-h-11 flex-row items-center justify-center gap-2 rounded-md px-4 border border-border"
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
            <View testID="reports-x-print-icon" className="text-foreground"><PrinterIcon size={18} /></View>
            <Text className="text-foreground">{xBusy ? 'Printing…' : 'Print X report'}</Text>
          </Pressable> : closurePrint ?
          <Pressable testID="reports-closure-print" accessibilityRole="button" disabled={zBusy}
            className="min-h-11 flex-row items-center justify-center gap-2 rounded-md px-4 border border-border"
            onPress={async () => {
              setZBusy(true);
              setZError(null);
              try {
                await printClosure(lastClosure!, currency!, { name: storeName, address: settings?.location.addressLine });
              } catch (error) {
                setZError(error instanceof Error ? error.message : PRINT_FAILED);
              } finally { setZBusy(false); }
            }}>
            <View testID="reports-closure-print-icon" className="text-foreground"><PrinterIcon size={18} /></View>
            <Text className="text-foreground">{zBusy ? 'Printing…' : 'Print closure'}</Text>
          </Pressable> : null} />
        {Platform.OS === 'web' && register.session?.status === 'open' && xError ?
          <Text testID="reports-x-print-error" accessibilityRole="alert">{xError}</Text> : null}
        {closurePrint && zError ? <Text testID="reports-closure-print-error" accessibilityRole="alert">{zError}</Text> : null}
      </> : null}
      {/* An unbound till has no strip, so Closures opens from a button in its place. */}
      {view === 'sales' && ctx && !boundRegisterId ? <Pressable testID="reports-open-closures" accessibilityRole="button"
        className="min-h-11 flex-row items-center justify-between rounded-md border border-border px-4"
        onPress={showClosures}>
        <Text className="text-foreground">Closures</Text>
        <Text className="text-muted-foreground">›</Text>
      </Pressable> : null}
      {view === 'closures' ? null : orders === null ? <Text testID="reports-loading">Loading…</Text>
        : currency === null ? <Text testID="reports-no-currency">Store settings are not loaded yet.</Text>
        : ctx && summary ? <>
          <View testID="sales-room" className="gap-4">
            <View className="flex-row flex-wrap items-start gap-2">
              <View className="flex-1">
                <SalesFiltersBar filters={filters} onFiltersChange={setFilters} timezone="device" statusOptions={STATUS_OPTIONS}
                  cashierOptions={reportCashierOptions(sales, session, filters.cashierId)} registerOptions={registers.map(({ id, name }) => ({ value: id, label: name }))} />
              </View>
              {Platform.OS === 'web' ? <Pressable testID="reports-print-summary" accessibilityRole="button" disabled={summaryBusy}
                className="min-h-11 flex-row items-center justify-center gap-2 rounded-md px-4 border border-border"
                onPress={async () => {
                  setSummaryBusy(true);
                  setSummaryError(null);
                  const { period, registerLabel, statusLabel } = reportScope(filters, registers, today, ctx.locale);
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
            <SalesCards figures={summary.figures} currency={currency} onOpenCard={setOpenCard} />
          </View>
          <ReportSheet panel={panel} covers={covers} onClose={closeCard} printing={panelPrinting} printError={panelPrintError}
            printIcon={<View className="text-primary-foreground"><PrinterIcon size={18} /></View>}
            onExport={Platform.OS === 'web' ? () => { if (panel) downloadCsv(panel.filename, reportPanelCsv(panel)); } : undefined}
            onPrint={Platform.OS === 'web' ? async () => {
              if (!panel) return;
              setPanelPrinting(true);
              setPanelPrintError(null);
              try {
                await printHtml(reportPanelHtml(panel, { ctx, covers }), { title: panel.title, failed: SUMMARY_PRINT_FAILED });
              } catch (error) {
                setPanelPrintError(error instanceof Error ? error.message : SUMMARY_PRINT_FAILED);
              } finally { setPanelPrinting(false); }
            } : undefined} />
          {summary.notSentCount > 0 ? <Text testID="reports-not-sent">
            {`${summary.notSentCount} ${summary.notSentCount === 1 ? 'sale' : 'sales'} not sent yet`}
          </Text> : null}
          {summary.leftOutCount > 0 ? <Text testID="reports-left-out">
            {`${summary.leftOutCount} ${summary.leftOutCount === 1 ? 'order' : 'orders'} in another currency left out`}
          </Text> : null}
        </> : null}
      {view === 'closures' && orders !== null && ctx ? <ClosuresView session={session} registers={registers}
        boundRegisterId={boundRegisterId} register={register} ctx={ctx} currency={currency!} storeName={storeName}
        storeAddress={settings?.location.addressLine} today={today} onBack={() => setView('sales')} /> : null}
    </View>
  </ScrollView>;
}
