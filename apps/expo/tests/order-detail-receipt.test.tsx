// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orderReference } from '@tallyui/components';
import { PortalHost } from '@tallyui/primitives';
import { formatMoney } from '@tallyui/core';
import { createOrderBuilder, finalizeOrder, type PosOrder } from '@tallyui/pos';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { saveCachedSettings, type StoreSettings } from '../lib/store-settings';
import { OrderDetailSheet } from '../components/order-detail-sheet';

const settings: StoreSettings = {
  storeName: 'Default Store', currency: 'EUR',
  location: { id: 'loc_1', name: 'European Warehouse', addressLine: 'Street 1, Copenhagen', countryCode: 'dk' },
};
const PRINT_STYLE_ID = 'order-receipt-print-style';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test', token: 'token' });
  saveCachedSettings(localStorage, 'https://store.test', settings);
  // The stylesheet lives in document.head, which cleanup() leaves alone.
  document.getElementById(PRINT_STYLE_ID)?.remove();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('order detail Receipt (row 10.3)', () => {
  function sale(): PosOrder {
    const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
    builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
    builder.addPayment({ method: 'cash', amountMinor: 1200 });
    return { ...finalizeOrder(builder.getSnapshot()), syncStatus: 'applied' };
  }
  const formatDate = (iso: string) => iso.slice(0, 10);
  // The app's root layout holds the PortalHost the sheet renders into.
  function sheet(order: PosOrder | null) {
    return <SessionProvider><OrderDetailSheet order={order} onClose={vi.fn()} formatDate={formatDate} onRetry={vi.fn()}
      onFlush={vi.fn()} /><PortalHost /></SessionProvider>;
  }

  it('Receipt swaps the detail for TallyUI\'s receipt of the sale, with the cached store name', async () => {
    const order = sale();
    render(sheet(order));
    const detail = within(await screen.findByTestId('order-detail-sheet'));
    expect(detail.getByTestId('order-detail-close').textContent).toBe('Close');
    fireEvent.click(detail.getByTestId('order-detail-receipt'));
    const receipt = within(await screen.findByTestId('order-detail-receipt-view'));
    expect(receipt.getByTestId('receipt-order').textContent).toBe(`Order ${orderReference(order)}`);
    expect(receipt.getByText('Default Store')).toBeTruthy();
    expect(receipt.getByText('Blue shirt')).toBeTruthy();
    expect(receipt.getByLabelText(`Total: ${formatMoney({ amount: order.totalMinor, currency: 'EUR' })}`)).toBeTruthy();
    expect(screen.queryByTestId('order-detail-receipt')).toBeNull();
  });

  it('Print receipt on the reprint calls window.print once', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(sheet(sale()));
    fireEvent.click(await screen.findByTestId('order-detail-receipt'));
    fireEvent.click(within(await screen.findByTestId('order-detail-receipt-view')).getByRole('button', { name: 'Print receipt' }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('Back returns to the order detail', async () => {
    render(sheet(sale()));
    fireEvent.click(await screen.findByTestId('order-detail-receipt'));
    fireEvent.click(within(await screen.findByTestId('order-detail-receipt-view')).getByRole('button', { name: 'Back' }));
    expect(await screen.findByTestId('order-detail-receipt')).toBeTruthy();
    expect(screen.queryByTestId('order-detail-receipt-view')).toBeNull();
  });

  it('re-opening the sheet after a close starts on the order detail', async () => {
    const order = sale();
    const { rerender } = render(sheet(order));
    fireEvent.click(await screen.findByTestId('order-detail-receipt'));
    expect(await screen.findByTestId('order-detail-receipt-view')).toBeTruthy();
    rerender(sheet(null));
    expect(screen.queryByTestId('order-detail-sheet')).toBeNull();
    rerender(sheet(order));
    expect(await screen.findByTestId('order-detail-receipt')).toBeTruthy();
    expect(screen.queryByTestId('order-detail-receipt-view')).toBeNull();
  });

  it('on web, the reprint adds its print-only stylesheet', async () => {
    render(sheet(sale()));
    await screen.findByTestId('order-detail-receipt');
    expect(document.getElementById(PRINT_STYLE_ID)).toBeNull();
    fireEvent.click(screen.getByTestId('order-detail-receipt'));
    await screen.findByTestId('order-detail-receipt-view');
    expect(document.getElementById(PRINT_STYLE_ID)?.textContent).toContain('@media print');
  });
});
