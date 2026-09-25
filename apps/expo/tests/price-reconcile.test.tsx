// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { BehaviorSubject, Subject } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';
import type { FingerprintReconcileAdapter } from '@tallyui/core';
import { MEDUSA_CALCULATED_PRICE_RECONCILE_INTERVAL_MS } from '@tallyui/connector-medusa';
import { startFingerprintReconcile, startReplication } from '@tallyui/database';
import { authHeaders, posConnector } from '../lib/pos-connector';
import { clearProductCache } from '../lib/product-cache';
import { useReplicatedProducts } from '../lib/use-replicated-products';

vi.mock('@tallyui/database', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tallyui/database')>();
  return { ...original, startReplication: vi.fn(), startFingerprintReconcile: vi.fn(original.startFingerprintReconcile) };
});

const baseUrl = 'https://price-reconcile.test';
const context = { connectorId: posConnector.id, baseUrl, headers: authHeaders('test-admin-jwt'),
  pricingContext: { region_id: 'reg_eu', currency_code: 'eur', publishable_key: 'pk_1' } };
const onUnauthorized = vi.fn();
const product = (id: string) => ({ id, title: id, handle: id, status: 'published',
  variants: [{ id: `${id}-v`, title: 'One', sku: id, prices: [{ amount: 1, currency_code: 'eur' }] }] });

/** A fake fingerprint adapter: every product fingerprints as 'fp'; each pass reports `listed` in pages of 100. */
function fakeAdapter(listed: string[], fail?: () => boolean) {
  const enqueue = vi.fn();
  const fetchPages = vi.fn(async function* () {
    if (fail?.()) throw new Error('store unreachable');
    for (let i = 0; i < listed.length; i += 100) yield new Map(listed.slice(i, i + 100).map((id) => [id, 'fp']));
  });
  return { fetchPages, fingerprint: () => 'fp', enqueue } satisfies FingerprintReconcileAdapter;
}

afterEach(async () => {
  await clearProductCache(posConnector.id, baseUrl);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** Mounts the hook with a fake replication (a pull in flight until `settle`) and the real runners over fake adapters. */
async function mount(calculatedPrices: FingerprintReconcileAdapter, prices = fakeAdapter([])) {
  vi.stubGlobal('crypto', webcrypto);
  const connector = { ...posConnector, reconcile: { calculatedPrices, prices } };
  let finishInitial!: () => void;
  const active$ = new BehaviorSubject(true);
  const reSync = vi.fn();
  vi.mocked(startReplication).mockReturnValue({
    error$: new Subject(), active$, cancel: vi.fn(() => active$.complete()), reSync,
    awaitInitialReplication: () => new Promise<void>((done) => { finishInitial = done; }),
  } as never);
  const hook = renderHook(() => useReplicatedProducts(connector, context, onUnauthorized));
  await waitFor(() => expect(startFingerprintReconcile).toHaveBeenCalledTimes(2));
  const [calculated, base] = vi.mocked(startFingerprintReconcile).mock.calls.map(([options]) => options);
  const [calculatedRunner, baseRunner] = vi.mocked(startFingerprintReconcile).mock.results.map(({ value }) => value);
  // Local products: 'listed' is in the channel, 'unlisted' is not.
  await act(async () => { await calculated.collection.bulkInsert([product('listed'), product('unlisted')] as never[]); });
  return { ...hook, connector, calculated, base, calculatedRunner, baseRunner, reSync,
    finishInitial: () => act(async () => finishInitial()), settle: () => act(async () => active$.next(false)) };
}

it('starts both runners with their options and stops them on unmount', async () => {
  const { connector, calculated, base, calculatedRunner, baseRunner, reSync, finishInitial, settle, unmount } =
    await mount(fakeAdapter(['listed']));
  expect(calculated).toEqual(expect.objectContaining({ adapter: connector.reconcile.calculatedPrices, context,
    intervalMs: MEDUSA_CALCULATED_PRICE_RECONCILE_INTERVAL_MS, maxPages: 1000, startDelayMs: null }));
  expect(base).toEqual(expect.objectContaining({ adapter: connector.reconcile.prices, context }));
  expect(base.collection).toBe(calculated.collection);
  // The base-price runner keeps its defaults: 24 h, 100 pages, no start pass.
  for (const key of ['intervalMs', 'maxPages', 'startDelayMs']) expect(base).not.toHaveProperty(key);
  calculated.reSync();
  base.reSync();
  expect(reSync).toHaveBeenCalledTimes(2);
  await finishInitial();
  await settle();
  const stops = [vi.spyOn(calculatedRunner, 'stop'), vi.spyOn(baseRunner, 'stop')];
  unmount();
  for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
});

it('runs one calculated-price pass once the first sync has settled, and none of the base-price runner', async () => {
  const listed = Array.from({ length: 150 }, (_, i) => `remote-${i}`).concat('listed');
  const calculatedPrices = fakeAdapter(listed);
  const prices = fakeAdapter(listed);
  const { result, finishInitial, settle, unmount } = await mount(calculatedPrices, prices);
  expect(calculatedPrices.fetchPages).not.toHaveBeenCalled();
  // The initial replication resolves while its pull is still active: no pass overlaps the first sync.
  await finishInitial();
  expect(calculatedPrices.fetchPages).not.toHaveBeenCalled();
  expect(result.current.unlisted).toBeUndefined();
  await settle();
  await waitFor(() => expect(result.current.unlisted).toEqual({ count: 1, stale: false }));
  // Exactly one pass: 151 remote products are ceil(151 / 100) = 2 pages, read by one fetchPages call.
  expect(calculatedPrices.fetchPages).toHaveBeenCalledTimes(1);
  expect(calculatedPrices.fetchPages).toHaveBeenCalledWith(expect.objectContaining({ pricingContext: context.pricingContext }));
  expect(prices.fetchPages).not.toHaveBeenCalled();
  expect(calculatedPrices.enqueue).not.toHaveBeenCalled();
  unmount();
});

it('follows the runner\'s state: a failed later pass keeps the count and marks it stale, then a good pass clears it', async () => {
  let failing = false;
  const { result, calculatedRunner, finishInitial, settle, unmount } = await mount(fakeAdapter(['listed'], () => failing));
  await finishInitial();
  await settle();
  await waitFor(() => expect(result.current.unlisted).toEqual({ count: 1, stale: false }));
  failing = true;
  await act(async () => { await calculatedRunner.reconcile().catch(() => {}); });
  expect(result.current.unlisted).toEqual({ count: 1, stale: true });
  // The products and the sync status are untouched by the failure.
  expect(result.current.products.map((doc) => doc.id).sort()).toEqual(['listed', 'unlisted']);
  expect(result.current.state).toBe('synced');
  expect(result.current.error).toBeNull();
  failing = false;
  await act(async () => { await calculatedRunner.reconcile(); });
  expect(result.current.unlisted).toEqual({ count: 1, stale: false });
  unmount();
});

it('logs a failed start pass and keeps the products and the status', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { result, finishInitial, settle, unmount } = await mount(fakeAdapter(['listed'], () => true));
  await finishInitial();
  await settle();
  await waitFor(() => expect(warn).toHaveBeenCalledWith('Calculated-price reconcile failed:', expect.any(Error)));
  expect(result.current.unlisted).toBeUndefined();
  expect(result.current.products.map((doc) => doc.id).sort()).toEqual(['listed', 'unlisted']);
  expect(result.current.state).toBe('synced');
  expect(result.current.error).toBeNull();
  unmount();
});
