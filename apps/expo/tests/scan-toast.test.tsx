// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VariantSummary } from '@tallyui/core';
import { SCAN_TOAST_MS, ScanToast, scanAddedDescription, useScanToast } from '../components/scan-toast';
import { PRODUCTS_SCAN_MATCHES } from '../lib/products-area';

const variant = (fields: Partial<VariantSummary>): VariantSummary => ({ id: 'v', prices: [], ...fields } as VariantSummary);
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('scanAddedDescription', () => {
  it('a single-variant product shows its name only', () => {
    expect(scanAddedDescription('Shirt', variant({ title: 'Blue' }), 1)).toBe('Shirt');
  });

  it('a product with several variants adds the trimmed variant title', () => {
    expect(scanAddedDescription('Shirt', variant({ title: 'S / White' }), 3)).toBe('Shirt · S / White');
    expect(scanAddedDescription('Shirt', variant({ title: '  S / White ' }), 3)).toBe('Shirt · S / White');
  });

  it('option values join with ", " as v2 shows them', () => {
    expect(scanAddedDescription('Jacket', variant({ options: { Size: 'XS', Color: 'Gray' } }), 1)).toBe('Jacket · XS, Gray');
  });

  it('options take precedence over the title', () => {
    expect(scanAddedDescription('Jacket', variant({ title: 'XS / Gray', options: { Size: 'XS', Color: 'Gray' } }), 3))
      .toBe('Jacket · XS, Gray');
  });

  it('an empty options object falls back to the title rule', () => {
    expect(scanAddedDescription('Shirt', variant({ title: 'S / White', options: {} }), 3)).toBe('Shirt · S / White');
    expect(scanAddedDescription('Shirt', variant({ title: 'Blue', options: {} }), 1)).toBe('Shirt');
  });
});

describe('ScanToast', () => {
  afterEach(() => { cleanup(); });

  it('describes zero, one and several Products matches', () => {
    expect(PRODUCTS_SCAN_MATCHES(0)).toBe('No products match');
    expect(PRODUCTS_SCAN_MATCHES(1)).toBe('1 product matches');
    expect(PRODUCTS_SCAN_MATCHES(3)).toBe('3 products match');
  });

  it('announces a matching Products scan politely', () => {
    render(<ScanToast toast={{ kind: 'scanned', code: 'ABC123', count: 2 }} />);
    const toast = screen.getByTestId('scan-toast');
    expect(toast.textContent).toContain('Barcode scanned: ABC123');
    expect(toast.textContent).toContain('2 products match');
    expect(toast.getAttribute('aria-live')).toBe('polite');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('announces a Products scan with no matches as an alert', () => {
    render(<ScanToast toast={{ kind: 'scanned', code: 'ABC123', count: 0 }} />);
    const toast = screen.getByRole('alert');
    expect(toast.textContent).toContain('Barcode scanned: ABC123');
    expect(toast.textContent).toContain('No products match');
  });

  it('reads Added to cart with the description', () => {
    render(<ScanToast toast={{ kind: 'added', description: 'Jacket · XS, Gray' }} />);
    const toast = screen.getByTestId('scan-toast');
    expect(toast.textContent).toContain('Added to cart');
    expect(toast.textContent).toContain('Jacket · XS, Gray');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reads Barcode not found with the code, as an alert', () => {
    render(<ScanToast toast={{ kind: 'not-found', code: 'AB9' }} />);
    const toast = screen.getByRole('alert');
    expect(toast.getAttribute('data-testid')).toBe('scan-toast');
    expect(toast.textContent).toContain('Barcode not found');
    expect(toast.textContent).toContain('AB9 — not in this store');
  });
});

describe('useScanToast', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('show sets the toast, and it is gone after SCAN_TOAST_MS', () => {
    const { result } = renderHook(() => useScanToast());
    expect(result.current.toast).toBeNull();
    act(() => { result.current.show({ kind: 'not-found', code: 'AB9' }); });
    expect(result.current.toast).toEqual({ kind: 'not-found', code: 'AB9' });
    advance(SCAN_TOAST_MS - 1);
    expect(result.current.toast).not.toBeNull();
    advance(1);
    expect(result.current.toast).toBeNull();
  });

  it('a second show replaces the toast and restarts the wait', () => {
    const { result } = renderHook(() => useScanToast());
    act(() => { result.current.show({ kind: 'not-found', code: 'AB9' }); });
    advance(SCAN_TOAST_MS - 1);
    act(() => { result.current.show({ kind: 'added', description: 'Shirt' }); });
    advance(SCAN_TOAST_MS - 1);
    expect(result.current.toast).toEqual({ kind: 'added', description: 'Shirt' });
    advance(1);
    expect(result.current.toast).toBeNull();
  });

  it('clear hides it at once', () => {
    const { result } = renderHook(() => useScanToast());
    act(() => { result.current.show({ kind: 'added', description: 'Shirt' }); });
    act(() => { result.current.clear(); });
    expect(result.current.toast).toBeNull();
    advance(SCAN_TOAST_MS);
    expect(result.current.toast).toBeNull();
  });
});
