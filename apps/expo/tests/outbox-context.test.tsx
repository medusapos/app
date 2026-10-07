// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOrderOutbox, type UseOrderOutboxResult } from '@tallyui/pos';
import { OutboxProvider, useOutboxContext, useSessionOutbox } from '../lib/outbox-context';
import type { Session } from '../lib/session';

// A stand-in for TallyUI's outbox, whose `savesInFlight` (#163) each test sets.
vi.mock('@tallyui/pos', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tallyui/pos')>(), useOrderOutbox: vi.fn(),
}));
const setSavesHold = vi.fn();
const reportNoPosAccess = vi.fn();
vi.mock('../lib/session-context', () => ({ useSession: () => ({ session: null, setSavesHold, reportNoPosAccess }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('useSessionOutbox order.create version', () => {
  const session: Session = { baseUrl: 'https://store.test', email: 'test@example.com', token: 'token',
    capabilities: { orderCreate: 4 } };
  beforeEach(() => vi.mocked(useOrderOutbox).mockReturnValue({ orders: null } as UseOrderOutboxResult));

  it('passes getMaxOrderCreateVersion, which reads the current session\'s orderCreate capability (#147)', () => {
    const view = renderHook(({ session }) => useSessionOutbox(session, 'register-1'),
      { initialProps: { session: session as Session | null } });
    const getMaxOrderCreateVersion = vi.mocked(useOrderOutbox).mock.calls[0][0].getMaxOrderCreateVersion!;
    expect(getMaxOrderCreateVersion()).toBe(4);
    view.rerender({ session: { ...session, capabilities: { ...session.capabilities, orderCreate: 3 } } });
    expect(getMaxOrderCreateVersion()).toBe(3);
    view.rerender({ session: null });
    expect(getMaxOrderCreateVersion()).toBeUndefined();
  });

  it('keeps getMaxOrderCreateVersion present on every call, so the outbox never needs a reopen (#147)', () => {
    vi.mocked(useOrderOutbox).mockClear();
    const view = renderHook(({ session }) => useSessionOutbox(session, 'register-1'),
      { initialProps: { session: session as Session | null } });
    view.rerender({ session: null });
    expect(vi.mocked(useOrderOutbox).mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [options] of vi.mocked(useOrderOutbox).mock.calls) {
      expect(options.getMaxOrderCreateVersion).toBeTypeOf('function');
    }
  });
});

// The #85 re-review: TallyUI counts the saves in flight, and OutboxProvider holds the session's sign-out on them.
describe('OutboxProvider savesInFlight', () => {
  it('passes TallyUI\'s outbox through and holds sign-out while a save is in flight; its unmount releases without running', async () => {
    let outbox!: UseOrderOutboxResult;
    const next = (savesInFlight: number) => {
      outbox = { orders: null, state: { pending: 0, sending: false }, recent: [], record: vi.fn(),
        isStored: vi.fn(), flush: vi.fn(), requeue: vi.fn(), savesInFlight, stuckCommandIds: [] };
    };
    vi.mocked(useOrderOutbox).mockImplementation(() => outbox);
    let seen!: UseOrderOutboxResult;
    function Probe() { seen = useOutboxContext(); return null; }
    const tree = () => <OutboxProvider><Probe /></OutboxProvider>;
    next(0);
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(tree()); });
    expect(seen).toBe(outbox);
    expect(setSavesHold.mock.calls).toEqual([[false]]);

    next(1);
    await act(async () => { view.rerender(tree()); });
    expect(seen).toBe(outbox);
    expect(seen.savesInFlight).toBe(1);
    expect(setSavesHold.mock.lastCall).toEqual([true]);
    // A second save in flight changes nothing: the hold is on the count being above 0.
    next(2);
    await act(async () => { view.rerender(tree()); });
    expect(setSavesHold).toHaveBeenCalledTimes(2);

    next(0);
    await act(async () => { view.rerender(tree()); });
    expect(setSavesHold.mock.lastCall).toEqual([false]);
    next(1);
    await act(async () => { view.rerender(tree()); });
    expect(setSavesHold.mock.lastCall).toEqual([true]);

    // A park or #80's prompt unmounts it: released, but a pending sign-out isn't run under LiveTabGate's close.
    setSavesHold.mockClear();
    view.unmount();
    expect(setSavesHold.mock.calls).toEqual([[false, false]]);
  });
});

describe('OutboxProvider POS access', () => {
  it('reports a 403 refusal but not other or absent refusals', async () => {
    let outbox: UseOrderOutboxResult = { orders: null, state: { pending: 0, sending: false }, recent: [],
      record: vi.fn(), isStored: vi.fn(), flush: vi.fn(), requeue: vi.fn(), savesInFlight: 0, stuckCommandIds: [] };
    vi.mocked(useOrderOutbox).mockImplementation(() => outbox);
    const tree = () => <OutboxProvider />;
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(tree()); });
    expect(reportNoPosAccess).not.toHaveBeenCalled();

    outbox = { ...outbox, state: { pending: 0, sending: false, refused: { status: 422, reason: 'invalid' } } };
    await act(async () => { view.rerender(tree()); });
    expect(reportNoPosAccess).not.toHaveBeenCalled();

    outbox = { ...outbox, state: { pending: 0, sending: false, refused: { status: 403, reason: 'forbidden' } } };
    await act(async () => { view.rerender(tree()); });
    expect(reportNoPosAccess).toHaveBeenCalledTimes(1);
  });
});
