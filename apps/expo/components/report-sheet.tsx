import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import {
  Button, Dialog, DialogClose, DialogContent, DialogTitle, IconButton, Table, TableBody, TableCell, TableHead, TableHeader,
  TableRow, Text, XIcon,
} from '@tallyui/components';
import type { ReportPanel } from '../lib/report-panels';

// A Sales card's report in a right-hand sheet, as v2's Reports opens each card (reports/index.mdx).
export function ReportSheet({ panel, covers, onClose, onExport, onPrint, printing, printError, printIcon }: {
  panel: ReportPanel | null; covers: string; onClose: () => void; onExport?: () => void; onPrint?: () => void;
  printing: boolean; printError: string | null; printIcon?: ReactNode;
}) {
  const cellClass = (index: number) => panel?.columns[index]?.align === 'right' ? 'items-end' : undefined;
  const textClass = (index: number) => panel?.columns[index]?.align === 'right' ? 'text-right tabular-nums' : undefined;
  return <Dialog open={panel !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    {panel ? <DialogContent side="right" testID="report-sheet" className="flex-col p-0">
      <View className="flex-row items-start justify-between gap-3 p-4">
        <View className="flex-1 gap-1">
          <DialogTitle testID="report-sheet-title" className="text-lg font-semibold">{panel.title}</DialogTitle>
          <Text testID="report-sheet-covers" className="text-sm text-muted-foreground">{covers}</Text>
        </View>
        <DialogClose asChild>
          <IconButton variant="ghost" size="sm" accessibilityLabel="Close"><XIcon size={16} /></IconButton>
        </DialogClose>
      </View>
      <ScrollView className="flex-1" contentContainerClassName="px-4">
        {panel.rows.length === 0 ? <Text testID="report-sheet-empty" className="text-muted-foreground">None in this period</Text>
          : <Table>
            <TableHeader><TableRow>
              {panel.columns.map((column, i) => <TableHead key={column.label} className={cellClass(i)}>
                <Text className={textClass(i)}>{column.label}</Text>
              </TableHead>)}
            </TableRow></TableHeader>
            <TableBody>{panel.rows.map((row, r) => <TableRow key={r} testID="report-sheet-row">
              {row.map((cell, i) => <TableCell key={i} className={cellClass(i)}>
                <Text className={`text-foreground ${textClass(i) ?? ''}`}>{cell}</Text>
              </TableCell>)}
            </TableRow>)}</TableBody>
          </Table>}
      </ScrollView>
      <View className="gap-3 border-t border-border p-4">
        <Text testID="report-sheet-status" className="text-sm text-muted-foreground">{panel.status}</Text>
        {printError ? <Text accessibilityRole="alert" testID="report-sheet-print-error">{printError}</Text> : null}
        <View className="flex-row flex-wrap gap-2">
          <Button variant="outline" testID="report-sheet-close" onPress={onClose}><Text>Close</Text></Button>
          {onExport ? <Button variant="outline" testID="report-sheet-export" onPress={onExport}>
            <Text>Export CSV</Text>
          </Button> : null}
          {onPrint ? <Button testID="report-sheet-print" disabled={printing} onPress={onPrint}>
            {printIcon}<Text>{printing ? 'Printing…' : 'Print report'}</Text>
          </Button> : null}
        </View>
      </View>
    </DialogContent> : null}
  </Dialog>;
}
