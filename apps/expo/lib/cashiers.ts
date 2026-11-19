import type { SalesOption } from '@tallyui/components';
import type { PosOrder } from '@tallyui/pos';
import type { Session } from './session';

/** An email's local part (the text before the first `@`); a ref with no `@` is its own label. */
const localPart = (ref: string) => ref.split('@').find((part) => part) ?? ref;

/**
 * The Reports cashier menu, built from the till's own sales (no server route): each distinct `cashierRef` the
 * screen holds, the signed-in user, and the selected cashier so a choice survives a date-range change. Values are
 * the `cashierRef` exactly, as `lib/reports.ts` filters on it; labels never show the email's `@` part.
 */
export function reportCashierOptions(
  sales: readonly Pick<PosOrder, 'cashierRef'>[],
  session: Pick<Session, 'email' | 'name'>,
  selectedId: string | null,
): SalesOption[] {
  const options = new Map<string, SalesOption>();
  options.set(session.email, { value: session.email, label: localPart(session.name || session.email) });
  const refs = sales.map((sale) => sale.cashierRef);
  if (selectedId) refs.push(selectedId);
  for (const ref of refs) if (ref && !options.has(ref)) options.set(ref, { value: ref, label: localPart(ref) });
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label));
}
