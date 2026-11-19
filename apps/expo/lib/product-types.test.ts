// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProductTypes, useProductTypes } from './product-types';

const session = { baseUrl: 'https://store.test', token: 'tok' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const requested = (fetchImpl: ReturnType<typeof vi.fn>, call = 0) => new URL(String(fetchImpl.mock.calls[call][0]));

describe('fetchProductTypes', () => {
  it('makes no request for no ids', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchProductTypes(session, [], fetchImpl)).toEqual(new Map());
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the ids' types from Medusa's admin product types with the admin's token", async () => {
    const fetchImpl = vi.fn(async () => json({ product_types: [{ id: 'ptyp_a', value: 'Apparel' }, { id: 'ptyp_k', value: 'Kitchen' },
      { id: 'ptyp_e', value: '' }, { id: 5, value: 'Bad' }, null] }));
    const types = await fetchProductTypes(session, ['ptyp_a', 'ptyp_k'], fetchImpl);
    expect(types).toEqual(new Map([['ptyp_a', 'Apparel'], ['ptyp_k', 'Kitchen']]));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = requested(fetchImpl);
    expect(`${url.origin}${url.pathname}`).toBe('https://store.test/admin/product-types');
    expect(url.searchParams.getAll('id[]')).toEqual(['ptyp_a', 'ptyp_k']);
    expect(url.searchParams.get('fields')).toBe('id,value');
    expect(url.searchParams.get('limit')).toBe('2');
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok');
  });

  it('asks for at most 100 ids per request', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `ptyp_${String(index).padStart(3, '0')}`);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => json({ product_types:
      new URL(String(input)).searchParams.getAll('id[]').map((id) => ({ id, value: id.toUpperCase() })) }));
    const types = await fetchProductTypes(session, ids, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(requested(fetchImpl, 0).searchParams.getAll('id[]')).toEqual(ids.slice(0, 100));
    expect(requested(fetchImpl, 1).searchParams.getAll('id[]')).toEqual(ids.slice(100));
    expect(requested(fetchImpl, 1).searchParams.get('limit')).toBe('50');
    expect(types.size).toBe(150);
    expect(types.get('ptyp_149')).toBe('PTYP_149');
  });

  it.each([
    ['a 401 response', async () => json({ message: 'Unauthorized' }, 401)],
    ['a thrown fetch', async () => { throw new TypeError('Failed to fetch'); }],
    ['bad JSON', async () => new Response('{not json', { status: 200 })],
    ['a body without product_types', async () => json({ types: [] })],
  ])('gives an empty map without throwing on %s', async (_, respond) => {
    await expect(fetchProductTypes(session, ['ptyp_a'], vi.fn(respond))).resolves.toEqual(new Map());
  });

  it('keeps what an earlier request read when a later one fails', async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `ptyp_${index}`);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ product_types: [{ id: 'ptyp_0', value: 'First' }] }))
      .mockResolvedValueOnce(json({}, 403));
    expect(await fetchProductTypes(session, ids, fetchImpl)).toEqual(new Map([['ptyp_0', 'First']]));
  });
});

describe('useProductTypes', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('drops a product-types answer that lands after the store changed', async () => {
    const pending = new Map<string, (response: Response) => void>();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => new Promise<Response>((resolve) => {
      pending.set(new URL(String(input)).origin, resolve);
    })));
    const storeA = { baseUrl: 'https://a.test', token: 'tok' };
    const storeB = { baseUrl: 'https://b.test', token: 'tok' };
    const hook = renderHook(({ store }) => useProductTypes(store, ['ptyp_1'], true), { initialProps: { store: storeA } });
    await waitFor(() => expect(pending.has('https://a.test')).toBe(true));
    hook.rerender({ store: storeB });
    await waitFor(() => expect(pending.has('https://b.test')).toBe(true));
    await act(async () => { pending.get('https://b.test')!(json({ product_types: [{ id: 'ptyp_1', value: 'B-type' }] })); });
    await waitFor(() => expect(hook.result.current.get('ptyp_1')).toBe('B-type'));
    await act(async () => { pending.get('https://a.test')!(json({ product_types: [{ id: 'ptyp_1', value: 'A-type' }] })); });
    expect(hook.result.current.get('ptyp_1')).toBe('B-type');
  });
});
