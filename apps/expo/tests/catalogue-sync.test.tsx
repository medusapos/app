// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { basePrototype, RxCollectionBase, RxDatabaseBase } from 'rxdb';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectorUnauthorizedError, type TallyConnector } from '@tallyui/core';
import { createTallyDatabase, startReplication } from '@tallyui/database';
import { authHeaders, createPosConnector } from '../lib/pos-connector';
import { clearProductCache } from '../lib/product-cache';
import { useReplicatedProducts } from '../lib/use-replicated-products';

vi.mock('@tallyui/database', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tallyui/database')>();
  return { ...original, createTallyDatabase: vi.fn(original.createTallyDatabase), startReplication: vi.fn(original.startReplication) };
});

const baseUrl = 'https://catalogue-sync.test';
const doc = (id: string, title: string) => ({ id, title, handle: id, status: 'published', _deleted: false, variants: [
  { id: `${id}-one`, title: 'One size', sku: id.toUpperCase(), prices: [{ amount: 10, currency_code: 'eur' }], manage_inventory: false }] });
// Like Medusa's pull: from no checkpoint, the store's two products; after it, nothing changed.
const handler = vi.fn(async (checkpoint: unknown) => checkpoint
  ? { documents: [], checkpoint }
  : { documents: [doc('hat', 'Blue Hat'), doc('cap', 'Red Cap')], checkpoint: { id: 'done' } });
const onUnauthorized = vi.fn();
let connector: TallyConnector;
let stream: Subject<'RESYNC'>;
const context = { connectorId: 'medusa', baseUrl, headers: authHeaders('test-admin-jwt') };
const fromScratch = () => handler.mock.calls.filter(([checkpoint]) => checkpoint == null).length;
const ids = (products: any[]) => products.map((product) => product.id).sort();

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  // The cache's name is recorded here, so clearProductCache finds the priced cache and each test starts empty.
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  stream = new Subject<'RESYNC'>();
  handler.mockClear();
  connector = { ...createPosConnector(), reconcile: undefined,
    replication: { products: { pull: { handler, stream$: stream } } } };
});

afterEach(async () => {
  await clearProductCache(connector.id, baseUrl);
  cleanup();
  stream.complete();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('syncNow after the first sync pulls again and ends synced', async () => {
  const { result } = renderHook(() => useReplicatedProducts(connector, context, onUnauthorized));
  await waitFor(() => expect(result.current.state).toBe('synced'));
  const calls = handler.mock.calls.length;
  act(() => result.current.syncNow());
  await waitFor(() => expect(handler.mock.calls.length).toBeGreaterThan(calls));
  await waitFor(() => expect(result.current.state).toBe('synced'));
  expect(ids(result.current.products)).toEqual(['cap', 'hat']);
});

it('syncNow also rechecks stock, as v2\'s Sync refreshes the catalogue and its stock together', async () => {
  // A store with no stock rows: each pass is one fetchPages call that yields nothing.
  const fetchPages = vi.fn(async function* (): AsyncGenerator<Map<string, unknown>> {});
  connector = { ...connector, reconcile: { stock: { fetchPages, overlay: () => undefined } } };
  const { result } = renderHook(() => useReplicatedProducts(connector, context, onUnauthorized));
  // The start pass after the first sync has finished.
  await waitFor(() => expect(result.current.lastStockCheckAt).not.toBeNull());
  expect(fetchPages).toHaveBeenCalledTimes(1);
  act(() => result.current.syncNow());
  await waitFor(() => expect(fetchPages).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.state).toBe('synced'));
});

it('syncNow with a till-fixable notice resumes the held pull, as resumePull does', async () => {
  handler.mockRejectedValueOnce(new ConnectorUnauthorizedError('Medusa API error: 401', 401));
  const { result } = renderHook(() => useReplicatedProducts(connector, context, onUnauthorized));
  await waitFor(() => expect(result.current.pullNotice).toMatchObject({ code: 'unauthorized', fixedBy: 'till' }));
  const replication = vi.mocked(startReplication).mock.results[0].value;
  await act(async () => { await replication.awaitInSync(); });
  const calls = handler.mock.calls.length;
  const resume = vi.spyOn(replication, 'resume');
  act(() => result.current.syncNow());
  expect(resume).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(result.current.state).toBe('synced'));
  expect(handler.mock.calls.length).toBeGreaterThan(calls);
  expect(result.current.pullNotice).toBeUndefined();
});

it('clearAndRefresh removes the database, empties the products at once and refills them from an empty checkpoint', async () => {
  // Removing documents instead of the database would go through one of these.
  const removals = [
    vi.spyOn(RxCollectionBase.prototype, 'bulkRemove'), vi.spyOn(RxCollectionBase.prototype, 'remove'),
    vi.spyOn(basePrototype, 'remove'),
  ];
  const dbRemove = vi.spyOn(RxDatabaseBase.prototype, 'remove');
  const { result } = renderHook(() => useReplicatedProducts(connector, context, onUnauthorized));
  await waitFor(() => expect(result.current.state).toBe('synced'));
  expect(ids(result.current.products)).toEqual(['cap', 'hat']);
  expect(fromScratch()).toBe(1);

  act(() => result.current.clearAndRefresh());
  expect(result.current.products).toEqual([]);
  expect(result.current.state).toBe('connecting');
  await waitFor(() => expect(ids(result.current.products)).toEqual(['cap', 'hat']));
  await waitFor(() => expect(result.current.state).toBe('synced'));
  expect(fromScratch()).toBe(2);
  expect(dbRemove).toHaveBeenCalledTimes(1);
  for (const spy of removals) expect(spy).not.toHaveBeenCalled();
  expect(createTallyDatabase).toHaveBeenCalledTimes(2);
});

it('a second clearAndRefresh while one is running starts no third open', async () => {
  const { result } = renderHook(() => useReplicatedProducts(connector, context, onUnauthorized));
  await waitFor(() => expect(result.current.state).toBe('synced'));
  act(() => { result.current.clearAndRefresh(); result.current.clearAndRefresh(); });
  act(() => result.current.clearAndRefresh());
  await waitFor(() => expect(ids(result.current.products)).toEqual(['cap', 'hat']));
  await waitFor(() => expect(result.current.state).toBe('synced'));
  expect(createTallyDatabase).toHaveBeenCalledTimes(2);
  expect(fromScratch()).toBe(2);
});
