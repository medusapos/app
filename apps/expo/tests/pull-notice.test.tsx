// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { errorToPlainJson } from 'rxdb';
import { BehaviorSubject, Subject } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectorUnauthorizedError, type SyncNotice, type TallyConnector } from '@tallyui/core';
import { startReplication } from '@tallyui/database';
import { authHeaders, createPosConnector } from '../lib/pos-connector';
import { clearProductCache } from '../lib/product-cache';
import { classifyReplicationError, useReplicatedProducts } from '../lib/use-replicated-products';

vi.mock('@tallyui/database', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tallyui/database')>();
  return { ...original, startReplication: vi.fn(original.startReplication) };
});

const baseUrl = 'https://pull-notice.test';
const page = { documents: [], checkpoint: { id: 'done' } };
const handler = vi.fn(async () => page);
const onUnauthorized = vi.fn();
let connector: TallyConnector;
let stream: Subject<'RESYNC'>;
const context = { connectorId: 'medusa', baseUrl, headers: authHeaders('test-admin-jwt') };

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  stream = new Subject<'RESYNC'>();
  handler.mockReset().mockResolvedValue(page);
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

it('an unauthorized pull shows its notice, signs out once, and pulls no more until resumed', async () => {
  handler.mockRejectedValueOnce(new ConnectorUnauthorizedError('Medusa API error: 401', 401));
  const { result } = renderHook(() => useReplicatedProducts(connector, context, onUnauthorized));
  await waitFor(() => expect(result.current.pullNotice).toMatchObject({ code: 'unauthorized', fixedBy: 'till' }));
  const replication = vi.mocked(startReplication).mock.results[0].value;
  await act(async () => { await replication.awaitInSync(); });
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
  expect(result.current.state).toBe('error');
  expect(result.current.lastSyncedAt).toBeNull();
  const calls = handler.mock.calls.length;
  const resumePull = result.current.resumePull;
  await act(async () => { stream.next('RESYNC'); await replication.awaitInSync(); });
  expect(handler).toHaveBeenCalledTimes(calls);
  expect(result.current.state).toBe('error');

  act(() => result.current.resumePull());
  await waitFor(() => expect(result.current.state).toBe('synced'));
  expect(handler.mock.calls.length).toBeGreaterThan(calls);
  expect(result.current.pullNotice).toBeUndefined();
  expect(result.current.lastSyncedAt).toBeInstanceOf(Date);
  expect(result.current.resumePull).toBe(resumePull);
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
});

it('a store notice shows but never signs out', async () => {
  handler.mockRejectedValue(Object.assign(new Error('missing'), { code: 'missing_plugin', fixedBy: 'store' }));
  const { result } = renderHook(() => useReplicatedProducts(connector, context, onUnauthorized));
  await waitFor(() => expect(result.current.pullNotice).toMatchObject({ code: 'missing_plugin', fixedBy: 'store' }));
  expect(result.current.state).toBe('error');
  expect(result.current.lastSyncedAt).toBeNull();
  expect(onUnauthorized).not.toHaveBeenCalled();
});

it('a pull refused with 403 holds with a forbidden notice and never signs out', async () => {
  handler.mockRejectedValue(new ConnectorUnauthorizedError('Medusa API error: 403', 403));
  const { result } = renderHook(() => useReplicatedProducts(connector, context, onUnauthorized));
  await waitFor(() => expect(result.current.pullNotice).toBeDefined());
  expect(result.current.pullNotice).toMatchObject({ code: 'forbidden', fixedBy: 'store' });
  expect(onUnauthorized).not.toHaveBeenCalled();
});

it.each([
  [new ConnectorUnauthorizedError('Medusa API error: 401: Token expired', 401), 'unauthorized'],
  [new ConnectorUnauthorizedError('Medusa API error: 403', 403), 'http'],
] as const)('classifies direct and RxDB-wrapped connector errors by code: %s', (error, expected) => {
  expect(classifyReplicationError(error)).toBe(expected);
  // RxDB's replication wraps each error as plain JSON, without the prototype.
  expect(classifyReplicationError({ parameters: { errors: [errorToPlainJson(error)] } })).toBe(expected);
});

it('a forbidden notice holds the pull and never signs out', async () => {
  const notice: SyncNotice = { code: 'forbidden', since: 0, fixedBy: 'store' };
  const active$ = new BehaviorSubject(true);
  const error$ = new Subject<Error>();
  const resume = vi.fn();
  vi.mocked(startReplication).mockReturnValueOnce({
    notice$: new BehaviorSubject(notice), active$, error$, resume, cancel: vi.fn(),
    awaitInitialReplication: async () => {},
  } as never);
  const { result } = renderHook(() => useReplicatedProducts(connector, context, onUnauthorized));
  await waitFor(() => expect(result.current.pullNotice).toEqual(notice));
  act(() => { active$.next(false); error$.next(new Error('forbidden')); });
  expect(result.current.state).toBe('error');
  expect(result.current.lastSyncedAt).toBeNull();
  expect(onUnauthorized).not.toHaveBeenCalled();
  act(() => result.current.resumePull());
  expect(resume).not.toHaveBeenCalled();
});

it('resumePull does nothing while the pull is not paused', async () => {
  const { result } = renderHook(() => useReplicatedProducts(connector, context, onUnauthorized));
  await waitFor(() => expect(result.current.state).toBe('synced'));
  const replication = vi.mocked(startReplication).mock.results[0].value;
  const resume = vi.spyOn(replication, 'resume');
  act(() => result.current.resumePull());
  expect(resume).not.toHaveBeenCalled();
});
