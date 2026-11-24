// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatMoney, type StoreSettings as PricingSettings } from '@tallyui/core';
import { medusaConnector } from '@tallyui/connector-medusa';
import { catalogueEntries, TaxProvider, taxProviderProps, useSale } from '@tallyui/pos';
import { Cart } from '@tallyui/components';
import { OrderDiscountRow, orderDiscountInRowMinor } from './order-discount-row';

vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));

const pricing: PricingSettings = { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 } };
const traits = medusaConnector.traits.product;
const [blue] = catalogueEntries([{ id: 'shirt', title: 'Shirt', status: 'published',
  variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12.5, currency_code: 'eur' }] }] }], traits);
const money = (amount: number) => formatMoney({ amount, currency: 'EUR' });
let sale: ReturnType<typeof useSale>;
// `spy`: the sale's removeDiscount is recorded and not run, so the chip and the row can both be pressed on one order.
function SaleView({ chips, spy }: { chips: boolean; spy?: (id: string) => void }) {
  sale = useSale(pricing, { registerId: 'register-1', cashierRef: 'cashier', capabilities: { orderCreate: 4 } });
  const shown = spy ? { ...sale, removeDiscount: spy } : sale;
  // As the app's Cart: no inline "Order discount" action (it is in the + menu).
  return <Cart sale={shown} orderActions={false} orderDiscountChips={chips} afterSubtotal={<OrderDiscountRow sale={shown} />}
    couponDiscountMinor={orderDiscountInRowMinor(sale.order)} />;
}
// Two shirts at €12.50: €25.00 before tax.
function start(props: { chips: boolean; spy?: (id: string) => void }) {
  render(<TaxProvider {...taxProviderProps(pricing)}><SaleView {...props} /></TaxProvider>);
  act(() => { sale.add(blue, traits); sale.add(blue, traits); });
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('OrderDiscountRow', () => {
  it('reads "Discount (10%)" with order.display\'s amount, once, and ✕ removes it as the chip did', () => {
    start({ chips: false });
    const plain = sale.order.totalMinor;
    act(() => { expect(sale.applyDiscount(null, { type: 'percentage', value: 10 })).toBeNull(); });
    expect(sale.order.display.orderDiscountMinor).toBe(250);
    const row = within(screen.getByTestId('order-discount-row-0'));
    expect(row.getByText('Discount (10%)')).toBeTruthy();
    expect(row.getByText(`−${money(250)}`)).toBeTruthy();
    // No chip under the lines, and Cart's own Discount row leaves the order discount out.
    expect(screen.queryByText(/Order discount/)).toBeNull();
    expect(within(screen.getByTestId('cart-footer')).queryByText('Discount')).toBeNull();
    expect(screen.getAllByText(`−${money(250)}`)).toHaveLength(1);
    fireEvent.click(screen.getByTestId('order-discount-remove-0'));
    expect(sale.order.discounts).toEqual([]);
    expect(sale.order.totalMinor).toBe(plain);
    expect(screen.queryByTestId('order-discount-row-0')).toBeNull();
  });

  it('calls the same removal as the chip, with the same argument', () => {
    const spy = vi.fn();
    start({ chips: true, spy });
    act(() => { sale.applyDiscount(null, { type: 'percentage', value: 10 }); });
    fireEvent.click(screen.getByRole('button', { name: `Remove discount Order discount 10% −${money(250)}` }));
    // The ✕ names its discount, so a screen reader tells several apart.
    fireEvent.click(screen.getByRole('button', { name: 'Remove discount 10%' }));
    expect(spy.mock.calls).toEqual([[sale.order.discounts[0].id], [sale.order.discounts[0].id]]);
  });

  it('labels a fixed order discount "Discount"', () => {
    start({ chips: false });
    act(() => { sale.applyDiscount(null, { type: 'fixed', value: 50 }); });
    expect(screen.getByTestId('order-discount-row-0').textContent).toBe(`Discount−${money(50)}`);
    expect(screen.getByTestId('order-discount-remove-0').getAttribute('aria-label')).toBe(`Remove discount ${money(50)}`);
  });

  it('keeps two order discounts in Cart\'s Discount row so the visible totals add up', () => {
    start({ chips: false });
    act(() => {
      expect(sale.applyDiscount(null, { type: 'percentage', value: 10 })).toBeNull();
      expect(sale.applyDiscount(null, { type: 'fixed', value: 100 })).toBeNull();
    });
    expect(screen.getByTestId('order-discount-row-0').textContent).toBe('Discount (10%)');
    expect(screen.getByTestId('order-discount-row-1').textContent).toBe(`Discount (${money(100)})`);
    const { subtotalMinor, orderDiscountMinor, taxMinor } = sale.order.display;
    const footer = within(screen.getByTestId('cart-footer'));
    expect(footer.getByText('Subtotal').parentElement!.textContent).toBe(`Subtotal${money(subtotalMinor)}`);
    expect(footer.getByText('Discount').parentElement!.textContent).toBe(`Discount−${money(orderDiscountMinor)}`);
    expect(within(footer.getByTestId('cart-total-tax-0')).getByText(money(taxMinor)!)).toBeTruthy();
    expect(subtotalMinor - orderDiscountMinor + taxMinor).toBe(sale.order.totalMinor);
    expect(footer.getByText('Total').parentElement!.textContent).toBe(`Total${money(sale.order.totalMinor)}`);
  });

  it('orderDiscountInRowMinor returns the display amount only for a single order discount', () => {
    start({ chips: false });
    expect(orderDiscountInRowMinor(sale.order)).toBe(0);
    act(() => { sale.applyDiscount(null, { type: 'percentage', value: 10 }); });
    expect(sale.order.display.orderDiscountMinor).toBe(250);
    expect(orderDiscountInRowMinor(sale.order)).toBe(sale.order.display.orderDiscountMinor);
    act(() => { sale.applyDiscount(null, { type: 'fixed', value: 100 }); });
    expect(sale.order.discounts).toHaveLength(2);
    expect(orderDiscountInRowMinor(sale.order)).toBe(0);
  });

  it('renders nothing without an order discount, a line discount included', () => {
    start({ chips: false });
    expect(screen.queryByTestId('order-discount-row-0')).toBeNull();
    act(() => { sale.applyDiscount(sale.order.lineItems[0].id, { type: 'percentage', value: 10 }); });
    expect(screen.queryByTestId('order-discount-row-0')).toBeNull();
    expect(screen.queryByTestId('order-discount-remove-0')).toBeNull();
  });
});
