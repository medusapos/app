import { useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { AppText as Text } from './app-text';
import { Path } from 'react-native-svg';
import { ClosureSheet, createSvgIcon, IconButton } from '@tallyui/components';
import { exportCsv, presetRange, selectClosureRows, watchFresh, type Closure, type ClosureContext } from '@tallyui/pos';
import { AreaAccountButton, useFrameMenu } from './app-frame';
import { ClosureFiltersBar, ClosureRegisterSelect } from './closure-filters';
import { ClosureTable } from './closure-table';
import { EarlierClosures } from './earlier-closures';
import { printClosure } from './register-close';
import { loadApprovers } from '../lib/approval';
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
      cashierOptions={cashierOptions} trailing={showsToday && Platform.OS === 'web' && rows.length > 0 ?
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
    {showsToday && Platform.OS === 'web' && rows.length > 0 && exportError ?
      <Text testID="closures-export-error" accessibilityRole="alert">Export failed. Try again.</Text> : null}
    {!showsToday ? null : shownRows.length === 0 ? <Text testID="closures-empty">No closures yet today</Text>
      : <ClosureTable testID="closures-table" rowTestID={(id) => `closure-row-${id}`} ctx={ctx} today={today}
        rows={shownRows.map((row) => closureTableRow(row, registerNames))} onOpen={(id) => {
          const closure = rows.find((row) => row.id === id);
          if (closure) setOpened({ closure, frozen: true });
        }} />}
    {chosenRegister && historyWindow ? <EarlierClosures session={session} registerId={chosenRegister} today={today} ctx={ctx}
      registerName={registerNames[chosenRegister] ?? ''} cashierNames={cashierNames}
      localClosures={closures} onOpen={setOpened} from={historyWindow.from} to={historyWindow.to}
      cashierId={cashierId} onCashiers={setHistoryCashiers} heading={showsToday ? 'Earlier closures' : null} /> : null}
    {opened ? <ClosureSheet currency={currency} onDone={() => setOpened(null)}
      register={{ ...register, lastClosure: opened.closure, closureApprovalStatus: register.closureApprovalStatus ?? {} }}
      onPrint={Platform.OS === 'web' && opened.frozen
        ? () => printClosure(opened.closure, currency, { name: storeName, address: storeAddress }) : undefined} /> : null}
  </View>;
}
