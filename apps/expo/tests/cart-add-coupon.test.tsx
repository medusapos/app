// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ServerCapabilities, type StoreSettings as PricingSettings } from '@tallyui/core';
import { medusaConnector } from '@tallyui/connector-medusa';
import { catalogueEntries, TaxProvider, taxProviderProps, useSale } from '@tallyui/pos';
import { Cart } from '@tallyui/components';
import { PortalHost } from '@tallyui/primitives';
import { CartAddMenu } from '../components/cart-add-menu';
import { CouponField, couponDiscountMinor } from '../components/coupon-field';
import { createMedusaDiscountCodes } from '../lib/coupons';

vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('../lib/session-context', () => ({ useSession: vi.fn() }));

const pricing: PricingSettings = { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 } };
const traits = medusaConnector.traits.product;
const [blue] = catalogueEntries([{ id: 'shirt', title: 'Shirt', status: 'published',
  variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12.5, currency_code: 'eur' }] }] }], traits);
let sale: ReturnType<typeof useSale>;
function SaleView({ discountCodes, capabilities }: {
  discountCodes: ReturnType<typeof createMedusaDiscountCodes>; capabilities: ServerCapabilities;
}) {
  sale = useSale(pricing, { registerId: 'register-1', cashierRef: 'cashier', capabilities, discountCodes });
  return <>
    <CartAddMenu sale={sale} />
    <Cart sale={sale} afterSubtotal={<CouponField sale={sale} />} couponDiscountMinor={couponDiscountMinor(sale.order)} />
  </>;
}
function start(capabilities: ServerCapabilities = { orderCreate: 6, coupons: true }) {
  const fetchImpl = vi.fn<typeof fetch>();
  const discountCodes = createMedusaDiscountCodes({ baseUrl: 'https://store.test', token: () => 't', fetchImpl });
  render(<><TaxProvider {...taxProviderProps(pricing)}><SaleView discountCodes={discountCodes} capabilities={capabilities} />
  </TaxProvider><PortalHost /></>);
  act(() => { sale.add(blue, traits); sale.add(blue, traits); });
  return fetchImpl;
}
const openMenu = () => fireEvent.click(screen.getByTestId('cart-add-menu'));
const couponItem = () => screen.getByRole('menuitem', { name: 'Add Coupon' });
const response = (coupons: unknown[]) => new Response(JSON.stringify({ coupons }), { status: 200 });
function openDialog() {
  openMenu();
  fireEvent.click(couponItem());
  const dialog = within(screen.getByTestId('cart-add-dialog'));
  const input = dialog.getByRole('textbox', { name: 'Coupon code' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'save5' } });
  return { dialog, input };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('cart "+" menu Add Coupon', () => {
  it('lists Add Coupon directly after Add Discount, enabled when the till offers coupons', () => {
    start();
    openMenu();
    const rows = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(rows[rows.indexOf('Add Discount') + 1]).toBe('Add Coupon');
    expect(couponItem().getAttribute('aria-disabled')).not.toBe('true');
  });

  it('applies a code from the dialog through the cart\'s coupon path and closes the dialog', async () => {
    const fetchImpl = start();
    const { dialog } = openDialog();
    expect(dialog.getByText('Add coupon')).toBeTruthy();
    fetchImpl.mockResolvedValueOnce(response([{ code: 'save5', couponId: 'PROMO_1',
      lines: [{ lineId: sale.order.lineItems[0].id, amountMinor: 500 }] }]));
    await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'Apply coupon' })); });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('https://store.test/tally/v1/promotions/preview', expect.objectContaining({ method: 'POST' }));
    expect(screen.queryByTestId('cart-add-dialog')).toBeNull();
    expect(within(screen.getByTestId('coupon-field')).getByTestId('coupon-row-save5')).toBeTruthy();
    expect(sale.order.totalMinor).toBe(2500);
  });

  it('keeps the dialog open with the store refusal and the entered code', async () => {
    const fetchImpl = start();
    const { dialog, input } = openDialog();
    fetchImpl.mockResolvedValueOnce(response([{ code: 'save5', storeCode: 'not_found', message: "That code doesn't exist" }]));
    await act(async () => { fireEvent.click(dialog.getByRole('button', { name: 'Apply coupon' })); });
    expect(screen.getByTestId('cart-add-dialog')).toBeTruthy();
    expect((await dialog.findByRole('alert')).textContent).toBe("That code doesn't exist");
    expect(input.value).toBe('save5');
    expect(screen.queryByTestId('coupon-row-save5')).toBeNull();
  });

  it('greys Add Coupon and opens no dialog when the till does not offer coupons', () => {
    start({ orderCreate: 6 });
    openMenu();
    expect(couponItem().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(couponItem());
    expect(screen.queryByTestId('cart-add-dialog')).toBeNull();
  });
});
