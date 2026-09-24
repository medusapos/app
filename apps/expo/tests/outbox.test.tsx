// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrderBuilder, finalizeOrder, type PosOrder } from '@tallyui/pos';
import { useOutbox } from '../lib/use-outbox';
import { needsAttention } from '../lib/order-store';
import type { Session } from '../lib/session';

let outbox: ReturnType<typeof useOutbox>;
let session: Session;
let sequence = 0;
const fetchStub = vi.fn<typeof fetch>();
function Harness({ session }: { session: Session | null }) {
  outbox = useOutbox(session, 'register-1');
  return null;
}
function sale(now?: Date): PosOrder {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
  builder.addPayment({ method: 'cash', amountMinor: 1200 });
  return finalizeOrder(builder.getSnapshot(), { registerId: 'register-1', now });
}
function applied(order: PosOrder) {
  return new Response(JSON.stringify({ results: [{ id: order.commandId, status: 'applied',
    serverRefs: { orderId: 'server-order', displayId: '42', totalMinor: order.totalMinor } }] }));
}
beforeEach(() => {
  session = { baseUrl: `https://outbox-${++sequence}.test`, email: 'cashier@test.com', token: 'old-token' };
  fetchStub.mockReset();
  vi.stubGlobal('fetch', fetchStub);
});
afterEach(async () => {
  const db = outbox.orders?.database;
  cleanup();
  if (db) await waitFor(() => expect(db.closed).toBe(true));
  vi.unstubAllGlobals();
});

describe('useOutbox with the TallyUI HTTP transport', () => {
  it('stores pending before returning and sends one command, then stores applied server refs', async () => {
    let respond!: (response: Response) => void;
    fetchStub.mockImplementation(() => new Promise((resolve) => { respond = resolve; }));
    render(<Harness session={session} />);
    await waitFor(() => expect(outbox.orders).not.toBeNull());
    const order = sale();
    await act(async () => { await outbox.record(order); });
    expect((await outbox.orders!.findOne(order.id).exec())?.syncStatus).toBe('pending');
    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    expect(outbox.state).toMatchObject({ pending: 1, sending: true });
    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe(`${session.baseUrl}/tally/v1/commands`);
    expect(init).toMatchObject({ method: 'POST', headers: { 'X-Tally-Protocol': '1', Authorization: 'Bearer old-token' } });
    expect(JSON.parse(init!.body as string).commands).toEqual([expect.objectContaining({
      id: order.commandId, type: 'order.create', deviceId: 'register-1', attempt: 1,
      payload: expect.objectContaining({ clientOrderId: order.id, totalMinor: order.totalMinor }),
    })]);
    await act(async () => { respond(applied(order)); });
    await waitFor(() => expect(outbox.recent[0]).toMatchObject({ syncStatus: 'applied',
      serverRefs: { orderId: 'server-order', displayId: '42', totalMinor: 1200 } }));
    await waitFor(() => expect(outbox.state).toMatchObject({ pending: 0, sending: false }));
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('leaves a network failure pending and exposes a retry reason and deadline', async () => {
    fetchStub.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<Harness session={session} />);
    await waitFor(() => expect(outbox.orders).not.toBeNull());
    const order = sale();
    await act(async () => { await outbox.record(order); });
    await waitFor(() => expect(outbox.state).toMatchObject({ pending: 1, sending: false, lastRetryReason: 'network' }));
    expect(outbox.state.nextAttemptAt).toBeGreaterThan(Date.now());
    expect((await outbox.orders!.findOne(order.id).exec())?.syncStatus).toBe('pending');
  });

  it('uses the refreshed token on the automatic retry without reopening the collection', async () => {
    const order = sale();
    fetchStub.mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValue(applied(order));
    const view = render(<Harness session={session} />);
    await waitFor(() => expect(outbox.orders).not.toBeNull());
    const collection = outbox.orders;
    await act(async () => { await outbox.record(order); });
    await waitFor(() => expect(outbox.state.lastRetryReason).toBe('unauthorized'));
    view.rerender(<Harness session={{ ...session, token: 'refreshed-token' }} />);
    expect(outbox.orders).toBe(collection);
    await waitFor(() => expect(outbox.recent[0]?.syncStatus).toBe('applied'), { timeout: 3000 });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(fetchStub.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer refreshed-token' });
    const commands = fetchStub.mock.calls.map(([, init]) => JSON.parse(init!.body as string).commands[0]);
    expect(commands.map((command) => command.id)).toEqual([order.commandId, order.commandId]);
    expect(commands.map((command) => command.attempt)).toEqual([1, 2]);
  });

  it('puts rejected responses in needs attention', async () => {
    const order = sale();
    const error = { code: 'unknown_variant', message: 'Variant was removed' };
    fetchStub.mockResolvedValue(new Response(JSON.stringify({ results: [{ id: order.commandId, status: 'rejected', error }] })));
    render(<Harness session={session} />);
    await waitFor(() => expect(outbox.orders).not.toBeNull());
    await act(async () => { await outbox.record(order); });
    await waitFor(() => expect(needsAttention(outbox.recent)).toEqual([expect.objectContaining({ id: order.id, syncStatus: 'rejected', error })]));
    await waitFor(() => expect(outbox.state.pending).toBe(0));
  });

  it('closes on sign-out and sends the preserved pending order after signing in again', async () => {
    fetchStub.mockRejectedValue(new TypeError('offline'));
    const view = render(<Harness session={null} />);
    expect(outbox.orders).toBeNull();
    expect(outbox.state).toEqual({ pending: 0, sending: false });
    await expect(outbox.record(sale())).rejects.toThrow('Orders are not ready');
    expect(fetchStub).not.toHaveBeenCalled();
    view.rerender(<Harness session={session} />);
    await waitFor(() => expect(outbox.orders).not.toBeNull());
    const order = sale();
    const oldDb = outbox.orders!.database;
    await act(async () => { await outbox.record(order); });
    await waitFor(() => expect(outbox.state.lastRetryReason).toBe('network'));
    view.rerender(<Harness session={null} />);
    expect(outbox.orders).toBeNull();
    expect(outbox.recent).toEqual([]);
    expect(outbox.state).toEqual({ pending: 0, sending: false });
    await waitFor(() => expect(oldDb.closed).toBe(true));
    fetchStub.mockResolvedValue(applied(order));
    view.rerender(<Harness session={{ ...session, token: 'signed-in-again' }} />);
    await waitFor(() => expect(outbox.recent[0]).toMatchObject({ id: order.id, syncStatus: 'applied' }));
    expect(fetchStub.mock.lastCall?.[1]?.headers).toMatchObject({ Authorization: 'Bearer signed-in-again' });
    expect(JSON.parse(fetchStub.mock.lastCall![1]!.body as string).commands[0].id).toBe(order.commandId);
  });

  it('keeps a live list limited to the newest 50 and closes when switching stores', async () => {
    fetchStub.mockRejectedValue(new TypeError('offline'));
    const view = render(<Harness session={session} />);
    await waitFor(() => expect(outbox.orders).not.toBeNull());
    const collection = outbox.orders!;
    const orders = Array.from({ length: 51 }, (_, i) => sale(new Date(2026, 0, 1, 0, i)));
    await act(async () => { await collection.bulkInsert(orders); });
    await waitFor(() => expect(outbox.recent).toHaveLength(50));
    expect(outbox.recent.map((order) => order.id)).toEqual(orders.slice(1).reverse().map((order) => order.id));
    view.rerender(<Harness session={{ ...session, baseUrl: `${session.baseUrl}/other` }} />);
    expect(outbox.recent).toEqual([]);
    await waitFor(() => expect(outbox.orders).not.toBeNull());
    expect(outbox.orders).not.toBe(collection);
    expect(collection.database.closed).toBe(true);
    expect(outbox.recent).toEqual([]);
  });
});
