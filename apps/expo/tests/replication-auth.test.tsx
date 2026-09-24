// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { authHeaders, posConnector } from '../lib/pos-connector';
import { clearProductCache } from '../lib/product-cache';
import { useReplicatedProducts } from '../lib/use-replicated-products';

const baseUrl = 'https://replication-auth.test';
const token = 'test-admin-jwt';
const headers = authHeaders(token);
const onUnauthorized = vi.fn();

function Harness() {
  const { state } = useReplicatedProducts(posConnector, headers, baseUrl, onUnauthorized);
  return <span>{state}</span>;
}

afterEach(async () => {
  await clearProductCache(posConnector.id, baseUrl);
  cleanup();
  vi.unstubAllGlobals();
});

it('sends the admin JWT as Bearer, never Basic, when replicating products', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ products: [], count: 0, offset: 0, limit: 100 }), { status: 200 }));
  // A pass starts with a high-water-mark read, then requests the product page.
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ products: [], count: 0 }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);

  render(<Harness />);
  await waitFor(() => expect(screen.getByText('synced')).toBeTruthy());

  const requests = fetchMock.mock.calls.filter(([url]) => new URL(url).pathname === '/admin/products');
  expect(requests.length).toBeGreaterThanOrEqual(2);
  for (const [, init] of requests) {
    const authorization = new Headers(init?.headers).get('Authorization');
    expect(authorization).not.toMatch(/^Basic /);
    expect(authorization).toBe('Bearer ' + token);
  }
  expect(onUnauthorized).not.toHaveBeenCalled();
});
