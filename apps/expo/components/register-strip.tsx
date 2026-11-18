import { Fragment, useState, type JSX, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { AppText as Text } from './app-text';
import { Path } from 'react-native-svg';
import { createSvgIcon, IconButton } from '@tallyui/components';
import { formatClosureDate, minorToDecimal, type ClosureContext } from '@tallyui/pos';
import type { RegisterContextValue } from '../lib/register-context';
import { registerStripEquation } from '../lib/register-strip';
import { closureVarianceMinor, varianceLabel } from '../lib/reports';
import { RegisterPanelSheet } from './register';

const ChevronRightIcon = createSvgIcon('ChevronRightIcon', () => <Path d="m9 18 6-6-6-6" />);

/** The strip's Register and Last closure lines: a button to the register panel when it has one, else plain. */
function LeftBlock({ onPress, children }: { onPress?: () => void; children: ReactNode }) {
  return onPress ? <Pressable testID="register-strip-open-panel" accessibilityRole="button"
    accessibilityHint="Opens the register panel" className="flex-1 gap-1" onPress={onPress}>{children}</Pressable>
    : <View className="flex-1 gap-1">{children}</View>;
}

export function RegisterStrip({ register, ctx, action, panel, onOpenClosures }: {
  register: RegisterContextValue['register']; ctx: ClosureContext; action?: ReactNode;
  /** The strip's Register block opens the till's register panel, while there is a session or a last closure. */
  panel?: { currency: string; store: { name: string; address?: string } };
  /** v2's chevron at the strip's right edge opens Closures (reports/index.mdx#closures). */
  onOpenClosures?: () => void;
}): JSX.Element {
  const [panelOpen, setPanelOpen] = useState(false);
  const { session, terms, lastClosure, blind } = register;
  const open = session?.status === 'open';
  const active = open || session?.status === 'counting';
  const equation = active && terms && blind !== true ? registerStripEquation(terms) : null;
  const closedAt = lastClosure ? formatClosureDate(lastClosure.closed_at, ctx) : null;
  const variance = lastClosure ? closureVarianceMinor(lastClosure) : 0;
  const showPanel = !!panel && !!(session || lastClosure) && session?.status !== 'conflict';

  // v2's three rows: Register and Last closure on the left with the action and › at the top right, the chips below.
  return <><View testID="register-strip" className="gap-3 rounded-lg border border-border bg-card p-4">
    <View testID="register-strip-header" className="flex-row items-center gap-4">
      {/* A phone has no other way to the last closure's panel and its re-approval card while the register is closed. */}
      <LeftBlock onPress={showPanel ? () => setPanelOpen(true) : undefined}>
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="font-semibold text-foreground">Register</Text>
          <View className={`h-2 w-2 rounded-full ${open ? 'bg-success' : 'bg-muted'}`} />
          <Text testID="register-strip-status" className="text-foreground">{open ? 'Open' : active ? 'Counting' : 'Closed'}</Text>
          {active && session ? <Text testID="register-strip-since" className="text-muted-foreground">
            {`since ${formatClosureDate(session.opened_at_gmt, ctx).time}${session.opened_by ? ` · ${session.opened_by}` : ''}`}
          </Text> : null}
        </View>
        {lastClosure && closedAt ? <Text testID="register-strip-last-closure" className="text-sm text-muted-foreground">
          {`Last closure #${lastClosure.number} · ${closedAt.date === formatClosureDate(new Date().toISOString(), ctx).date ? 'Today' : closedAt.date} ${closedAt.time} · `}
          <Text className={variance === 0 ? 'text-muted-foreground' : variance < 0 ? 'text-destructive' : 'text-success'}>
            {varianceLabel(variance, ctx)}
          </Text>
        </Text> : null}
      </LeftBlock>
      {action || onOpenClosures ? <View className="shrink-0 flex-row items-center gap-2">
        {action}
        {onOpenClosures ? <IconButton testID="register-strip-open-closures" accessibilityRole="button" accessibilityLabel="Open closures"
          variant="ghost" onPress={onOpenClosures}>
          <View className="text-muted-foreground"><ChevronRightIcon size={20} /></View>
        </IconButton> : null}
      </View> : null}
    </View>
    {equation ? <View testID="register-strip-equation" className="flex-row flex-wrap items-center justify-end gap-2">
      {equation.chips.map((chip) => <Fragment key={chip.key}>
        {chip.op ? <Text className="text-muted-foreground">{chip.op}</Text> : null}
        <View testID={`register-strip-${chip.key}`} className="rounded-md bg-muted px-3 py-1">
          <Text className="text-xs text-muted-foreground">{chip.label}</Text>
          <Text className="text-foreground">{ctx.formatMoney(minorToDecimal(chip.amountMinor, ctx.exponent))}</Text>
        </View>
      </Fragment>)}
      <Text className="text-muted-foreground">=</Text>
      <View testID="register-strip-expected" className="rounded-md bg-primary px-3 py-1">
        <Text className="text-xs text-primary-foreground">Expected</Text>
        <Text className="text-primary-foreground">{ctx.formatMoney(minorToDecimal(equation.expectedMinor, ctx.exponent))}</Text>
      </View>
    </View> : null}
  </View>
  {/* Reports has no connection state of its own; the re-approval dialog checks the store is reachable itself. */}
  {showPanel ? <RegisterPanelSheet currency={panel.currency} store={panel.store} online open={panelOpen}
    onOpenChange={setPanelOpen} /> : null}
  </>;
}
