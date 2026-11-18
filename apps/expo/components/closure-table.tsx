import { Fragment, type ReactElement } from 'react';
import { Pressable, useWindowDimensions } from 'react-native';
import { AppText as Text } from './app-text';
import { Table, TableBody, TableRow, TableCell } from '@tallyui/components';
import { formatClosureDate, minorToDecimal, type ClosureContext } from '@tallyui/pos';
import { closureDayLabel, closureDays, closureDayTotal, varianceLabel, type ClosureDay, type ClosureTableRow } from '../lib/reports';

// ADR 0009: below this width the counted total and the result stack in one cell so the title keeps the row.
const PHONE_BREAKPOINT = 600;

const varianceClass = (varianceMinor: number | null) =>
  varianceMinor === null || varianceMinor === 0 ? 'text-muted-foreground' : varianceMinor < 0 ? 'text-destructive' : 'text-success';

export function ClosureTable({ rows, ctx, testID, rowTestID, today, onOpen, openable, todayLead }: {
  rows: ClosureTableRow[]; ctx: ClosureContext; testID: string; rowTestID: (id: string) => string; today: string;
  onOpen?: (id: string) => void; openable?: (id: string) => boolean;
  /** A row shown first under the Today header (Closures' open session); the table draws that header when today has no rows. */
  todayLead?: ReactElement;
}) {
  const phone = useWindowDimensions().width < PHONE_BREAKPOINT;
  if (rows.length === 0 && !todayLead) return null;
  const openFor = (id: string) => onOpen && (openable ? openable(id) : true) ? onOpen : undefined;
  const pressable = (row: ClosureTableRow, line: ReactElement) => {
    const open = openFor(row.id);
    return open ? <Pressable key={row.id} testID={`${rowTestID(row.id)}-open`} accessibilityRole="button"
      accessibilityLabel={`Open closure #${row.number}`} onPress={() => open(row.id)}>{line}</Pressable> : line;
  };
  const dayHeader = (group: ClosureDay) => {
    const total = closureDayTotal(group, ctx);
    const counted = closureDayTotal({ countedMinor: group.countedMinor, varianceMinor: null }, ctx);
    return <TableRow key={`day-${group.day}`} testID={`${testID}-day-${group.day}`} className="bg-muted">
      <TableCell><Text testID={`${testID}-day-${group.day}-label`} className="font-semibold text-foreground">
        {closureDayLabel(group.day, today, ctx.locale)}
      </Text></TableCell>
      {total ? <TableCell className="items-end">
        <Text testID={`${testID}-day-${group.day}-total`} className="text-right tabular-nums">
          <Text className="text-muted-foreground">{counted}</Text>
          {total.length > counted.length ? <Text className={varianceClass(group.varianceMinor)}>{total.slice(counted.length)}</Text> : null}
        </Text>
      </TableCell> : null}
    </TableRow>;
  };
  const closureRow = (row: ClosureTableRow) => {
    const id = rowTestID(row.id);
    const counted = <Text testID={`${id}-counted`} className="text-right tabular-nums text-foreground">
      {row.countedMinor === null ? '—' : ctx.formatMoney(minorToDecimal(row.countedMinor, ctx.exponent))}
    </Text>;
    const variance = <Text testID={`${id}-variance`} className={`text-right tabular-nums ${varianceClass(row.varianceMinor)}`}>
      {row.varianceMinor === null ? '—' : varianceLabel(row.varianceMinor, ctx)}
    </Text>;
    return <TableRow key={row.id} testID={id} className="items-center">
      <TableCell className="min-w-0 gap-0.5">
        <Text testID={`${id}-title`} numberOfLines={1} className="text-foreground">{`Closure ${row.number} · ${row.registerName}`}</Text>
        <Text testID={`${id}-detail`} className="text-sm text-muted-foreground">
          {`${formatClosureDate(row.openedAt, ctx).time} → ${formatClosureDate(row.closedAt, ctx).time} · `}
          <Text testID={`${id}-cashier`}>{row.cashierName}</Text>
        </Text>
      </TableCell>
      {phone ? <TableCell className="flex-none items-end gap-0.5">{counted}{variance}</TableCell> : <>
        <TableCell className="w-32 flex-none items-end">{counted}</TableCell>
        <TableCell className="w-40 flex-none items-end">{variance}</TableCell>
      </>}
      {onOpen ? <TableCell className="w-10 flex-none items-end">
        {openFor(row.id) ? <Text className="text-muted-foreground">›</Text> : null}
      </TableCell> : null}
    </TableRow>;
  };
  const days = closureDays(rows);
  // Without a closure today the lead still sits under its own Today header (no total), ahead of the earlier days.
  const groups = todayLead && !days.some((group) => group.day === today)
    ? [{ day: today, rows: [], countedMinor: null, varianceMinor: null }, ...days] : days;
  return <Table testID={testID}>
    <TableBody>{groups.flatMap((group) => [dayHeader(group), ...(todayLead && group.day === today ? [<Fragment key="today-lead">{todayLead}</Fragment>] : []),
      ...group.rows.map((row) => pressable(row, closureRow(row)))])}</TableBody>
  </Table>;
}
