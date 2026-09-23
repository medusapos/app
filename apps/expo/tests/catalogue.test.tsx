// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { Subject } from 'rxjs';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { medusaConnector } from '@tallyui/connector-medusa';
import type { ProductCard, ProductGrid, SearchInput } from '@tallyui/components';
import { Catalogue } from '../components/catalogue';
import { createTallyDatabase } from '@tallyui/database';
import { clearProductCache, productCacheName, productCacheStorage } from '../lib/product-cache';
import { useReplicatedProducts } from '../lib/use-replicated-products';

vi.mock('@tallyui/components', () => ({
  SearchInput: ({ value, onChangeText, onSubmitEditing, placeholder, autoFocus }: ComponentProps<typeof SearchInput>) => (
    <input value={value} placeholder={placeholder} autoFocus={autoFocus}
      onChange={(event) => onChangeText(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter') onSubmitEditing?.({} as never); }} />
  ),
  ProductGrid: ({ items, renderItem, emptyState, numColumns }: ComponentProps<typeof ProductGrid>) => (
    <div data-testid="grid" data-columns={numColumns}>
      {items.length ? items.map((item, index) => <div key={item.id}>{renderItem(item, index)}</div>) : emptyState}
    </div>
  ),
  ProductCard: ({ doc, onPress }: ComponentProps<typeof ProductCard>) => (
    <button onClick={onPress}>{doc.title as ReactNode}</button>
  ),
}));

const traits = medusaConnector.traits.product;
const products = [
  { id: 'hat', title: 'Blue Hat', status: 'published', variants: [
    { id: 'hat-one', title: 'One size', sku: 'LARGE-CODE', barcode: '111',
      prices: [{ amount: 10, currency_code: 'eur' }], manage_inventory: false },
  ] },
  { id: 'shirt', title: 'Red Shirt', status: 'published', variants: [
    { id: 'small', title: 'Small', sku: 'SHIRT-S', barcode: '222',
      prices: [{ amount: 20, currency_code: 'eur' }], manage_inventory: false },
    { id: 'large', title: 'Large', sku: 'SHIRT-L', barcode: 'LARGE-CODE',
      prices: [{ amount: 25, currency_code: 'eur' }], manage_inventory: true, inventory_quantity: 0 },
  ] },
];

afterEach(cleanup);

function mount(items = products) {
  const onSelect = vi.fn();
  render(<Catalogue products={items} traits={traits} currency="EUR" onSelect={onSelect} statusText="Synced" />);
  const input = screen.getByPlaceholderText('Search or scan barcode / SKU') as HTMLInputElement;
  return { input, onSelect };
}

describe('Catalogue', () => {
  it('filters products through search and shows matching counts', () => {
    const { input } = mount();
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'red' } });
    expect(screen.getByRole('button', { name: 'Red Shirt' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Blue Hat' })).toBeNull();
    expect(screen.getByText('Synced · 1 matching')).toBeTruthy();
  });
  it('submits a barcode across all variants, preferring it over another product SKU, and clears search', () => {
    const { input, onSelect } = mount();
    fireEvent.change(input, { target: { value: ' large-code ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({
      product: products[1], variant: traits.getVariants!(products[1])[1],
    });
    expect(input.value).toBe('');
    expect(screen.getByRole('button', { name: 'Blue Hat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Red Shirt' })).toBeTruthy();
  });
  it('leaves an unknown code and its results intact', () => {
    const { input, onSelect } = mount();
    fireEvent.change(input, { target: { value: 'missing' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
    expect(input.value).toBe('missing');
    expect(screen.getByText('No products match "missing".')).toBeTruthy();
  });
  it('selects a single variant by tapping its product', () => {
    const { onSelect } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Blue Hat' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({
      product: products[0], variant: traits.getVariants!(products[0])[0],
    });
    expect(screen.queryByLabelText('Choose variant')).toBeNull();
  });
  it('shows variant details and lets an out-of-stock variant be selected', () => {
    const { onSelect } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Red Shirt' }));
    expect(onSelect).not.toHaveBeenCalled();
    const chooser = within(screen.getByLabelText('Choose variant'));
    expect(chooser.getByText('Small')).toBeTruthy();
    expect(chooser.getByText('SHIRT-L')).toBeTruthy();
    expect(chooser.getByText('€25.00')).toBeTruthy();
    expect(chooser.getByText('Out of Stock')).toBeTruthy();
    fireEvent.click(chooser.getByRole('button', { name: /Large/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({
      product: products[1], variant: traits.getVariants!(products[1])[1],
    });
    expect(screen.queryByLabelText('Choose variant')).toBeNull();
  });
  it('closes the chooser on Cancel without selecting', () => {
    const { onSelect } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Red Shirt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Choose variant')).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('shows an empty catalogue', () => {
    mount([]);
    expect(screen.getByText('No products yet.')).toBeTruthy();
  });
  it.each([[599, 2], [600, 4], [1023, 4], [1024, 6]])('uses %i px width for %i columns', (width, columns) => {
    const originalWidth = document.documentElement.clientWidth;
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
    fireEvent(window, new Event('resize'));
    mount();
    expect(screen.getByTestId('grid').getAttribute('data-columns')).toBe(String(columns));
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: originalWidth });
    fireEvent(window, new Event('resize'));
  });
});

describe('replicated catalogue recovery', () => {
  it('retains cached products on an offline open and recovers after initial and later pull failures', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const baseUrl = 'https://catalogue-recovery.test';
    const stream = new Subject<'RESYNC'>();
    let failure: Error | null = new TypeError('Failed to fetch');
    const connector = { ...medusaConnector, replication: { products: { pull: {
      stream$: stream,
      handler: async () => {
        if (failure) throw failure;
        return { documents: [], checkpoint: { id: 'done' } };
      },
    } } } };
    const credentials = { api_token: 'test' };
    const onUnauthorized = vi.fn();
    const db = await createTallyDatabase({ connector,
      name: productCacheName(connector.id, baseUrl), storage: productCacheStorage() });
    await db.products.insert({ ...products[0], handle: 'blue-hat' });
    await db.close();
    const { result, unmount } = renderHook(() => useReplicatedProducts(connector, credentials, baseUrl, onUnauthorized));
    try {
      await waitFor(() => expect(result.current.state).toBe('offline'));
      expect(result.current.products.map((product) => product.id)).toEqual(['hat']);
      expect(result.current.error).toBe('Failed to fetch');
      failure = null;
      await waitFor(() => expect(result.current.state).toBe('synced'), { timeout: 7000 });
      expect(result.current.error).toBeNull();
      failure = new Error('Medusa API error: 503');
      act(() => stream.next('RESYNC'));
      await waitFor(() => expect(result.current.state).toBe('error'));
      expect(result.current.products.map((product) => product.id)).toEqual(['hat']);
      failure = null;
      await waitFor(() => expect(result.current.state).toBe('synced'), { timeout: 7000 });
      expect(result.current.error).toBeNull();
      expect(onUnauthorized).not.toHaveBeenCalled();
    } finally {
      await clearProductCache(connector.id, baseUrl);
      unmount();
      stream.complete();
      vi.unstubAllGlobals();
    }
  }, 16000);
});
