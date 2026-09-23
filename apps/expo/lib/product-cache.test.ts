import { describe, expect, it, vi } from 'vitest';
import { createRxDatabase } from 'rxdb';
import {
  clearProductCache, isUnauthorizedError, productCacheName, productCacheStorage, registerOpenCache,
} from './product-cache';

describe('productCacheName', () => {
  it('encodes the exact URL into an RxDB name', () => {
    expect(productCacheName('medusa', 'http://localhost:9000'))
      .toBe('medusapos_medusa_http_3a__2f__2f_localhost_3a_9000');
  });
  it('keeps punctuation, case, underscores and UTF-16 code units distinct', () => {
    const urls = ['https://shop-a.example.com', 'https://shop.a.example.com',
      'https://Shop.example.com', 'https://shop.example.com',
      'https://shop_2d_a.example.com', 'https://shop.example.com/😀'];
    const names = urls.map((url) => productCacheName('medusa', url));
    expect(new Set(names).size).toBe(urls.length);
    for (const name of names) expect(name).toMatch(/^[a-z][_$a-z0-9\-]*$/);
    expect(names[2]).toContain('_53_');
    expect(names[5]).toContain('_d83d__de00_');
  });
});

describe('isUnauthorizedError', () => {
  it.each([
    new Error('Medusa API error: 401'),
    { parameters: { errors: [new Error('Medusa API error: 401')] } },
    { message: 'RxDB replication error', parameters: { errors: [{ message: 'Medusa API error: 401' }] } },
  ])('recognizes a backend 401: %j', (error) => {
    expect(isUnauthorizedError(error)).toBe(true);
  });
  it.each([new Error('Medusa API error: 500'), new TypeError('offline'),
    { parameters: { errors: [{ message: 'Medusa API error: 500' }] } },
    null, undefined, 401, 'Medusa API error: 401', {}, { parameters: { errors: [] } },
    { parameters: { errors: [null] } }, new Error('Medusa API error: 4010'),
  ])('ignores other failures: %j', (error) => {
    expect(isUnauthorizedError(error)).toBe(false);
  });
});

describe('clearProductCache', () => {
  it('removes a registered open cache', async () => {
    const db = { remove: vi.fn().mockResolvedValue(undefined) };
    const unregister = registerOpenCache(productCacheName('medusa', 'https://open.test'), db);
    try {
      await clearProductCache('medusa', 'https://open.test');
      expect(db.remove).toHaveBeenCalledOnce();
    } finally { unregister(); }
  });
  it('unregisters a cache and tolerates an absent cache', async () => {
    const db = { remove: vi.fn() };
    const unregister = registerOpenCache(productCacheName('medusa', 'https://absent.test'), db);
    unregister();
    await expect(clearProductCache('medusa', 'https://absent.test')).resolves.toBeUndefined();
    expect(db.remove).not.toHaveBeenCalled();
  });
  it('does not throw when removal fails', async () => {
    const db = { remove: vi.fn().mockRejectedValue(new Error('removal failed')) };
    const unregister = registerOpenCache(productCacheName('medusa', 'https://failure.test'), db);
    try {
      await expect(clearProductCache('medusa', 'https://failure.test')).resolves.toBeUndefined();
    } finally { unregister(); }
  });
  it.each([true, false])('removes actual RxDB data (open: %s)', async (open) => {
    const baseUrl = `https://data-${open}.test`;
    const options = { name: productCacheName('medusa', baseUrl), storage: productCacheStorage(), multiInstance: false };
    const collections = { products: { schema: {
      title: 'cache test', version: 0, primaryKey: 'id', type: 'object',
      properties: { id: { type: 'string', maxLength: 100 } }, required: ['id'],
    } } };
    const db = await createRxDatabase(options);
    await db.addCollections(collections);
    await db.products.insert({ id: 'product-from-old-session' });
    const unregister = open ? registerOpenCache(options.name, db) : () => {};
    if (!open) await db.close();
    try { await clearProductCache('medusa', baseUrl); } finally { unregister(); }
    const reopened = await createRxDatabase(options);
    try {
      await reopened.addCollections(collections);
      expect(await reopened.products.find().exec()).toEqual([]);
    } finally { await reopened.remove(); }
  });
});
