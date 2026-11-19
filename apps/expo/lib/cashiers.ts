import type { SalesOption } from '@tallyui/components';
import { authHeaders } from './pos-connector';
import type { Session } from './session';

/** The store's users for the Reports cashier menu, valued by email as the till records `cashierRef`; `[]` on any failure. */
export async function fetchCashiers(session: Pick<Session, 'baseUrl' | 'token'>, fetchImpl = globalThis.fetch): Promise<SalesOption[]> {
  try {
    const response = await fetchImpl(`${session.baseUrl}/tally/v1/cashiers`, { headers: authHeaders(session.token) });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('cashiers' in body) || !Array.isArray(body.cashiers)) return [];
    return body.cashiers.flatMap((row: unknown) => {
      if (typeof row !== 'object' || row === null) return [];
      const { email, name } = row as { email?: unknown; name?: unknown };
      return typeof email === 'string' && email && typeof name === 'string' && name ? [{ value: email, label: name }] : [];
    });
  } catch { return []; }
}

/** The menu's cashiers: the fetched users plus the signed-in one, so they are listed even offline or on an older plugin. */
export function reportCashierOptions(fetched: SalesOption[], session: Pick<Session, 'email' | 'name'>): SalesOption[] {
  const options = new Map<string, SalesOption>();
  for (const option of fetched) if (!options.has(option.value)) options.set(option.value, option);
  if (!options.has(session.email)) options.set(session.email, { value: session.email, label: session.name || session.email });
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label));
}
