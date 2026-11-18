import { useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { AppText as Text } from './app-text';
import { Path } from 'react-native-svg';
import { ClosureSheet, createSvgIcon, IconButton } from '@tallyui/components';
import { exportCsv, presetRange, selectClosureRows, watchFresh, type Closure, type ClosureContext } from '@tallyui/pos';
import { AreaAccountButton, useFrameMenu } from './app-frame';
import { ClosureFiltersBar, ClosureRegisterSelect } from './closure-filters';
import { ClosureTable } from './closure-table';
import { ClosuresStats } from './closures-stats';
import { OpenSessionRow } from './closures-open-session';
import { ClosuresTabs, type ClosuresTab } from './closures-tabs';
import { EarlierClosures } from './earlier-closures';
import { printClosure } from './register-close';
import { loadApprovers } from '../lib/approval';
import type { ClosureHistoryEntry } from '../lib/closure-history';
import { printXReport } from '../lib/closure-print';
import { closureStats } from '../lib/closure-stats';
import { openSessionOf } from '../lib/open-session';
import { useOutboxContext } from '../lib/outbox-context';
import { registerCollections } from '../lib/order-store';
import type { RegisterContextValue } from '../lib/register-context';
import { byCashier, closureCashierOptions, closureHistoryWindow, closureScopeFor, closuresCsvFilename, closureTableRow, csvLabel, downloadCsv, showsTodayClosures, type ClosureFilters } from '../lib/reports';
import { defaultStorage, type Session } from '../lib/session';

const ChevronLeftIcon = createSvgIcon('ChevronLeftIcon', () => <Path d="m15 18-6-6 6-6" />);

/** v2's Closures view, opened from the Reports strip's ›: back arrow and store · register, the filter row, the list. */
export function ClosuresView({ session, registers, boundRegisterId, register, ctx, currency, storeName, storeAddress, today, onBack }: {
  session: Session; registers: { id: string; name: string }[]; boundRegisterId: string | null | undefined;
  register: RegisterContextValue['register']; ctx: ClosureContext; currency: string; storeName: string;
  storeAddress?: string; today: string; onBack: () => void;
}) {
  const { orders } = useOutboxContext();
  const [closures, setClosures] = useState<Closure[]>([]);
  const [exportError, setExportError] = useState(false);
  const [opened, setOpened] = useState<{ closure: Closure; frozen: boolean } | null>(null);
  const [closureFilters, setClosureFilters] = useState<ClosureFilters>(() => ({
    preset: 'today', range: presetRange('today', new Date(), 'device'), registerId: null, cashierId: null,
  }));
  const [historyCashiers, setHistoryCashiers] = useState<string[]>([]);
  const [tab, setTab] = useState<ClosuresTab>('all');
  const [earlierRows, setEarlierRows] = useState<ClosureHistoryEntry[]>([]);
  // A phone keeps the avatar in the stack header; a wide window has no header, so this row carries it.
  const openMenu = useFrameMenu();

  useEffect(() => {
    if (!orders) return;
    const subscription = watchFresh(registerCollections(orders).closures, { selector: {} }).subscribe(setClosures);
    return () => subscription.unsubscribe();
  }, [orders]);

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
  // v2's open session heads Today: the register strip's own session, kept to the chosen cashier like the closures.
  const liveSession = showsToday ? openSessionOf(register) : null;
  const openSession = liveSession && (cashierId === null || liveSession.openedBy === cashierId) ? liveSession : null;
  const openRegisterName = chosenRegister ? registerNames[chosenRegister] ?? '' : '';
  const openRow = openSession ? <OpenSessionRow summary={openSession} registerName={openRegisterName} ctx={ctx}
    cashierName={openSession.openedBy ? names[openSession.openedBy] ?? openSession.openedBy : null}
    print={Platform.OS === 'web' && openSession.status === 'open' ? () => printXReport({ session: register.session!,
      expected: register.expected, salesCount: register.salesCount, registerName: openRegisterName, context: ctx }) : undefined} /> : null;
  const showsEarlier = tab !== 'open' && !!chosenRegister && !!historyWindow;
  // The stat cards and the tabs' count cover exactly the sessions the list shows.
  const stats = closureStats({ open: tab !== 'closed' ? openSession : null,
    closures: tab === 'open' || !showsToday ? [] : shownRows, earlier: showsEarlier ? earlierRows : [], local: closures });
  const exports = tab !== 'open' && showsToday && Platform.OS === 'web' && rows.length > 0;

  return <View testID="closures-view" className="gap-4">
    <View testID="closures-header" className="flex-row items-center gap-2">
      <IconButton testID="closures-back" accessibilityRole="button" accessibilityLabel="Back to Reports" variant="ghost" onPress={onBack}>
        <View className="text-foreground"><ChevronLeftIcon size={24} /></View>
      </IconButton>
      <ClosureRegisterSelect value={chosenRegister ?? ''}
        options={registers.map((r) => ({ value: r.id, label: storeName ? `${storeName} · ${r.name}` : r.name }))}
        onChange={(registerId) => setClosureFilters({ ...closureFilters, registerId })} />
      {!openMenu ? <View className="ml-auto"><AreaAccountButton /></View> : null}
    </View>
    <ClosureFiltersBar filters={{ ...closureFilters, registerId: chosenRegister }} onChange={setClosureFilters}
      cashierOptions={cashierOptions} trailing={exports ?
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
        </Pressable> : undefined} />
    {exports && exportError ?
      <Text testID="closures-export-error" accessibilityRole="alert">Export failed. Try again.</Text> : null}
    {!openMenu ? <ClosuresStats stats={stats} ctx={ctx} /> : null}
    <ClosuresTabs value={tab} onChange={setTab} count={stats.sessions} />
    {tab === 'open' ? openRow ? <ClosureTable testID="closures-table" rowTestID={(id) => `closure-row-${id}`} ctx={ctx}
      today={today} rows={[]} todayLead={openRow} /> : <Text testID="closures-open-empty">No open session</Text>
      : !showsToday ? null : shownRows.length === 0 && !(tab === 'all' && openRow) ? <Text testID="closures-empty">No closures yet today</Text>
      : <ClosureTable testID="closures-table" rowTestID={(id) => `closure-row-${id}`} ctx={ctx} today={today}
        rows={shownRows.map((row) => closureTableRow(row, registerNames))} onOpen={(id) => {
          const closure = rows.find((row) => row.id === id);
          if (closure) setOpened({ closure, frozen: true });
        }} todayLead={tab === 'all' && openRow ? openRow : undefined} />}
    {showsEarlier && chosenRegister && historyWindow ? <EarlierClosures session={session} registerId={chosenRegister} today={today} ctx={ctx}
      registerName={registerNames[chosenRegister] ?? ''} cashierNames={cashierNames}
      localClosures={closures} onOpen={setOpened} from={historyWindow.from} to={historyWindow.to}
      cashierId={cashierId} onCashiers={setHistoryCashiers} onRows={setEarlierRows}
      heading={showsToday ? 'Earlier closures' : null} /> : null}
    {opened ? <ClosureSheet currency={currency} onDone={() => setOpened(null)}
      register={{ ...register, lastClosure: opened.closure, closureApprovalStatus: register.closureApprovalStatus ?? {} }}
      onPrint={Platform.OS === 'web' && opened.frozen
        ? () => printClosure(opened.closure, currency, { name: storeName, address: storeAddress }) : undefined} /> : null}
  </View>;
}
