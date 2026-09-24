// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { AppState, type AppStateStatus } from 'react-native';
import type { RxCollection } from 'rxdb';
import { BehaviorSubject, Subject } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createTallyDatabase, startReplication, startStockReconcile, STOCK_LEVELS_COLLECTION, STOCK_LEVELS_LAST_PASS,
  type StockReconcileResult, type StockReconcileState,
} from '@tallyui/database';
import { authHeaders, posConnector } from '../lib/pos-connector';
import { clearProductCache, productCacheName, productCacheStorage } from '../lib/product-cache';
import { useReplicatedProducts } from '../lib/use-replicated-products';

vi.mock('@tallyui/database', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tallyui/database')>();
  return { ...original, createTallyDatabase: vi.fn(original.createTallyDatabase),
    startReplication: vi.fn(), startStockReconcile: vi.fn() };
});

const baseUrl = 'https://stock-reconcile.test';
const headers = authHeaders('test-admin-jwt');
const onUnauthorized = vi.fn();
const pass = (truncated: boolean): StockReconcileResult => ({ pages: 1, written: 0, removed: 0, truncated });

afterEach(async () => {
  await clearProductCache(posConnector.id, baseUrl);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Mounts the hook with a fake replication and a fake runner (leader-gated: it starts once the
 * (single-instance, always-leader) database's waitForLeadership() resolves); resolves once the
 * runner has started. reconcileImpl gets the real stock_levels collection, the way the app's
 * lastStockCheckAt (from stockOverlayAsOf$) sees a pass the real runner would record there.
 */
async function mount(reconcileImpl: (collection: RxCollection) => Promise<StockReconcileResult>) {
  vi.stubGlobal('crypto', webcrypto);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let onAppState!: (state: AppStateStatus) => void;
  const remove = vi.fn();
  vi.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => { onAppState = handler; return { remove }; });
  let finishInitial!: () => void;
  vi.mocked(startReplication).mockReturnValue({
    error$: new Subject(), active$: new Subject(), cancel: vi.fn(),
    awaitInitialReplication: () => new Promise<void>((done) => { finishInitial = done; }),
  } as never);
  let collection!: RxCollection;
  const runner = { reconcileStock: vi.fn(() => reconcileImpl(collection)), stop: vi.fn(),
    state$: new BehaviorSubject<StockReconcileState>({ running: false, truncated: false }) };
  let started!: () => void;
  const runnerStarted = new Promise<void>((done) => { started = done; });
  vi.mocked(startStockReconcile).mockImplementation((options) => { collection = options.collection; started(); return runner; });
  const hook = renderHook(() => useReplicatedProducts(posConnector, headers, baseUrl, onUnauthorized));
  await act(async () => { await runnerStarted; });
  return { ...hook, runner, collection, remove, finishInitial: () => act(async () => finishInitial()),
    appState: (state: AppStateStatus) => act(async () => onAppState(state)) };
}

it('starts the runner with its own default cadence and reconciles after initial replication, on foreground, and stops on unmount', async () => {
  const { runner, remove, finishInitial, appState, unmount } = await mount(async () => pass(false));
  expect(startStockReconcile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    adapter: posConnector.reconcile!.stock, context: expect.objectContaining({ baseUrl, headers }),
  }));
  // The runner is given no intervalMs override; it runs its own default cadence.
  expect(vi.mocked(startStockReconcile).mock.calls[0][0]).not.toHaveProperty('intervalMs');
  expect(runner.reconcileStock).not.toHaveBeenCalled();
  await finishInitial();
  expect(runner.reconcileStock).toHaveBeenCalledTimes(1);
  await appState('background');
  expect(runner.reconcileStock).toHaveBeenCalledTimes(1);
  await appState('active');
  expect(runner.reconcileStock).toHaveBeenCalledTimes(2);
  unmount();
  expect(runner.stop).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
});

it('takes lastStockCheckAt from the shared last-pass doc, including a pass the runner makes on its own, and warns on failure', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const results = [new Error('Failed to fetch'), pass(false)];
  const { result, collection, appState, unmount } = await mount(async () => {
    const next = results.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  expect(result.current.lastStockCheckAt).toBeNull();
  await appState('active');
  expect(result.current.lastStockCheckAt).toBeNull();
  expect(warn).toHaveBeenCalledWith('Stock reconcile failed:', expect.any(Error));

  // A pass — the runner's own timer or the app's call — writes the shared last-pass doc
  // (a follower with no runner sees it the same way).
  const own = new Date().toISOString();
  await act(async () => { await collection.upsertLocal(STOCK_LEVELS_LAST_PASS, { completedAt: own }); });
  expect(result.current.lastStockCheckAt).toEqual(new Date(own));

  const before = Date.now();
  await appState('active');
  await act(async () => { await collection.upsertLocal(STOCK_LEVELS_LAST_PASS, { completedAt: new Date().toISOString() }); });
  expect(result.current.lastStockCheckAt!.getTime()).toBeGreaterThanOrEqual(before);
  unmount();
});

it('shows a restart-seeded lastCompletedAt immediately, without any call from the app', async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: vi.fn() }));
  vi.mocked(startReplication).mockReturnValue({
    error$: new Subject(), active$: new Subject(), cancel: vi.fn(),
    awaitInitialReplication: () => new Promise<void>(() => {}),
  } as never);
  const { createTallyDatabase: open } = await vi.importActual<typeof import('@tallyui/database')>('@tallyui/database');
  const seeded = new Date().toISOString();
  // Seeded as the real runner does on restart, in the shared last-pass doc, before the app calls
  // reconcileStock at all.
  const seedDb = await open({ connector: posConnector, name: productCacheName(posConnector.id, baseUrl), storage: productCacheStorage() });
  await seedDb[STOCK_LEVELS_COLLECTION].upsertLocal(STOCK_LEVELS_LAST_PASS, { completedAt: seeded });
  await seedDb.close();
  const runner = { reconcileStock: vi.fn(async () => pass(false)), stop: vi.fn(),
    state$: new BehaviorSubject<StockReconcileState>({ running: false, truncated: false }) };
  vi.mocked(startStockReconcile).mockReturnValue(runner);
  const { result, unmount } = renderHook(() => useReplicatedProducts(posConnector, headers, baseUrl, onUnauthorized));
  await vi.waitFor(() => expect(result.current.lastStockCheckAt).toEqual(new Date(seeded)));
  expect(runner.reconcileStock).not.toHaveBeenCalled();
  unmount();
});

it('closes the database and starts nothing when unmounted while the database is opening', async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const foreground = vi.spyOn(AppState, 'addEventListener');
  const { createTallyDatabase: open } = await vi.importActual<typeof import('@tallyui/database')>('@tallyui/database');
  let release!: () => void;
  const opening = new Promise<void>((done) => { release = done; });
  let close: { mock: { calls: unknown[] } } | undefined;
  vi.mocked(createTallyDatabase).mockImplementationOnce(async (options) => {
    await opening;
    const db = await open(options);
    close = vi.spyOn(db, 'close');
    return db;
  });
  const { unmount } = renderHook(() => useReplicatedProducts(posConnector, headers, baseUrl, onUnauthorized));
  unmount();
  release();
  await vi.waitFor(() => expect(close?.mock.calls).toHaveLength(1));
  expect(startReplication).not.toHaveBeenCalled();
  expect(startStockReconcile).not.toHaveBeenCalled();
  expect(foreground).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
