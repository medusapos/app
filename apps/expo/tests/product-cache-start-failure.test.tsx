// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StorageUnavailableError } from '@tallyui/storage-sqlite/web';
import { reportStorageStartFailure } from '../lib/live-tab';
import { createPosConnector } from '../lib/pos-connector';
import { openProductCache } from '../lib/product-cache';
import { useReplicatedProducts } from '../lib/use-replicated-products';

vi.mock('../lib/product-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/product-cache')>()),
  openProductCache: vi.fn(),
}));
vi.mock('../lib/live-tab', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/live-tab')>()),
  reportStorageStartFailure: vi.fn(),
}));

const connector = createPosConnector();
const context = { connectorId: connector.id, baseUrl: 'https://product-cache-start-failure.test', headers: {} };
const onUnauthorized = vi.fn();
function Harness() {
  const { state } = useReplicatedProducts(connector, context, onUnauthorized);
  return <span>{state}</span>;
}

afterEach(() => { cleanup(); });

it('reports unavailable storage once when the product cache fails to start, and sets state to error', async () => {
  vi.mocked(openProductCache).mockRejectedValue(new StorageUnavailableError('StorageUnavailableError: no OPFS'));
  render(<Harness />);
  await waitFor(() => expect(reportStorageStartFailure).toHaveBeenCalledWith('unavailable'));
  expect(reportStorageStartFailure).toHaveBeenCalledTimes(1);
  expect(screen.getByText('error')).toBeTruthy();
});
