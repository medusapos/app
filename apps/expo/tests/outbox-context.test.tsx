// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOrderOutbox, type PosOrder, type UseOrderOutboxResult } from '@tallyui/pos';
import { OutboxProvider, useOutboxContext, type OutboxContextValue } from '../lib/outbox-context';

// A stand-in for TallyUI's outbox, whose `record` is a new function on every render, as the real one's is.
vi.mock('@tallyui/pos', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tallyui/pos')>(), useOrderOutbox: vi.fn(),
}));
vi.mock('../lib/session-context', () => ({ useSession: () => ({ session: null }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

// The #85 review: the provider counts `record` calls in flight, so the sale screen can hold sign-out on them.
describe('OutboxProvider savesInFlight', () => {
  it('counts each record until it resolves or rejects, passes the order and outcome through, and keeps record stable', async () => {
    const saves: { resolve: () => void; reject: (error: Error) => void }[] = [];
    const inner = vi.fn((_order: PosOrder) => new Promise<void>((resolve, reject) => { saves.push({ resolve, reject }); }));
    const records: UseOrderOutboxResult['record'][] = [];
    vi.mocked(useOrderOutbox).mockImplementation(() => {
      const record = (order: PosOrder) => inner(order);
      records.push(record);
      return { orders: null, state: { pending: 0, sending: false }, recent: [], record,
        isStored: vi.fn(), flush: vi.fn(), requeue: vi.fn() };
    });
    const seen: OutboxContextValue[] = [];
    function Probe() { seen.push(useOutboxContext()); return null; }
    await act(async () => { render(<OutboxProvider><Probe /></OutboxProvider>); });
    const latest = () => seen[seen.length - 1];
    const { record } = latest();
    expect(latest().savesInFlight).toBe(0);

    const first = { id: 'first' } as PosOrder;
    const second = { id: 'second' } as PosOrder;
    let firstSave!: Promise<void>;
    let secondSave!: Promise<void>;
    act(() => { firstSave = record(first); secondSave = record(second); });
    const secondOutcome = secondSave.catch((error: unknown) => error);
    expect(latest().savesInFlight).toBe(2);
    expect(inner.mock.calls).toEqual([[first], [second]]);
    // Re-rendered, with a new TallyUI record each time: the context's record keeps its identity.
    expect(new Set(records).size).toBeGreaterThan(1);
    expect(seen.every((value) => value.record === record)).toBe(true);

    await act(async () => { saves[0].resolve(); });
    await expect(firstSave).resolves.toBeUndefined();
    expect(latest().savesInFlight).toBe(1);
    const failure = new Error('Storage full');
    await act(async () => { saves[1].reject(failure); });
    expect(await secondOutcome).toBe(failure);
    expect(latest().savesInFlight).toBe(0);
    expect(latest().record).toBe(record);
  });
});
