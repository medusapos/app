// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { AppState, type AppStateStatus } from 'react-native';
import { Subject } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';
import { createTallyDatabase, startReplication, startStockReconcile, type StockReconcileResult } from '@tallyui/database';
import { authHeaders, posConnector } from '../lib/pos-connector';
import { clearProductCache } from '../lib/product-cache';
import { STOCK_CHECK_INTERVAL_MS, useReplicatedProducts } from '../lib/use-replicated-products';

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

/** Mounts the hook with a fake replication and a fake runner; resolves once the runner has started. */
async function mount(reconcileStock: () => Promise<StockReconcileResult>) {
  vi.stubGlobal('crypto', webcrypto);
  // Only the app's own timer is faked; RxDB keeps its real timeouts.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let onAppState!: (state: AppStateStatus) => void;
  const remove = vi.fn();
  vi.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => { onAppState = handler; return { remove }; });
  let finishInitial!: () => void;
  vi.mocked(startReplication).mockReturnValue({
    error$: new Subject(), active$: new Subject(), cancel: vi.fn(),
    awaitInitialReplication: () => new Promise<void>((done) => { finishInitial = done; }),
  } as never);
  const runner = { reconcileStock: vi.fn(reconcileStock), stop: vi.fn() };
  let started!: () => void;
  const runnerStarted = new Promise<void>((done) => { started = done; });
  vi.mocked(startStockReconcile).mockImplementation(() => { started(); return runner; });
  const hook = renderHook(() => useReplicatedProducts(posConnector, headers, baseUrl, onUnauthorized));
  await act(async () => { await runnerStarted; });
  return { ...hook, runner, remove, finishInitial: () => act(async () => finishInitial()),
    appState: (state: AppStateStatus) => act(async () => onAppState(state)) };
}

it('reconciles after the initial replication, every 5 minutes and on foreground, and stops on unmount', async () => {
  const { runner, remove, finishInitial, appState, unmount } = await mount(async () => pass(false));
  expect(startStockReconcile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    adapter: posConnector.reconcile!.stock, context: expect.objectContaining({ baseUrl, headers }),
  }));
  expect(runner.reconcileStock).not.toHaveBeenCalled();
  await finishInitial();
  expect(runner.reconcileStock).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(STOCK_CHECK_INTERVAL_MS - 1); });
  expect(runner.reconcileStock).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(runner.reconcileStock).toHaveBeenCalledTimes(2);
  await appState('background');
  expect(runner.reconcileStock).toHaveBeenCalledTimes(2);
  await appState('active');
  expect(runner.reconcileStock).toHaveBeenCalledTimes(3);
  unmount();
  expect(runner.stop).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(STOCK_CHECK_INTERVAL_MS); });
  expect(runner.reconcileStock).toHaveBeenCalledTimes(3);
});

it('records the stock check time only for a pass that completes untruncated', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const results = [pass(true), new Error('Failed to fetch'), pass(false)];
  const { result, appState, unmount } = await mount(async () => {
    const next = results.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  expect(result.current.lastStockCheckAt).toBeNull();
  await appState('active');
  expect(result.current.lastStockCheckAt).toBeNull();
  await appState('active');
  expect(result.current.lastStockCheckAt).toBeNull();
  expect(warn).toHaveBeenCalledWith('Stock reconcile failed:', expect.any(Error));
  const before = Date.now();
  await act(async () => { await result.current.reconcileStock(); });
  expect(result.current.lastStockCheckAt!.getTime()).toBeGreaterThanOrEqual(before);
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
