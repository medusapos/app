// Test helpers for the register gate (ADR 0017): screens that complete sales get an open register session here,
// never by weakening the gate.
import type { RxCollection } from 'rxdb';
import { vi } from 'vitest';
import { bindRegister, openSession, type PosOrder, type RegisterSession } from '@tallyui/pos';
import { registerCollections } from '../lib/order-store';
import { DEFAULT_REGISTERS, type RegisterContextValue } from '../lib/register-context';

export const OPEN_SESSION: RegisterSession = {
  id: 'session-1', register_id: 'register-1', status: 'open', opened_at_gmt: '2026-09-28T08:00:00.000Z', counted_float_minor: 10000,
};

/**
 * `useRegister()`'s value with this till bound to Register 1 and its session open, for tests that mock
 * `../lib/register-context`: `requireOpen()` resolves the session id and `requireSaleSession()` the session, as
 * TallyUI's do for an open session.
 * `enabled: false` is the state while the order store opens (the outbox's `orders` is null).
 */
export function openRegisterFixture({ enabled = true }: { enabled?: boolean } = {}): RegisterContextValue {
  const saleSession = { id: OPEN_SESSION.id, sessions: { storageInstance: { findDocumentsById: async () => [OPEN_SESSION] } } };
  const register = {
    session: OPEN_SESSION, movements: [], expected: { cash: 10000 }, salesCount: 0, overdue: false, lastClosure: null,
    lastClosed: null, varianceThreshold: undefined, enabled, blind: false,
    // Rendered as open; the stamp reads it by primary key.
    saleSession,
    requireOpen: vi.fn(async () => OPEN_SESSION.id),
    // The gate's tender start (TallyUI #172): the confirmed session, which the tender pins.
    requireSaleSession: vi.fn(async () => saleSession),
    actions: {
      openSession: vi.fn(), startCounting: vi.fn(), backToSelling: vi.fn(), closeSession: vi.fn(),
      recordMovement: vi.fn(), voidMovement: vi.fn(),
    },
  } as unknown as RegisterContextValue['register'];
  return { register, boundRegisterId: 'register-1', registerName: 'Register 1', registers: DEFAULT_REGISTERS,
    registerOutbox: { state: { pending: 0, sending: false }, flush: vi.fn(async () => {}) },
    bind: vi.fn(async () => {}), unbind: vi.fn(async () => {}), setTenderInProgress: vi.fn(),
    close: { run: vi.fn(), shown: null, dismiss: vi.fn(), error: '' } };
}

/** Binds a real order store's till to Register 1 and opens its session (once), as the cashier would. */
export async function openTestRegister(orders: RxCollection<PosOrder>, storeKey: string): Promise<RegisterSession> {
  const { sessions } = registerCollections(orders);
  await bindRegister(sessions, storeKey, DEFAULT_REGISTERS[0]);
  const open = await sessions.findOne({ selector: { register_id: DEFAULT_REGISTERS[0].id, status: 'open' } }).exec();
  if (open) return open.toJSON() as RegisterSession;
  return (await openSession(sessions, { registerId: DEFAULT_REGISTERS[0].id, expectedFloatMinor: null, countedFloatMinor: 10000,
    openedBy: 'admin@store.test', businessDay: { year: 2026, month: 9, day: 28 }, storeKey })).toJSON() as RegisterSession;
}
