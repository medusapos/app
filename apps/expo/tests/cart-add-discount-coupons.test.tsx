// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatMoney, type ServerCapabilities, type StoreSettings } from '@tallyui/core';
import { medusaConnector } from '@tallyui/connector-medusa';
import { catalogueEntries, TaxProvider, taxProviderProps, useSale } from '@tallyui/pos';
import { PortalHost } from '@tallyui/primitives';
import { CartAddMenu } from '../components/cart-add-menu';
import { CouponField } from '../components/coupon-field';
import { createMedusaDiscountCodes } from '../lib/coupons';
import type { StoreCoupon } from '../lib/store-coupons';

vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('../lib/session-context', () => ({ useSession: vi.fn() }));

const pricing: StoreSettings = { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 } };
const traits = medusaConnector.traits.product;
const [blue] = catalogueEntries([{ id: 'shirt', title: 'Shirt', status: 'published',
  variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12.5, currency_code: 'eur' }] }] }], traits);
const coupons: StoreCoupon[] = [
  { code: 'SAVE10', type: 'percentage', value: 10, currency: null, label: 'Winter', endsAt: null },
  { code: 'FIVE', type: 'fixed', value: 500, currency: 'eur', label: null, endsAt: null },
];
const list = { coupons, truncated: false };
let sale: ReturnType<typeof useSale>;
function start(capabilities: ServerCapabilities = { orderCreate: 6, coupons: true }) {
  const readCoupons = vi.fn<() => Promise<typeof list | null>>().mockResolvedValue(list);
  const fetchImpl = vi.fn<typeof fetch>();
  const discountCodes = createMedusaDiscountCodes({ baseUrl: 'https://store.test', token: () => 't', fetchImpl });
  function SaleView() {
    sale = useSale(pricing, { registerId: 'register-1', cashierRef: 'cashier', capabilities, discountCodes });
    return <><CartAddMenu sale={sale} readCoupons={readCoupons} /><CouponField sale={sale} /></>;
  }
  render(<><TaxProvider {...taxProviderProps(pricing)}><SaleView /></TaxProvider><PortalHost /></>);
  act(() => { sale.add(blue, traits); });
  return { readCoupons, fetchImpl };
}
async function openDiscount() {
  fireEvent.click(screen.getByTestId('cart-add-menu'));
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Add Discount' })); });
  return within(screen.getByTestId('cart-add-discount-sheet'));
}
async function openPicker() {
  const sheet = await openDiscount();
  fireEvent.click(sheet.getByTestId('add-discount-kind-coupon'));
  fireEvent.click(sheet.getByTestId('add-coupon-combobox'));
  return sheet;
}
const response = (coupons: unknown[]) => new Response(JSON.stringify({ coupons }), { status: 200 });
async function submitSave10() {
  const sheet = await openPicker();
  fireEvent.click(await screen.findByTestId('add-coupon-option-SAVE10'));
  await act(async () => { fireEvent.click(sheet.getByTestId('add-coupon-submit')); });
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Add Discount coupon tab', () => {
  it('keeps the amount input without tabs when the store has no list', async () => {
    const { readCoupons } = start();
    readCoupons.mockResolvedValue(null);
    const sheet = await openDiscount();
    expect(readCoupons).toHaveBeenCalledTimes(1);
    expect(sheet.queryByTestId('add-discount-kind-coupon')).toBeNull();
    expect(sheet.getByTestId('discount-amount-input')).toBeTruthy();
  });

  it('does not read or show coupons when the till does not offer them', async () => {
    const { readCoupons } = start({ orderCreate: 5 });
    const sheet = await openDiscount();
    expect(readCoupons).not.toHaveBeenCalled();
    expect(sheet.queryByTestId('add-discount-kind-coupon')).toBeNull();
  });

  it('lists both codes with their amounts and the store label', async () => {
    start();
    await openPicker();
    const percent = within(await screen.findByTestId('add-coupon-option-SAVE10'));
    expect(percent.getByText('SAVE10')).toBeTruthy();
    expect(percent.getByText('10%')).toBeTruthy();
    expect(percent.getByText('Winter')).toBeTruthy();
    const fixed = within(screen.getByTestId('add-coupon-option-FIVE'));
    expect(fixed.getByText('FIVE')).toBeTruthy();
    expect(fixed.getByText(formatMoney({ amount: 500, currency: 'EUR' })!)).toBeTruthy();
  });

  it('applies the selected code to the sale and closes the sheet', async () => {
    const { fetchImpl } = start();
    fetchImpl.mockResolvedValueOnce(response([{ code: 'save10', couponId: 'PROMO_1',
      lines: [{ lineId: sale.order.lineItems[0].id, amountMinor: 125 }] }]));
    await submitSave10();
    expect(sale.order.display.coupons?.map(({ code }) => code)).toEqual(['save10']);
    expect(screen.queryByTestId('cart-add-discount-sheet')).toBeNull();
  });

  it('shows a refusal in the open sheet without applying a coupon', async () => {
    const { fetchImpl } = start();
    fetchImpl.mockResolvedValueOnce(response([{ code: 'save10', storeCode: 'not_found', message: "That code doesn't exist" }]));
    await submitSave10();
    expect(within(screen.getByTestId('cart-add-discount-sheet')).getByRole('alert').textContent).toBe("That code doesn't exist");
    expect(screen.queryByTestId('coupon-row-save10')).toBeNull();
  });

  it('ignores a closed sheet’s result when the next opening has no list', async () => {
    const { readCoupons } = start();
    let resolve!: (result: typeof list) => void;
    readCoupons.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValueOnce(null);
    const first = await openDiscount();
    expect(first.queryByTestId('add-discount-kind-coupon')).toBeNull();
    fireEvent.click(first.getByRole('button', { name: 'Cancel' }));
    const next = await openDiscount();
    await act(async () => { resolve(list); });
    expect(readCoupons).toHaveBeenCalledTimes(2);
    expect(next.queryByTestId('add-discount-kind-coupon')).toBeNull();
    expect(next.getByTestId('discount-amount-input')).toBeTruthy();
  });
});
