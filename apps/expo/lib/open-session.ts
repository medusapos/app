import type { RegisterContextValue } from './register-context';

/** The register's live session as Closures (and later its stat cards) show it: v2's "● Open · Register 1" row. */
export type OpenSessionSummary = {
  status: 'open' | 'counting';
  openedAt: string;
  /** The opener's cashier id, the same id space as a closure's `closed_by`. */
  openedBy: string | null;
  salesCount: number;
  /** The strip's Expected cash; `null` for a blind cashier, who never sees expected figures. */
  expectedCashMinor: number | null;
  floatMinor: number;
};

/** The open (or counting) session of the register, else `null`. */
export function openSessionOf(register: Pick<RegisterContextValue['register'],
  'session' | 'terms' | 'salesCount' | 'blind'>): OpenSessionSummary | null {
  const { session } = register;
  if (session?.status !== 'open' && session?.status !== 'counting') return null;
  return {
    status: session.status,
    openedAt: session.opened_at_gmt,
    openedBy: session.opened_by ?? null,
    salesCount: register.salesCount,
    expectedCashMinor: register.blind === true ? null : register.terms?.expected.cash ?? null,
    floatMinor: session.counted_float_minor,
  };
}

/**
 * The session opener's name as the app shows it: `opened_by` is the opener's cashier id, which this app records as the
 * cashier's email, so the signed-in cashier's own session reads as their display name. `null` without an opener.
 */
export function openerName(openedBy: string | null | undefined, signedInEmail: string, displayName: string): string | null {
  if (!openedBy) return null;
  return openedBy === signedInEmail ? displayName : openedBy;
}
