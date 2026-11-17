import { Fragment, type JSX, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { formatClosureDate, minorToDecimal, type ClosureContext } from '@tallyui/pos';
import type { RegisterContextValue } from '../lib/register-context';
import { registerStripEquation } from '../lib/register-strip';
import { closureVarianceMinor, varianceLabel } from '../lib/reports';

export function RegisterStrip({ register, ctx, action }: {
  register: RegisterContextValue['register']; ctx: ClosureContext; action?: ReactNode;
}): JSX.Element {
  const { session, terms, lastClosure, blind } = register;
  const open = session?.status === 'open';
  const active = open || session?.status === 'counting';
  const equation = active && terms && blind !== true ? registerStripEquation(terms) : null;
  const closedAt = lastClosure ? formatClosureDate(lastClosure.closed_at, ctx) : null;
  const variance = lastClosure ? closureVarianceMinor(lastClosure) : 0;

  return <View testID="register-strip" className="flex-row flex-wrap items-center gap-4 rounded-lg border border-border bg-card p-4">
    <View className="gap-1">
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
    </View>
    {equation ? <View testID="register-strip-equation" className="flex-row flex-wrap items-center gap-2">
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
    {action ? <View className="ml-auto">{action}</View> : null}
  </View>;
}
