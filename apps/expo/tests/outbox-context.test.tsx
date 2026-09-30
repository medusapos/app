// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOrderOutbox, type UseOrderOutboxResult } from '@tallyui/pos';
import { OutboxProvider, useOutboxContext } from '../lib/outbox-context';

// A stand-in for TallyUI's outbox, whose `savesInFlight` (#163) each test sets.
vi.mock('@tallyui/pos', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tallyui/pos')>(), useOrderOutbox: vi.fn(),
}));
const setSavesHold = vi.fn();
vi.mock('../lib/session-context', () => ({ useSession: () => ({ session: null, setSavesHold }) }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

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
