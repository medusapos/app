import type { ReactElement } from 'react';
import { Pressable, ScrollView } from 'react-native';
import { AppText as Text } from './app-text';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Text as TableText } from '@tallyui/components';
import { formatClosureDate, minorToDecimal, type ClosureContext } from '@tallyui/pos';
import { closureDayLabel, closureDays, closureDayTotal, varianceLabel, type ClosureDay, type ClosureTableRow } from '../lib/reports';

const varianceClass = (varianceMinor: number | null) =>
  varianceMinor === null || varianceMinor === 0 ? 'text-muted-foreground' : varianceMinor < 0 ? 'text-destructive' : 'text-success';

export function ClosureTable({ rows, ctx, testID, rowTestID, today, onOpen, openable }: {
  rows: ClosureTableRow[]; ctx: ClosureContext; testID: string; rowTestID: (id: string) => string; today: string;
  onOpen?: (id: string) => void; openable?: (id: string) => boolean;
}) {
  if (rows.length === 0) return null;
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
  return <ScrollView horizontal contentContainerClassName="grow">
    <Table testID={testID} className="min-w-[720px] w-full">
      <TableHeader><TableRow>
        {['Closure', 'Closed', 'Register', 'Cashier', 'Sales', 'Counted', 'Variance'].map((label, index) =>
          <TableHead key={label} className={index >= 4 ? 'items-end' : undefined}>
            <TableText className={index >= 4 ? 'text-right' : undefined}>{label}</TableText>
          </TableHead>)}
        {onOpen ? <TableHead className="w-10 flex-none" /> : null}
      </TableRow></TableHeader>
      <TableBody>{closureDays(rows).flatMap((group) => [dayHeader(group), ...group.rows.map((row) => pressable(row, <TableRow key={row.id} testID={rowTestID(row.id)}>
        <TableCell testID={`${rowTestID(row.id)}-number`}><Text className="text-foreground">{`#${row.number}`}</Text></TableCell>
        <TableCell testID={`${rowTestID(row.id)}-closed`}><Text className="text-foreground">{formatClosureDate(row.closedAt, ctx).datetime}</Text></TableCell>
        <TableCell testID={`${rowTestID(row.id)}-register`}><Text className="text-foreground">{row.registerName}</Text></TableCell>
        <TableCell testID={`${rowTestID(row.id)}-cashier`}><Text className="text-foreground">{row.cashierName}</Text></TableCell>
        <TableCell testID={`${rowTestID(row.id)}-sales`} className="items-end tabular-nums">
          <Text className="text-right tabular-nums text-foreground">{ctx.formatMoney(minorToDecimal(row.salesMinor, ctx.exponent))}</Text>
        </TableCell>
        <TableCell testID={`${rowTestID(row.id)}-counted`} className="items-end tabular-nums">
          <Text className="text-right tabular-nums text-foreground">{row.countedMinor === null ? '—' : ctx.formatMoney(minorToDecimal(row.countedMinor, ctx.exponent))}</Text>
        </TableCell>
        <TableCell testID={`${rowTestID(row.id)}-variance`} className="items-end tabular-nums">
          <Text className={`text-right tabular-nums ${varianceClass(row.varianceMinor)}`}>
            {row.varianceMinor === null ? '—' : varianceLabel(row.varianceMinor, ctx)}
          </Text>
        </TableCell>
        {onOpen ? <TableCell className="w-10 flex-none items-end">
          {openFor(row.id) ? <Text className="text-muted-foreground">›</Text> : null}
        </TableCell> : null}
      </TableRow>))])}</TableBody>
    </Table>
  </ScrollView>;
}
