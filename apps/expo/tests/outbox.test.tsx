// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreSettings as PricingSettings } from '@tallyui/core';
import { medusaConnector } from '@tallyui/connector-medusa';
import {
  catalogueEntries, createOrderBuilder, finalizeOrder, needsAttention, TaxProvider, taxProviderProps, useSale, type PosOrder,
} from '@tallyui/pos';
import { StorageWorkerStartError } from '@tallyui/storage-sqlite/web';
import { markBusy, reportStorageStartFailure } from '../lib/live-tab';
import { useSessionOutbox } from '../lib/outbox-context';
import type { Session } from '../lib/session';
import { terminateWebStorage } from '../lib/web-storage';

// The outbox's two live-tab hooks, observed where they live (TV7 review): markBusy still runs for real;
// reportStorageStartFailure only records, since the real one latches the blocked screen for the whole run.
vi.mock('../lib/live-tab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/live-tab')>();
  return { ...actual, markBusy: vi.fn(actual.markBusy), reportStorageStartFailure: vi.fn() };
});

let outbox: ReturnType<typeof useSessionOutbox>;
let session: Session;
let sequence = 0;
const fetchStub = vi.fn<typeof fetch>();
function Harness({ session }: { session: Session | null }) {
  outbox = useSessionOutbox(session, 'register-1');
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
  vi.mocked(markBusy).mockClear();
  vi.mocked(reportStorageStartFailure).mockClear();
});
afterEach(async () => {
  const db = outbox.orders?.database;
  cleanup();
  if (db) await waitFor(() => expect(db.closed).toBe(true));
  vi.unstubAllGlobals();
});

describe('useSessionOutbox (TallyUI useOrderOutbox) with the TallyUI HTTP transport', () => {
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

// RxDB 16.21.1's query cache ("bug 4"): a sale inserted while the outbox's pending read is in flight was left
// out of that cached query for good, so it sat unsent until a restart. TallyUI #146 reads storage fresh on every
// drain; its own test is order-outbox.test.ts "sends a sale inserted while the pending read is in flight, and a
// later sale".
describe('a sale taken while the outbox is reading its pending sales', () => {
  it('is sent without a restart or remount', async () => {
    // The server applies whatever it is sent.
    fetchStub.mockImplementation(async (_url, init) => new Response(JSON.stringify({
      results: (JSON.parse(init!.body as string).commands as Array<{ id: string; payload: { totalMinor: number } }>).map((command) => ({
        id: command.id, status: 'applied', serverRefs: { orderId: `server-${command.id}`, totalMinor: command.payload.totalMinor } })),
    })));
    render(<Harness session={session} />);
    await waitFor(() => expect(outbox.orders).not.toBeNull());
    const collection = outbox.orders!;
    const [first, second] = [sale(new Date(2026, 0, 1, 9, 0)), sale(new Date(2026, 0, 1, 9, 1))];

    // Holds the outbox's read of its pending sales that answers with the first sale, after storage has answered
    // and before the outbox sees the answer: the moment RxDB's cached query missed a write.
    const storage = collection.storageInstance;
    const query = storage.query.bind(storage);
    let readAnswered!: () => void;
    const answered = new Promise<void>((resolve) => { readAnswered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let armed = true;
    vi.spyOn(storage, 'query').mockImplementation(async (prepared) => {
      const result = await query(prepared);
      if (armed && prepared.query.limit === 10 && JSON.stringify(prepared.query.selector).includes('"pending"')
        && result.documents.some((doc) => doc.id === first.id)) {
        armed = false;
        readAnswered();
        await released;
      }
      return result;
    });

    let recordingFirst!: Promise<void>;
    act(() => { recordingFirst = outbox.record(first); });
    await answered;
    // The second sale is recorded while that read is held.
    await act(async () => { await outbox.record(second); });
    release();
    await act(async () => { await recordingFirst; });

    const sent = () => fetchStub.mock.calls.flatMap(([, init]) => (JSON.parse(init!.body as string).commands as Array<{ id: string }>).map((c) => c.id));
    await waitFor(() => expect(sent()).toEqual([first.commandId, second.commandId]), { timeout: 5000 });
    await waitFor(() => expect(outbox.recent.map((order) => [order.id, order.syncStatus])).toEqual([
      [second.id, 'applied'], [first.id, 'applied'],
    ]));
    await waitFor(() => expect(outbox.state).toMatchObject({ pending: 0, sending: false }));
    expect(armed).toBe(false);
    // Same store, never reopened.
    expect(outbox.orders).toBe(collection);
    expect(collection.database.closed).toBe(false);
  });
});

describe('useSessionOutbox live-tab wiring (TV7 review)', () => {
  const outboxBusy = () => vi.mocked(markBusy).mock.calls.filter(([reason]) => reason === 'outbox').map(([, busy]) => busy);

  it('marks the outbox busy while a send is in flight, and clears it once the send settles', async () => {
    let respond!: (response: Response) => void;
    fetchStub.mockImplementation(() => new Promise((resolve) => { respond = resolve; }));
    render(<Harness session={session} />);
    await waitFor(() => expect(outbox.orders).not.toBeNull());
    expect(outboxBusy()).not.toContain(true);
    const order = sale();
    await act(async () => { await outbox.record(order); });
    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(outboxBusy().at(-1)).toBe(true));
    await act(async () => { respond(applied(order)); });
    await waitFor(() => expect(outbox.state.sending).toBe(false));
    await waitFor(() => expect(outboxBusy().at(-1)).toBe(false));
    // One send, one busy mark; everything after it clears (the effect's cleanup and its next run both pass false).
    const busy = outboxBusy();
    expect(busy.filter(Boolean)).toEqual([true]);
    expect(busy.slice(busy.indexOf(true) + 1).length).toBeGreaterThan(0);
  });

  it('an open that rejects with a storage-worker failure calls reportStorageStartFailure() exactly once', async () => {
    // Web storage "available" (a Worker and OPFS), whose worker fails to start as a pool held elsewhere does:
    // openOrderStore's real open path rejects with it, and nothing but live-tab is mocked.
    const failure = new StorageWorkerStartError('opfs-sahpool is held by another worker');
    class FailingWorker { constructor() { throw failure; } }
    vi.stubGlobal('Worker', FailingWorker);
    vi.stubGlobal('navigator', { ...navigator, storage: { getDirectory: async () => ({}) } });
    const opened: unknown[] = [];
    try {
      const view = render(<Harness session={session} />);
      await waitFor(() => expect(reportStorageStartFailure).toHaveBeenCalled());
      // A later render of the same store reopens nothing, so nothing reports again.
      view.rerender(<Harness session={{ ...session, token: 'refreshed-token' }} />);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(reportStorageStartFailure).toHaveBeenCalledTimes(1);
      expect(outbox.orders).toBeNull();
      await outbox.record(sale()).catch((error: unknown) => opened.push(error));
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({ name: 'StorageWorkerStartError' });
      expect(fetchStub).not.toHaveBeenCalled();
    } finally {
      terminateWebStorage();
    }
  });
});

// complete() idempotency (TallyUI #145) and the double tap, through this app's useSale and useSessionOutbox
// on the real order store. TallyUI covers the same cases in use-sale.test.tsx ("complete() is idempotent
// for one tender": "a throw after the insert, then a retry, ends with exactly one order in the outbox",
// "two complete() calls in the same tick, with a slow stamp, build one order") and in
// use-order-outbox.test.tsx ("recording an order that is already stored under the same commandId gives
// one stored order and still flushes").
describe('completing a sale into the outbox', () => {
  const pricing: PricingSettings = { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 } };
  const traits = medusaConnector.traits.product;
  const entries = catalogueEntries([{ id: 'shirt', title: 'Shirt', status: 'published', variants: [
    { id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12.5, currency_code: 'eur' }] },
  ] }], traits);
  let till: ReturnType<typeof useSale>;
  const recorded = vi.fn<(order: PosOrder) => void>();
  function Till({ session }: { session: Session }) {
    outbox = useSessionOutbox(session, 'register-1');
    // As app/index.tsx wires it: no session, and onSaleCompleted is the outbox's record.
    till = useSale(pricing, { registerId: 'register-1', cashierRef: session.email, onSaleCompleted: (order) => {
      recorded(order);
      return outbox.record(order);
    } });
    return null;
  }
  const renderTill = () => render(<Till session={session} />, { wrapper: ({ children }: { children: ReactNode }) =>
    <TaxProvider {...taxProviderProps(pricing)}>{children}</TaxProvider> });
  const sentCommands = () => fetchStub.mock.calls.flatMap(([, init]) => JSON.parse(init!.body as string).commands as Array<{ id: string }>);
  async function tenderByCard() {
    await waitFor(() => expect(outbox.orders).not.toBeNull());
    act(() => { till.add(entries[0], traits); });
    act(() => { till.startTender('external'); });
  }
  beforeEach(() => { recorded.mockReset(); });

  it('a store insert that throws after it wrote, then a retry of complete(), stores exactly one order and sends one command', async () => {
    let respond!: (response: Response) => void;
    fetchStub.mockImplementation(() => new Promise((resolve) => { respond = resolve; }));
    renderTill();
    await tenderByCard();
    // The insert lands, then its promise rejects (a write acknowledged late, a worker hiccup).
    const collection = outbox.orders!;
    const insert = collection.insert.bind(collection);
    vi.spyOn(collection, 'insert').mockImplementationOnce(async (doc) => {
      await insert(doc);
      throw new Error('storage acknowledged late');
    });

    await act(async () => { await till.complete(); });
    expect(till.error).toBe('The sale could not be saved: storage acknowledged late');
    expect(till.stage.kind).toBe('tender');
    expect(till.saving).toBe(true);
    const [first] = recorded.mock.calls[0];
    expect((await collection.find().exec()).map((doc) => doc.id)).toEqual([first.id]);

    await act(async () => { await till.complete(); });
    expect(till.stage.kind).toBe('receipt');
    expect(till.error).toBeNull();
    // The retry handed over the very same order: same id, commandId and createdAt.
    expect(recorded.mock.calls.map(([order]) => order)).toEqual([first, first]);
    await waitFor(() => expect(fetchStub).toHaveBeenCalled());
    await act(async () => { respond(applied(first)); });
    await waitFor(() => expect(outbox.recent[0]).toMatchObject({ id: first.id, syncStatus: 'applied' }));
    await waitFor(() => expect(outbox.state).toMatchObject({ pending: 0, sending: false }));
    const stored = (await collection.find().exec()).map((doc) => doc.toJSON());
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: first.id, commandId: first.commandId, createdAt: first.createdAt });
    expect(sentCommands().map((command) => command.id)).toEqual([first.commandId]);
  });

  it('a double tap on "Complete sale" records one order and sends one command', async () => {
    let respond!: (response: Response) => void;
    fetchStub.mockImplementation(() => new Promise((resolve) => { respond = resolve; }));
    renderTill();
    await tenderByCard();
    // Both taps reach the handler of the same render, before the first save settles.
    const tap = till.complete;
    await act(async () => { await Promise.all([tap(), tap()]); });
    expect(till.stage.kind).toBe('receipt');
    expect(recorded).toHaveBeenCalledTimes(1);
    const [order] = recorded.mock.calls[0];
    // A tap on the receipt does nothing either.
    await act(async () => { await tap(); await till.complete(); });
    expect(recorded).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetchStub).toHaveBeenCalled());
    await act(async () => { respond(applied(order)); });
    await waitFor(() => expect(outbox.recent[0]).toMatchObject({ id: order.id, syncStatus: 'applied' }));
    expect((await outbox.orders!.find().exec()).map((doc) => doc.id)).toEqual([order.id]);
    expect(sentCommands().map((command) => command.id)).toEqual([order.commandId]);
  });
});
