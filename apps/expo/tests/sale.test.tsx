// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatMoney, moneyFromDecimalString } from '@tallyui/core';
import { medusaConnector } from '@tallyui/connector-medusa';
import { createOrderBuilder, type LineItem, type PosOrder } from '@tallyui/pos';
import type { CartPanelProps, CartLineProps, CartTotalProps, CashTenderedProps, ChangeDisplayProps } from '@tallyui/components';
import { Cart } from '../components/cart';
import { Tender } from '../components/tender';
import { Receipt } from '../components/receipt';
import { catalogueEntries } from '../lib/catalogue';
import { useSale } from '../lib/use-sale';
import { fetchStoreSettings, loadCachedSettings, saveCachedSettings, StoreSettingsError, taxContextFor, type StoreSettings } from '../lib/store-settings';
import { useSession } from '../lib/session-context';
import ProductsScreen from '../app/index';

vi.mock('@tallyui/components', () => ({
  CartPanel: ({ items, renderItem, footer, emptyState }: CartPanelProps<LineItem>) =>
    <div>{items.length ? items.map((item, index) => <div key={item.id}>{renderItem(item, index)}</div>) : emptyState}{footer}</div>,
  CartLine: ({ name, quantity, unitPrice, lineTotal }: CartLineProps) => <div role="group" aria-label={name}>
    <span>{name}</span><span>Quantity: {quantity}</span><span>Unit: {formatMoney(unitPrice)}</span><span>Line: {formatMoney(lineTotal)}</span>
  </div>,
  CartTotal: ({ subtotal, taxLines, total }: CartTotalProps) => <div>
    <span>Subtotal: {formatMoney(subtotal)}</span>
    {taxLines?.map((line, index) => <span key={index}>{line.label}: {formatMoney(line.amount)}</span>)}
    <span>Total: {formatMoney(total)}</span>
  </div>,
  CashTendered: ({ total, amount, onChangeAmount }: CashTenderedProps) => <div>
    <span>To pay: {formatMoney(total)}</span><span>Tendered: {amount && formatMoney(amount)}</span>
    <input aria-label="Cash tendered" onChange={(event) => {
      const money = moneyFromDecimalString(event.target.value, total.currency);
      if (money) onChangeAmount?.(money);
    }} />
    <button onClick={() => onChangeAmount?.(total)}>Exact cash</button>
  </div>,
  ChangeDisplay: ({ change }: ChangeDisplayProps) => <span>Change due: {formatMoney(change)}</span>,
  ProductGrid: ({ emptyState }: { emptyState: React.ReactNode }) => <div>{emptyState}</div>,
  ProductCard: () => null,
  SearchInput: () => <input aria-label="Search catalogue" />,
}));
vi.mock('expo-router', () => ({ Redirect: () => null, router: { replace: vi.fn() }, Stack: { Screen: () => null } }));
vi.mock('../lib/session-context', () => ({ useSession: vi.fn() }));
vi.mock('../lib/outbox-context', () => ({
  useOutboxContext: () => ({ record: vi.fn(), state: { pending: 0, sending: false }, recent: [] }),
}));
vi.mock('../lib/use-replicated-products', () => ({
  useReplicatedProducts: () => ({ products: [], state: 'synced', error: null }),
}));
vi.mock('../lib/store-settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/store-settings')>(), fetchStoreSettings: vi.fn(),
}));

const settings: StoreSettings = {
  storeName: 'Test shop', currency: 'EUR', pricesIncludeTax: false, taxRatePpm: 250000,
  location: { id: 'loc', name: 'Main', addressLine: '1 High Street', countryCode: 'dk' },
};
const session = { baseUrl: 'https://store.test', email: 'cashier@store.test', token: 'token' };
const traits = medusaConnector.traits.product;
const product = {
  id: 'shirt', title: 'Shirt', status: 'published', variants: [
    { id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12.5, currency_code: 'eur' }] },
    { id: 'red', title: 'Red', sku: 'RED', prices: [{ amount: 10, currency_code: 'eur' }] },
  ],
};
const entries = catalogueEntries([product], traits);
let sale: ReturnType<typeof useSale>;
function SaleHarness({ onSaleCompleted }: { onSaleCompleted?: (order: PosOrder) => Promise<void> | void }) {
  sale = useSale(settings, { registerId: 'register-1', cashierRef: session.email, onSaleCompleted });
  if (sale.stage.kind === 'receipt') return <Receipt order={sale.stage.order} settings={settings}
    cashier={session.email} registerId="register-1" newSale={sale.newSale} />;
  return sale.stage.kind === 'cart' ? <Cart sale={sale} /> : <Tender sale={sale} />;
}
const money = (amount: number) => formatMoney({ amount, currency: settings.currency });
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const typeCash = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Cash tendered' }), { target: { value } });
function addSaleLines() { act(() => { sale.add(entries[0], traits); sale.add(entries[1], traits); sale.add(entries[0], traits); }); }

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  vi.mocked(fetchStoreSettings).mockReset().mockResolvedValue(settings);
  vi.mocked(useSession).mockReturnValue({ session, signIn: vi.fn(), signOut: vi.fn(), reportUnauthorized: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('sale', () => {
  it('merges variants and displays builder quantities, unit prices, line totals and order totals', () => {
    render(<SaleHarness />);
    addSaleLines();
    const expected = createOrderBuilder({ currency: settings.currency, taxContext: taxContextFor(settings) });
    expected.addLine({ productId: 'shirt', variantId: 'blue', name: 'Shirt · Blue', unitPrice: { amount: 1250, currency: 'EUR' }, quantity: 2 });
    expected.addLine({ productId: 'shirt', variantId: 'red', name: 'Shirt · Red', unitPrice: { amount: 1000, currency: 'EUR' } });
    const order = expected.getSnapshot();
    expect(sale.order.lineItems.map((line) => line.quantity)).toEqual([2, 1]);
    for (const line of order.lineItems) {
      const group = within(screen.getByRole('group', { name: line.name }));
      expect(group.getByText(`Quantity: ${line.quantity}`)).toBeTruthy();
      expect(group.getByText(`Unit: ${money(line.unitPriceMinor)}`)).toBeTruthy();
      expect(group.getByText(`Line: ${money(line.netMinor)}`)).toBeTruthy();
    }
    expect(screen.getByText(`Subtotal: ${money(order.subtotalMinor)}`)).toBeTruthy();
    expect(screen.getByText(`VAT 25%: ${money(order.taxMinor)}`)).toBeTruthy();
    expect(screen.getByText(`Total: ${money(order.totalMinor)}`)).toBeTruthy();
    click('Increase Shirt · Red');
    expect(sale.order.lineItems[1].quantity).toBe(2);
  });

  it('removes at zero or with Remove and cannot tender an empty cart', () => {
    render(<SaleHarness />);
    addSaleLines();
    click('Decrease Shirt · Red');
    expect(sale.order.lineItems.map((line) => line.variantId)).toEqual(['blue']);
    click('Remove Shirt · Blue');
    expect(sale.order.lineItems).toEqual([]);
    expect(screen.getByText('Scan or tap a product to start a sale.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cash' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('button', { name: 'Card terminal' }).getAttribute('aria-disabled')).toBe('true');
    act(() => sale.startTender('cash'));
    expect(sale.stage.kind).toBe('cart');
  });

  it('completes cash with builder change and a finalized payment, prints, then starts a fresh sale', async () => {
    const completed = vi.fn();
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<SaleHarness onSaleCompleted={completed} />);
    addSaleLines();
    const before = sale.order;
    expect(before.totalMinor).toBe(4375);
    click('Cash');
    typeCash('50');
    expect(screen.getByText(`Change due: ${money(sale.order.changeDueMinor)}`)).toBeTruthy();
    await act(async () => { click('Complete sale'); });
    expect(sale.stage.kind).toBe('receipt');
    expect(screen.getByLabelText(`Change: ${money(625)}`)).toBeTruthy();
    expect(screen.getByLabelText(`Cash tendered: ${money(5000)}`)).toBeTruthy();
    expect(screen.getAllByLabelText(`VAT 25%: ${money(before.taxMinor)}`)).toHaveLength(1);
    expect(screen.getByText('Test shop')).toBeTruthy();
    expect(screen.getByText('1 High Street')).toBeTruthy();
    expect(screen.getByText(`Order ${before.id.slice(-8)}`)).toBeTruthy();
    expect(screen.getByText(before.createdAt)).toBeTruthy();
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0][0]).toMatchObject({ registerId: 'register-1', cashierRef: session.email,
      totalMinor: 4375, payments: [{ method: 'cash', amountMinor: 4375, tenderedMinor: 5000, changeMinor: 625 }] });
    click('Print receipt');
    expect(print).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Print receipt' }).closest('[data-print="hide"]')).toBeTruthy();
    expect(document.querySelectorAll('#pos-print-style')).toHaveLength(1);
    expect(document.getElementById('pos-print-style')?.textContent).toContain('@media print');
    click('New sale');
    expect(sale.stage.kind).toBe('cart');
    expect(sale.order.id).not.toBe(before.id);
    expect(sale.order.lineItems).toEqual([]);
    expect(sale.order.payments).toEqual([]);
    expect(screen.getByText('Scan or tap a product to start a sale.')).toBeTruthy();
  });

  it('keeps an underpaid tender on finalize failure, replaces amounts and removes it on Back', async () => {
    const completed = vi.fn();
    render(<SaleHarness onSaleCompleted={completed} />);
    addSaleLines();
    click('Cash');
    typeCash('10');
    expect(screen.getByText(`Balance due: ${money(sale.order.balanceDueMinor)}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete sale' }).getAttribute('aria-disabled')).toBe('true');
    const tender = sale.order.payments[0];
    await act(async () => { await sale.complete(); });
    expect(screen.getByRole('alert').textContent).toBe('finalize: underpaid');
    expect(sale.stage).toEqual({ kind: 'tender', method: 'cash' });
    expect(sale.order.payments).toEqual([tender]);
    expect(completed).not.toHaveBeenCalled();
    typeCash('20');
    expect(sale.order.payments).toHaveLength(1);
    expect(sale.order.payments[0].amountMinor).toBe(2000);
    typeCash('50');
    expect(sale.order.payments).toHaveLength(1);
    expect(sale.order.payments[0].amountMinor).toBe(5000);
    expect(sale.error).toBeNull();
    click('Back');
    expect(sale.stage.kind).toBe('cart');
    expect(sale.order.payments).toEqual([]);
    expect(sale.order.balanceDueMinor).toBe(sale.order.totalMinor);
  });

  it('records quick cash amounts through the same single pending payment', async () => {
    render(<SaleHarness />);
    addSaleLines();
    click('Cash');
    click('Exact cash');
    expect(sale.order.payments).toHaveLength(1);
    expect(sale.order.payments[0].amountMinor).toBe(sale.order.totalMinor);
    expect(sale.order.balanceDueMinor).toBe(0);
    await act(async () => { click('Complete sale'); });
    expect(sale.stage.kind).toBe('receipt');
  });

  it('completes a card terminal payment with its optional reference', async () => {
    const completed = vi.fn();
    render(<SaleHarness onSaleCompleted={completed} />);
    addSaleLines();
    click('Card terminal');
    expect(sale.order.payments).toHaveLength(1);
    expect(sale.order.payments[0]).toMatchObject({ method: 'external', amountMinor: sale.order.totalMinor });
    fireEvent.change(screen.getByRole('textbox', { name: 'Terminal reference' }), { target: { value: 'A1B2' } });
    expect(sale.order.payments).toHaveLength(1);
    await act(async () => { click('Payment approved on terminal'); });
    expect(screen.getByLabelText(`Card terminal: ${money(4375)} · A1B2`)).toBeTruthy();
    expect(completed.mock.calls[0][0].payments).toEqual([expect.objectContaining({ method: 'external', amountMinor: 4375, reference: 'A1B2' })]);
    expect(document.querySelectorAll('#pos-print-style')).toHaveLength(1);
  });

  it('waits for the sale to be saved before showing the receipt', async () => {
    let saved!: () => void;
    const completed = vi.fn(() => new Promise<void>((resolve) => { saved = resolve; }));
    render(<SaleHarness onSaleCompleted={completed} />);
    addSaleLines();
    click('Card terminal');
    let completion!: Promise<void>;
    act(() => { completion = sale.complete(); });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(sale.stage.kind).toBe('tender');
    expect(screen.queryByRole('button', { name: 'Print receipt' })).toBeNull();
    await act(async () => { saved(); await completion; });
    expect(sale.stage.kind).toBe('receipt');
  });

  it('keeps the tender and reports a saving failure', async () => {
    render(<SaleHarness onSaleCompleted={async () => { throw new Error('Storage full'); }} />);
    addSaleLines();
    click('Card terminal');
    const before = sale.order;
    await act(async () => { await sale.complete(); });
    expect(sale.stage).toEqual({ kind: 'tender', method: 'external' });
    expect(sale.order).toEqual(before);
    expect(screen.getByRole('alert').textContent).toBe('The sale could not be saved: Storage full');
    expect(screen.queryByRole('button', { name: 'Print receipt' })).toBeNull();
  });

  it('reports CartError without adding an unpriced line', () => {
    render(<SaleHarness />);
    act(() => sale.add({ ...entries[0], variant: { ...entries[0].variant, prices: [] } }, traits));
    expect(screen.getByRole('alert').textContent).toBe('No EUR price for Shirt · Blue');
    expect(sale.order.lineItems).toEqual([]);
  });
});

describe('store settings on the POS screen', () => {
  it('renders cached settings immediately and keeps the POS when the fetch is unreachable', async () => {
    saveCachedSettings(localStorage, session.baseUrl, settings);
    vi.mocked(fetchStoreSettings).mockRejectedValue(new StoreSettingsError('unreachable', 'Could not reach the backend.'));
    render(<ProductsScreen />);
    expect(screen.getByText('Scan or tap a product to start a sale.')).toBeTruthy();
    expect(await screen.findByText('Offline')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cash' })).toBeTruthy();
    expect(fetchStoreSettings).toHaveBeenCalledExactlyOnceWith(session);
  });

  it('reports an unauthorized fetch to the session', async () => {
    vi.mocked(fetchStoreSettings).mockRejectedValue(new StoreSettingsError('unauthorized', 'Please sign in again.'));
    await act(async () => { render(<ProductsScreen />); });
    expect(useSession().reportUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('shows an error without a cache and Retry refetches and saves the settings', async () => {
    vi.mocked(fetchStoreSettings).mockRejectedValueOnce(new StoreSettingsError('unreachable', 'Could not reach the backend.'));
    render(<ProductsScreen />);
    expect(await screen.findByText('Could not reach the backend.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cash' })).toBeNull();
    click('Retry');
    expect(await screen.findByText('Scan or tap a product to start a sale.')).toBeTruthy();
    expect(fetchStoreSettings).toHaveBeenCalledTimes(2);
    expect(loadCachedSettings(localStorage, session.baseUrl)).toEqual(settings);
  });
});
