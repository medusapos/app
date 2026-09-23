// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { medusaConnector } from '@tallyui/connector-medusa';
import { clearProductCache } from '../lib/product-cache';
import { useReplicatedProducts } from '../lib/use-replicated-products';

const baseUrl = 'https://replication-auth.test';
const token = 'test-admin-jwt';
const headers = { Authorization: 'Bearer ' + token };
const onUnauthorized = vi.fn();

function Harness() {
  const { state } = useReplicatedProducts(medusaConnector, headers, baseUrl, onUnauthorized);
  return <span>{state}</span>;
}

afterEach(async () => {
  await clearProductCache(medusaConnector.id, baseUrl);
  cleanup();
  vi.unstubAllGlobals();
});

it('sends the admin JWT as Bearer, never Basic, when replicating products', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ products: [], count: 0 }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  render(<Harness />);
  await waitFor(() => expect(screen.getByText('synced')).toBeTruthy());

  const requests = fetchMock.mock.calls.filter(([url]) => new URL(url).pathname === '/admin/products');
  expect(requests).toHaveLength(1);
  const authorization = new Headers(requests[0][1]?.headers).get('Authorization');
  expect(authorization).not.toMatch(/^Basic /);
  expect(authorization).toBe('Bearer ' + token);
  expect(onUnauthorized).not.toHaveBeenCalled();
});
