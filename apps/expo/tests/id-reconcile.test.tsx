// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { Subject } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';
import { startIdReconcile, startReplication, type IdReconcileResult } from '@tallyui/database';
import { authHeaders, posConnector } from '../lib/pos-connector';
import { clearProductCache } from '../lib/product-cache';
import { useReplicatedProducts } from '../lib/use-replicated-products';

vi.mock('@tallyui/database', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tallyui/database')>();
  return { ...original, createTallyDatabase: vi.fn(original.createTallyDatabase),
    startReplication: vi.fn(), startIdReconcile: vi.fn() };
});

const baseUrl = 'https://id-reconcile.test';
const headers = authHeaders('test-admin-jwt');
const context = { connectorId: posConnector.id, baseUrl, headers };
const onUnauthorized = vi.fn();
const enqueue = vi.fn();
// No stock adapter: this suite is only about the id-reconcile runner.
const connector = { ...posConnector, reconcile: { ids: { ...posConnector.reconcile!.ids!, enqueue } } };
const pass = (braked: boolean): IdReconcileResult => ({ pages: 1, queued: 0, truncated: false, braked });

afterEach(async () => {
  await clearProductCache(connector.id, baseUrl);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete (window as Window & { __medusaposCatalogue?: unknown }).__medusaposCatalogue;
  delete process.env.EXPO_PUBLIC_E2E_DEBUG;
});

/** Mounts the hook with a fake replication and a fake id-reconcile runner, resolving once the runner has started. */
async function mount(reconcileImpl: () => Promise<IdReconcileResult>) {
  vi.stubGlobal('crypto', webcrypto);
  let finishInitial!: () => void;
  const reSync = vi.fn();
  vi.mocked(startReplication).mockReturnValue({
    error$: new Subject(), active$: new Subject(), cancel: vi.fn(), reSync,
    awaitInitialReplication: () => new Promise<void>((done) => { finishInitial = done; }),
  } as never);
  const stop = vi.fn();
  const reconcileIds = vi.fn(reconcileImpl);
  let started!: (options: Parameters<typeof startIdReconcile>[0]) => void;
  const runnerStarted = new Promise<Parameters<typeof startIdReconcile>[0]>((done) => { started = done; });
  vi.mocked(startIdReconcile).mockImplementation((options) => { started(options); return { reconcileIds, stop }; });
  const hook = renderHook(() => useReplicatedProducts(connector, context, onUnauthorized));
  const options = await runnerStarted;
  return { ...hook, options, reconcileIds, stop, reSync, finishInitial: () => act(async () => finishInitial()) };
}

it('starts the id runner alongside replication, with a suppressed start pass and reSync wired in', async () => {
  const { options, reconcileIds, stop, reSync, finishInitial, unmount } = await mount(async () => pass(false));
  expect(options).toEqual(expect.objectContaining({ adapter: connector.reconcile.ids, startDelayMs: null }));
  expect(options).not.toHaveProperty('intervalMs');
  options.reSync();
  expect(reSync).toHaveBeenCalledTimes(1);
  expect(reconcileIds).not.toHaveBeenCalled();
  await finishInitial();
  expect(reconcileIds).toHaveBeenCalledTimes(1);
  unmount();
  expect(stop).toHaveBeenCalledTimes(1);
});

it('warns and records a braked start pass in the e2e debug snapshot', async () => {
  process.env.EXPO_PUBLIC_E2E_DEBUG = '1';
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { finishInitial, unmount } = await mount(async () => pass(true));
  await finishInitial();
  await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('Id reconcile braked at app start:', expect.objectContaining({ braked: true })));
  await vi.waitFor(() => expect(
    (window as Window & { __medusaposCatalogue?: { lastIdReconcile?: unknown } }).__medusaposCatalogue?.lastIdReconcile,
  ).toEqual(expect.objectContaining({ pages: 1, queued: 0, truncated: false, braked: true, at: expect.any(String) })));
  unmount();
});

it('does not warn on an unbraked start pass', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { finishInitial, unmount } = await mount(async () => pass(false));
  await finishInitial();
  await act(async () => {}); // flush the reconcileIds() promise
  expect(warn).not.toHaveBeenCalled();
  unmount();
});

it('never calls the adapter enqueue itself; only the runner may', async () => {
  const { finishInitial, unmount } = await mount(async () => pass(true));
  await finishInitial();
  expect(enqueue).not.toHaveBeenCalled();
  unmount();
});

it('does not record a start pass that finishes after cleanup', async () => {
  process.env.EXPO_PUBLIC_E2E_DEBUG = '1';
  let resolvePass!: (result: IdReconcileResult) => void;
  const { finishInitial, unmount } = await mount(() => new Promise((resolve) => { resolvePass = resolve; }));
  await finishInitial();
  unmount();
  await act(async () => { resolvePass(pass(true)); });
  expect((window as Window & { __medusaposCatalogue?: { lastIdReconcile?: unknown } })
    .__medusaposCatalogue?.lastIdReconcile).toBeNull();
});
