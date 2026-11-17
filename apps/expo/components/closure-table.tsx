import { ScrollView, Text } from 'react-native';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Text as TableText } from '@tallyui/components';
import { formatClosureDate, minorToDecimal, type ClosureContext } from '@tallyui/pos';
import { varianceLabel, type ClosureTableRow } from '../lib/reports';

export function ClosureTable({ rows, ctx, testID, rowTestID }: {
  rows: ClosureTableRow[]; ctx: ClosureContext; testID: string; rowTestID: (id: string) => string;
}) {
  if (rows.length === 0) return null;
  return <ScrollView horizontal contentContainerClassName="grow">
    <Table testID={testID} className="min-w-[720px] w-full">
      <TableHeader><TableRow>
        {['Closure', 'Closed', 'Register', 'Cashier', 'Sales', 'Counted', 'Variance'].map((label, index) =>
          <TableHead key={label} className={index >= 4 ? 'items-end' : undefined}>
            <TableText className={index >= 4 ? 'text-right' : undefined}>{label}</TableText>
          </TableHead>)}
      </TableRow></TableHeader>
      <TableBody>{rows.map((row) => <TableRow key={row.id} testID={rowTestID(row.id)}>
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
          <Text className={`text-right tabular-nums ${row.varianceMinor === null || row.varianceMinor === 0 ? 'text-muted-foreground' : row.varianceMinor < 0 ? 'text-destructive' : 'text-success'}`}>
            {row.varianceMinor === null ? '—' : varianceLabel(row.varianceMinor, ctx)}
          </Text>
        </TableCell>
      </TableRow>)}</TableBody>
    </Table>
  </ScrollView>;
}
