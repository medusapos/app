import { describe, expect, it, vi } from 'vitest';
import { fetchProductCollections } from './product-collections';

const BASE = 'https://store.test';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const requested = (fetchImpl: ReturnType<typeof vi.fn>, call = 0) => new URL(String(fetchImpl.mock.calls[call][0]));
const ids101 = Array.from({ length: 101 }, (_, index) => `pcol_${String(index).padStart(3, '0')}`);

describe('fetchProductCollections', () => {
  it('makes no request for no ids', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchProductCollections(BASE, 'pk_1', [], fetchImpl)).toEqual(new Map());
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the ids' titles from Medusa's store collections with the publishable key", async () => {
    const fetchImpl = vi.fn(async () => json({ collections: [{ id: 'pcol_b', title: 'Summer' }, { id: 'pcol_a', title: 'Featured' },
      { id: 'pcol_e', title: '' }, { id: 5, title: 'Bad' }, null] }));
    const titles = await fetchProductCollections(BASE, 'pk_1', ['pcol_a', 'pcol_b', 'pcol_e'], fetchImpl);
    expect(titles).toEqual(new Map([['pcol_b', 'Summer'], ['pcol_a', 'Featured']]));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = requested(fetchImpl);
    expect(`${url.origin}${url.pathname}`).toBe('https://store.test/store/collections');
    expect(url.searchParams.get('fields')).toBe('id,title');
    expect(url.searchParams.get('limit')).toBe('3');
    expect(url.searchParams.getAll('id[]')).toEqual(['pcol_a', 'pcol_b', 'pcol_e']);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('x-publishable-api-key')).toBe('pk_1');
  });

  it('asks for at most 100 ids per request and merges the answers', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => json({ collections:
      new URL(String(input)).searchParams.getAll('id[]').map((id) => ({ id, title: id.toUpperCase() })) }));
    const titles = await fetchProductCollections(BASE, 'pk_1', ids101, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(requested(fetchImpl, 0).searchParams.getAll('id[]')).toEqual(ids101.slice(0, 100));
    expect(requested(fetchImpl, 0).searchParams.get('limit')).toBe('100');
    expect(requested(fetchImpl, 1).searchParams.getAll('id[]')).toEqual(ids101.slice(100));
    expect(requested(fetchImpl, 1).searchParams.get('limit')).toBe('1');
    expect(titles.size).toBe(101);
    expect(titles.get('pcol_000')).toBe('PCOL_000');
    expect(titles.get('pcol_100')).toBe('PCOL_100');
  });

  it.each([
    ['a non-OK answer', async () => json({ message: 'Forbidden' }, 403)],
    ['bad JSON', async () => new Response('{not json', { status: 200 })],
    ['a thrown fetch', async () => { throw new TypeError('Failed to fetch'); }],
  ])("keeps the first request's titles when the second fails with %s", async (_, respond) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ collections: [{ id: 'pcol_000', title: 'First' }] }))
      .mockImplementationOnce(respond);
    expect(await fetchProductCollections(BASE, 'pk_1', ids101, fetchImpl)).toEqual(new Map([['pcol_000', 'First']]));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives an empty map when the first request is not OK', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'Forbidden' }, 403));
    expect(await fetchProductCollections(BASE, 'pk_1', ids101, fetchImpl)).toEqual(new Map());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
