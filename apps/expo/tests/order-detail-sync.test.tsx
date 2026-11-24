// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortalHost } from '@tallyui/primitives';
import { createOrderBuilder, finalizeOrder, type PosOrder, type PosOrderSyncStatus } from '@tallyui/pos';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { saveCachedSettings, type StoreSettings } from '../lib/store-settings';
import { OrderDetailSheet } from '../components/order-detail-sheet';

const settings: StoreSettings = {
  storeName: 'Default Store', currency: 'EUR',
  location: { id: 'loc_1', name: 'European Warehouse', addressLine: 'Street 1, Copenhagen', countryCode: 'dk' },
};

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  saveSession(localStorage, { baseUrl: 'https://store.test', email: 'admin@store.test', token: 'token' });
  saveCachedSettings(localStorage, 'https://store.test', settings);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('order detail Sync (row 10.3)', () => {
  function sale(syncStatus: PosOrderSyncStatus, code?: string): PosOrder {
    const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
    builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
    builder.addPayment({ method: 'cash', amountMinor: 1200 });
    const order: PosOrder = { ...finalizeOrder(builder.getSnapshot()), syncStatus };
    return code ? { ...order, error: { code, message: 'Refused' } } : order;
  }
  const formatDate = (iso: string) => iso.slice(0, 10);
  function sheet(order: PosOrder | null, onRetry = vi.fn(async () => 1), onFlush = vi.fn(async () => {})) {
    return <SessionProvider><OrderDetailSheet order={order} onClose={vi.fn()} formatDate={formatDate} onRetry={onRetry}
      onFlush={onFlush} /><PortalHost /></SessionProvider>;
  }
  const disabled = (element: HTMLElement) => element.getAttribute('aria-disabled') === 'true';

  describe('order detail sync notices', () => {
    it('shows the closure notice for an applied sale counted in a closed register', async () => {
      render(sheet({ ...sale('applied'), countedInClosureOf: 'reg_1' }));
      expect((await screen.findByTestId('order-detail-notices')).textContent)
        .toBe("Recorded after the register closed. Its payment is in that register's closure.");
    });

    it('has no notice text for an applied sale without notice fields', async () => {
      render(sheet(sale('applied')));
      expect((await screen.findByTestId('order-detail-notices')).textContent).toBe('');
    });
  });

  it('a pending sale shows Sync first in the footer, and pressing it flushes', async () => {
    const onRetry = vi.fn(async () => 1);
    const onFlush = vi.fn(async () => {});
    render(sheet(sale('pending'), onRetry, onFlush));
    const sync = await screen.findByTestId('order-detail-sync');
    expect(sync.textContent).toBe('Sync');
    expect(sync.parentElement?.firstElementChild).toBe(sync);
    expect(sync.compareDocumentPosition(screen.getByTestId('order-detail-close')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { fireEvent.click(sync); });
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('a rejected sale the outbox resends shows Sync, and pressing it requeues that sale', async () => {
    const onRetry = vi.fn(async () => 1);
    const onFlush = vi.fn(async () => {});
    const order = sale('rejected', 'store_configuration');
    render(sheet(order, onRetry, onFlush));
    await act(async () => { fireEvent.click(await screen.findByTestId('order-detail-sync')); });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith([order.id]);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('an applied sale shows no Sync, and keeps Close and Receipt', async () => {
    render(sheet(sale('applied')));
    expect(await screen.findByTestId('order-detail-close')).toBeTruthy();
    expect(screen.getByTestId('order-detail-receipt')).toBeTruthy();
    expect(screen.queryByTestId('order-detail-sync')).toBeNull();
  });

  it('Sync is disabled while the send is in flight, and enabled again after it', async () => {
    let resolve!: () => void;
    const onFlush = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    render(sheet(sale('pending'), undefined, onFlush));
    const sync = await screen.findByTestId('order-detail-sync');
    expect(disabled(sync)).toBe(false);
    await act(async () => { fireEvent.click(sync); });
    expect(disabled(screen.getByTestId('order-detail-sync'))).toBe(true);
    await act(async () => { resolve(); });
    expect(disabled(screen.getByTestId('order-detail-sync'))).toBe(false);
  });

  it('the open sheet drops Sync once the sale is applied', async () => {
    const order = sale('pending');
    const { rerender } = render(sheet(order));
    expect(await screen.findByTestId('order-detail-sync')).toBeTruthy();
    rerender(sheet({ ...order, syncStatus: 'applied' }));
    expect(screen.queryByTestId('order-detail-sync')).toBeNull();
    expect(screen.getByTestId('order-detail-close')).toBeTruthy();
  });
});
