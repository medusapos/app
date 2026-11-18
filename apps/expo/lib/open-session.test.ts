import { describe, expect, it } from 'vitest';
import type { RegisterSession } from '@tallyui/pos';
import { openSessionOf } from './open-session';

function register(status: RegisterSession['status'] | null, overrides: { blind?: boolean; terms?: null } = {}) {
  return {
    session: status === null ? null : { id: 's1', register_id: 'register-1', status, opened_at_gmt: '2026-09-11T08:00:00Z',
      opened_by: 'ana@store.test', counted_float_minor: 1000 } as RegisterSession,
    terms: { expected: { cash: 4000 } } as unknown as Parameters<typeof openSessionOf>[0]['terms'],
    salesCount: 2, blind: false, ...overrides,
  };
}

describe('openSessionOf', () => {
  it('summarises an open session with the strip\'s expected cash, sales, opener and float', () => {
    expect(openSessionOf(register('open'))).toEqual({ status: 'open', openedAt: '2026-09-11T08:00:00Z',
      openedBy: 'ana@store.test', salesCount: 2, expectedCashMinor: 4000, floatMinor: 1000 });
  });
  it('a counting session is still the live session', () => {
    expect(openSessionOf(register('counting'))?.status).toBe('counting');
  });
  it('a closed, conflicting or missing session has no summary', () => {
    for (const status of ['closed', 'conflict', 'superseded', 'abandoned', null] as const)
      expect(openSessionOf(register(status))).toBeNull();
  });
  it('a blind cashier gets no expected cash; no terms read as no expected cash too', () => {
    expect(openSessionOf(register('open', { blind: true }))?.expectedCashMinor).toBeNull();
    expect(openSessionOf(register('open', { terms: null }))?.expectedCashMinor).toBeNull();
  });
  it('a session without an opener reads openedBy null', () => {
    const value = register('open');
    expect(openSessionOf({ ...value, session: { ...value.session!, opened_by: undefined } })?.openedBy).toBeNull();
  });
});
