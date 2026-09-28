// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import type { RxCollection } from 'rxdb';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ProductGrid, SearchInput } from '@tallyui/components';
import type { StoreSettings as PricingSettings } from '@tallyui/core';
import { medusaConnector } from '@tallyui/connector-medusa';
import {
  catalogueEntries, createOrderBuilder, finalizeOrder, needsAttention, OrderContentMismatchError, outboxLogger, posOrdersLogger, saleLogger,
  TaxProvider, taxProviderProps, useSale, useStoreSettings, type PosOrder,
} from '@tallyui/pos';
import { StorageWorkerStartError } from '@tallyui/storage-sqlite/web';
import ProductsScreen from '../app/index';
import OrdersScreen from '../app/orders';
import { markBusy, reportStorageStartFailure } from '../lib/live-tab';
import { installLogSinks } from '../lib/logging';
import { OutboxProvider, useOutboxContext, useSessionOutbox } from '../lib/outbox-context';
import { posConnector } from '../lib/pos-connector';
import { saveSession, type Session } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { fetchStoreSettings, saveCachedSettings, type StoreSettings } from '../lib/store-settings';
import { terminateWebStorage } from '../lib/web-storage';
import { openTestRegister } from './register-fixture';
import { setWindowWidth } from './window-width';

// The outbox's two live-tab hooks, observed where they live (TV7 review): markBusy still runs for real;
// reportStorageStartFailure only records, since the real one latches the blocked screen for the whole run.
vi.mock('../lib/live-tab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/live-tab')>();
  return { ...actual, markBusy: vi.fn(actual.markBusy), reportStorageStartFailure: vi.fn() };
});
// The real order store, with a hook that runs on each opened collection before the outbox sees it
// (the #151 test holds the Orders list's first storage read).
const openHook = vi.hoisted(() => ({ onOpen: undefined as undefined | ((orders: RxCollection<PosOrder>) => void) }));
vi.mock('../lib/order-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/order-store')>();
  return { ...actual, openOrderStore: async (baseUrl: string) => {
    const store = await actual.openOrderStore(baseUrl);
    openHook.onOpen?.(store.orders);
    return store;
  } };
});
// For the Products screen on the real outbox (the last describe): only the router, the catalogue's replication,
// the store settings and the component primitives are stubbed, as in products-screen.test.tsx.
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn() },
  Stack: { Screen: ({ options }: { options: { headerRight?: () => ReactNode } }) => options.headerRight?.() ?? null },
}));
vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));
const shirt = vi.hoisted(() => ({ id: 'shirt', title: 'Shirt', status: 'published', variants: [
  { id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12.5, currency_code: 'eur' }] },
] }));
vi.mock('../lib/use-replicated-products', () => {
  const replicated = { products: [shirt], state: 'synced', error: null, lastSyncedAt: null, stockOverlay: undefined,
    lastStockCheckAt: null, reconcileStock: async () => {}, unlisted: undefined };
  return { useReplicatedProducts: () => replicated };
});
vi.mock('@tallyui/pos', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tallyui/pos')>(), useStoreSettings: vi.fn(),
}));
vi.mock('../lib/store-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/store-settings')>(), fetchStoreSettings: vi.fn(),
}));
vi.mock('@tallyui/components/product', () => ({
  ProductGrid: ({ items, renderItem, emptyState }: ComponentProps<typeof ProductGrid>) => (
    <div>{items.length ? items.map((item, index) => <div key={item.id}>{renderItem(item, index)}</div>) : emptyState}</div>
  ),
  ProductImage: () => null,
  ProductTitle: ({ doc }: { doc: { title?: ReactNode } }) => <span>{doc.title}</span>,
  ProductPrice: () => null,
  ProductStockBadge: () => null,
}));
vi.mock('@tallyui/components/ui', () => ({
  VStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@tallyui/components/input', () => ({
  SearchInput: ({ value, onChangeText, placeholder }: ComponentProps<typeof SearchInput>) => (
    <input value={value} placeholder={placeholder} onChange={(event) => onChangeText(event.target.value)} />
  ),
}));
vi.mock('@tallyui/components/cart', () => ({
  CartPanel: <T,>({ items, renderItem, emptyState, afterItems, footer }:
    { items: T[]; renderItem: (item: T, index: number) => ReactNode; emptyState?: ReactNode; afterItems?: ReactNode; footer?: ReactNode }) => <div>
    {items.length ? items.map((item, index) => <div key={index}>{renderItem(item, index)}</div>) : emptyState}
    {afterItems}{footer}
  </div>,
  CartLine: ({ name }: { name: string }) => <div>{name}</div>,
  CartTotal: () => null,
  CartLineActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DiscountBadge: () => null,
}));
vi.mock('@tallyui/components/checkout', () => ({ CashTendered: () => null, ChangeDisplay: () => null }));

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

  // TallyUI #151: `recent` (the Orders list) re-reads storage on every change (watchFresh). A cached find().$ could
  // miss an order written while its first read was in flight, and stay stale until a reload (RxDB 16.21.1 bug 4).
  it('shows an order recorded while the Orders list\'s first read is in flight, without a reload', async () => {
    fetchStub.mockRejectedValue(new TypeError('offline'));
    const order = sale();
    let readAnswered!: () => void;
    const answered = new Promise<void>((resolve) => { readAnswered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    // Holds the list's first read (limit 50) after storage answered, before the list sees the answer.
    openHook.onOpen = (orders) => {
      const storage = orders.storageInstance;
      const query = storage.query.bind(storage);
      let armed = true;
      vi.spyOn(storage, 'query').mockImplementation(async (prepared) => {
        const result = await query(prepared);
        if (armed && prepared.query.limit === 50) { armed = false; readAnswered(); await released; }
        return result;
      });
    };
    try {
      render(<Harness session={session} />);
      await answered;
      await waitFor(() => expect(outbox.orders).not.toBeNull());
      await act(async () => { await outbox.record(order); });
      release();
      await waitFor(() => expect(outbox.recent.map((recent) => [recent.id, recent.syncStatus])).toEqual([[order.id, 'pending']]));
    } finally {
      openHook.onOpen = undefined;
    }
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
    // As app/index.tsx wires it: no session, onSaleCompleted is the outbox's record, and isStored is the outbox's.
    till = useSale(pricing, { registerId: 'register-1', cashierRef: session.email, onSaleCompleted: (order) => {
      recorded(order);
      return outbox.record(order);
    }, isStored: outbox.isStored });
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

  // TallyUI #150: no new sale while a save is in flight. This app passes no register session, so complete() builds
  // its order synchronously and the "building or stamping" window has no await to hold; the save it hands to
  // record() is what a cashier can wait on.
  it('refuses newSale() and continueSale() while a save is held in flight, then shows the receipt once it lands', async () => {
    fetchStub.mockRejectedValue(new TypeError('offline'));
    renderTill();
    await tenderByCard();
    const collection = outbox.orders!;
    const insert = collection.insert.bind(collection);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(collection, 'insert').mockImplementationOnce(async (doc) => { await held; return insert(doc); });
    const lines = till.order.lineItems;
    let completion!: Promise<void>;
    act(() => { completion = till.complete(); });
    expect(till.saving).toBe(true);
    act(() => { till.newSale(); });
    expect(till.error).toBe('This sale is being saved. Retry to finish it.');
    act(() => { till.continueSale(); });
    expect(till.stage).toEqual({ kind: 'tender', method: 'external' });
    expect(till.order.lineItems).toBe(lines);
    expect(till.canContinue).toBe(false);

    release();
    await act(async () => { await completion; });
    expect(till.stage.kind).toBe('receipt');
    expect(till.error).toBeNull();
    expect(recorded).toHaveBeenCalledTimes(1);
    expect((await collection.find().exec()).map((doc) => doc.id)).toEqual([recorded.mock.calls[0][0].id]);
  });

  // TallyUI #149: after a failed save, newSale() is refused until the outbox's isStored confirms the order.
  it('refuses newSale() after a failed save until isStored confirms the order is stored', async () => {
    fetchStub.mockRejectedValue(new TypeError('offline'));
    renderTill();
    await tenderByCard();
    const collection = outbox.orders!;
    const insert = collection.insert.bind(collection);
    // The first save never lands; the retry's lands, then its promise rejects.
    vi.spyOn(collection, 'insert')
      .mockImplementationOnce(async () => { throw new Error('disk full'); })
      .mockImplementationOnce(async (doc) => { await insert(doc); throw new Error('storage acknowledged late'); });

    await act(async () => { await till.complete(); });
    expect(till.error).toBe('The sale could not be saved: disk full');
    // isStored has answered (not stored) once the store's read settles.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(till.canContinue).toBe(false);
    const lines = till.order.lineItems;
    act(() => { till.newSale(); });
    expect(till.error).toBe('This sale is being saved. Retry to finish it.');
    expect(till.stage).toEqual({ kind: 'tender', method: 'external' });
    expect(till.order.lineItems).toBe(lines);
    expect(till.saving).toBe(true);
    expect(await collection.find().exec()).toEqual([]);

    await act(async () => { await till.complete(); });
    expect(till.error).toBe('The sale could not be saved: storage acknowledged late');
    await waitFor(() => expect(till.canContinue).toBe(true));
    act(() => { till.newSale(); });
    expect(till.stage).toEqual({ kind: 'cart' });
    expect(till.order.lineItems).toEqual([]);
    expect(till.saving).toBe(false);
    expect(till.error).toBeNull();
    // Both attempts handed over the same order; it is stored once.
    const [first] = recorded.mock.calls[0];
    expect(recorded.mock.calls.map(([order]) => order)).toEqual([first, first]);
    expect((await collection.find().exec()).map((doc) => doc.id)).toEqual([first.id]);
  });
});

// lib/logging.ts: the app's console sink on TallyUI's sale, outbox and pos-orders loggers.
describe('the money-path log sinks', () => {
  beforeAll(() => installLogSinks());

  it('sends saleLogger, outboxLogger and posOrdersLogger warn and error to the console with scope, message and data, and nothing below warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      saleLogger.warn('A probe', { orderId: 'order-1' });
      outboxLogger.error('Another probe', { orderId: 'order-2' });
      posOrdersLogger.warn('A third probe', { database: 'db-1' });
      saleLogger.info('Not sent');
      saleLogger.debug('Not sent either');
      expect(warn).toHaveBeenNthCalledWith(1, '[sale] A probe', { orderId: 'order-1' });
      expect(warn).toHaveBeenNthCalledWith(2, '[pos-orders] A third probe', { database: 'db-1' });
      expect(error).toHaveBeenCalledExactlyOnceWith('[outbox] Another probe', { orderId: 'order-2' });
      expect(log).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore(); error.mockRestore(); log.mockRestore(); info.mockRestore();
    }
  });

  it('never throws, even when the console does', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('console is gone'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('console is gone'); });
    try {
      expect(() => saleLogger.warn('A probe')).not.toThrow();
      expect(() => outboxLogger.error('A probe', { orderId: 'order-1' })).not.toThrow();
      expect(() => posOrdersLogger.warn('A probe')).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore(); error.mockRestore();
    }
  });
});

// The Products screen's own useSale call (app/index.tsx) on the real session, outbox provider, order store and
// HTTP transport (TallyUI ce184e6, #149): Continue after a failed save, a requeued order's retry, a content
// mismatch, and the Sign out lock while a save is pending.
describe('the Products screen on the real outbox (TallyUI ce184e6)', () => {
  const storeSettings: StoreSettings = {
    storeName: 'Test shop', currency: 'EUR', location: { id: 'loc', name: 'Main', countryCode: 'dk' },
  };
  const screenPricing: PricingSettings = { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 } };
  const button = (name: string | RegExp) => screen.getByRole('button', { name });
  const sent = () => fetchStub.mock.calls.flatMap(([, init]) => (JSON.parse(init!.body as string).commands as Array<{ id: string }>)
    .map((command) => command.id));
  // The server answers every command it is sent with this status.
  const answerAll = (status: 'applied' | 'rejected') => async (_url: unknown, init?: RequestInit) => new Response(JSON.stringify({
    results: (JSON.parse(init!.body as string).commands as Array<{ id: string; payload: { totalMinor: number } }>).map((command) =>
      status === 'applied'
        ? { id: command.id, status, serverRefs: { orderId: `server-${command.id}`, totalMinor: command.payload.totalMinor } }
        : { id: command.id, status, error: { code: 'unknown_variant', message: 'Variant was removed' } }),
  }));
  function CaptureOutbox() {
    outbox = useOutboxContext();
    return null;
  }
  let warn: MockInstance<typeof console.warn>;
  let error: MockInstance<typeof console.error>;
  beforeAll(() => installLogSinks());
  beforeEach(() => {
    setWindowWidth(1280);
    // jsdom's own localStorage throws on its opaque origin; unstubbed by the file's afterEach.
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    });
    saveSession(localStorage, { ...session, token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature` });
    saveCachedSettings(localStorage, session.baseUrl, storeSettings);
    vi.mocked(fetchStoreSettings).mockResolvedValue(storeSettings);
    vi.mocked(useStoreSettings).mockReturnValue({ state: 'ready', settings: screenPricing });
    vi.spyOn(posConnector, 'capabilities').mockResolvedValue(undefined);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.mocked(posConnector.capabilities!).mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  function App({ products = true, orders = false }: { products?: boolean; orders?: boolean }) {
    return <SessionProvider><OutboxProvider>
      <CaptureOutbox />{products ? <ProductsScreen /> : null}{orders ? <OrdersScreen /> : null}
    </OutboxProvider></SessionProvider>;
  }
  async function tenderShirtByCard(withOrders = false) {
    const view = render(<App orders={withOrders} />);
    await waitFor(() => expect(outbox.orders).not.toBeNull());
    // The cashier binds Register 1 and opens it (ADR 0017): paying needs an open session.
    await act(async () => { await openTestRegister(outbox.orders!, session.baseUrl); });
    await waitFor(() => expect(screen.queryByTestId('open-register-card')).toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: 'Shirt' }));
    fireEvent.click(button('Card terminal'));
    await screen.findByRole('button', { name: 'Payment approved on terminal' });
    return view;
  }
  /** Makes the next store insert write `stored(doc)` and then reject; resolves to the order the sale handed over. */
  function insertWritesThenThrows(stored: (doc: PosOrder) => PosOrder = (doc) => doc): Promise<PosOrder> {
    const collection = outbox.orders!;
    const insert = collection.insert.bind(collection);
    return new Promise((handed) => {
      vi.spyOn(collection, 'insert').mockImplementationOnce(async (doc) => {
        handed(doc as PosOrder);
        await insert(stored(doc as PosOrder));
        throw new Error('storage acknowledged late');
      });
    });
  }
  const approve = () => act(async () => { fireEvent.click(button('Payment approved on terminal')); });
  const signOutDisabled = () => button('Sign out').getAttribute('aria-disabled') === 'true';

  it('offers Continue once isStored confirms an order whose insert wrote and then threw; Continue starts a new sale, with one order and one command', async () => {
    let respond!: (response: Response) => void;
    fetchStub.mockImplementation(() => new Promise((resolve) => { respond = resolve; }));
    await tenderShirtByCard();
    const handed = insertWritesThenThrows();
    await approve();
    const order = await handed;
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('The sale could not be saved: storage acknowledged late'));
    const continueButton = await screen.findByRole('button', { name: 'Continue' });
    expect(screen.getByText('This sale is stored and will be sent. Continue to the next sale.')).toBeTruthy();
    expect(signOutDisabled()).toBe(true);

    fireEvent.click(continueButton);
    expect(screen.getByText('Scan or tap a product to start a sale.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Print receipt' })).toBeNull();
    expect(signOutDisabled()).toBe(false);

    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    await act(async () => { respond(applied(order)); });
    await waitFor(() => expect(outbox.recent[0]).toMatchObject({ id: order.id, syncStatus: 'applied' }));
    await waitFor(() => expect(outbox.state).toMatchObject({ pending: 0, sending: false }));
    const stored = (await outbox.orders!.find().exec()).map((doc) => doc.toJSON());
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: order.id, commandId: order.commandId });
    expect(sent()).toEqual([order.commandId]);
  });

  it.each([['works', false], ['throws', true]])(
    'a failed save requeued from Orders, then retried on the tender, resolves as stored: one order, and the till continues (console %s)',
    async (_console, throwing) => {
      if (throwing) warn.mockImplementation(() => { throw new Error('console is gone'); });
      // The server rejects the first command with a requeueable code, then applies whatever it is sent.
      fetchStub.mockImplementationOnce(answerAll('rejected')).mockImplementation(answerAll('applied'));
      await tenderShirtByCard(true);
      const handed = insertWritesThenThrows();
      await approve();
      const order = await handed;
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('The sale could not be saved: storage acknowledged late'));
      await waitFor(() => expect(outbox.recent[0]).toMatchObject({ id: order.id, syncStatus: 'rejected' }));

      // Orders' Retry is the outbox's requeue: the stored order is pending again under a new commandId, and is sent.
      await act(async () => { fireEvent.click(button('Retry')); });
      await waitFor(() => expect(outbox.recent[0]).toMatchObject({ id: order.id, syncStatus: 'applied' }));
      const requeued = outbox.recent[0].commandId;
      expect(requeued).not.toBe(order.commandId);

      // The tender's retry hands over the same order under its original commandId: stored, never overwritten.
      await approve();
      expect(await screen.findByRole('button', { name: 'Print receipt' })).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(warn).toHaveBeenCalledWith('[outbox] Recorded an order stored under another commandId',
        { orderId: order.id, storedCommandId: requeued, recordedCommandId: order.commandId });
      const stored = (await outbox.orders!.find().exec()).map((doc) => doc.toJSON());
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ id: order.id, commandId: requeued, syncStatus: 'applied' });
      await waitFor(() => expect(outbox.state).toMatchObject({ pending: 0, sending: false }));
      expect(sent()).toEqual([order.commandId, requeued]);

      fireEvent.click(button('New sale'));
      expect(screen.getByText('Scan or tap a product to start a sale.')).toBeTruthy();
      expect(signOutDisabled()).toBe(false);
    });

  // TallyUI #150: every unconfirmed save failure is logged, mounted or not, and so is an unmount mid-save.
  it('a save that fails after the sale screen unmounted reaches console.error, as does the unmount itself', async () => {
    fetchStub.mockRejectedValue(new TypeError('offline'));
    const view = await tenderShirtByCard();
    const collection = outbox.orders!;
    let fail!: (reason: Error) => void;
    const handed = new Promise<PosOrder>((resolve) => {
      vi.spyOn(collection, 'insert').mockImplementationOnce((doc) => {
        resolve(doc as PosOrder);
        return new Promise((_resolve, reject) => { fail = reject; }) as never;
      });
    });
    await approve();
    const order = await handed;

    // The sale screen unmounts mid-save; the outbox stays open.
    view.rerender(<App products={false} />);
    expect(error).toHaveBeenCalledWith('[sale] useSale unmounted with a save pending or in flight', { orderId: order.id, stage: 'tender' });
    await act(async () => { fail(new Error('disk full')); });
    await waitFor(() => expect(error).toHaveBeenCalledWith('[sale] onSaleCompleted failed', { orderId: order.id, error: 'disk full' }));
    expect(await collection.find().exec()).toEqual([]);
  });

  it('a stored order with the same id and other money content fails the retry with OrderContentMismatchError, overwrites nothing and logs at error', async () => {
    fetchStub.mockRejectedValue(new TypeError('offline'));
    await tenderShirtByCard();
    const handed = insertWritesThenThrows((doc) => ({ ...doc, totalMinor: doc.totalMinor + 1 }));
    await approve();
    const order = await handed;
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('The sale could not be saved: storage acknowledged late'));
    // isStored finds the id with other content: not stored, logged at error, and no Continue.
    await waitFor(() => expect(error).toHaveBeenCalledWith('[outbox] A stored order has this id with different content', { orderId: order.id }));
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();

    await approve();
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toBe(`The sale could not be saved: Order ${order.id} is already stored with different content`));
    // The retry's record is exactly this call; it throws the mismatch rather than counting the order as stored.
    await expect(outbox.record(order)).rejects.toBeInstanceOf(OrderContentMismatchError);
    const stored = (await outbox.orders!.find().exec()).map((doc) => doc.toJSON());
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: order.id, commandId: order.commandId, totalMinor: order.totalMinor + 1 });
    // Logged once per order (TallyUI #163): the retry's own isStored check finds the same mismatch and doesn't log it again.
    expect(error.mock.calls.filter(([message]) => message === '[outbox] A stored order has this id with different content'))
      .toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Print receipt' })).toBeNull();
    expect(signOutDisabled()).toBe(true);
  });
});
