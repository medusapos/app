// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatMoney, type StoreSettings as PricingSettings } from '@tallyui/core';
import { medusaConnector } from '@tallyui/connector-medusa';
import { catalogueEntries, TaxProvider, taxProviderProps, useSale } from '@tallyui/pos';
import { Cart } from '@tallyui/components';
import { CouponField, couponDiscountMinor, couponsEnabled } from '../components/coupon-field';
import { createMedusaDiscountCodes } from '../lib/coupons';

vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('../lib/session-context', () => ({ useSession: vi.fn() }));

const pricing: PricingSettings = { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 } };
const traits = medusaConnector.traits.product;
const [blue] = catalogueEntries([{ id: 'shirt', title: 'Shirt', status: 'published',
  variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12.5, currency_code: 'eur' }] }] }], traits);
const money = (amount: number) => formatMoney({ amount, currency: 'EUR' });
let sale: ReturnType<typeof useSale>;
function SaleView({ discountCodes }: { discountCodes: ReturnType<typeof createMedusaDiscountCodes> }) {
  sale = useSale(pricing, { registerId: 'register-1', cashierRef: 'cashier', capabilities: { orderCreate: 6, coupons: true }, discountCodes });
  return <Cart sale={sale} afterSubtotal={<CouponField sale={sale} />} couponDiscountMinor={couponDiscountMinor(sale.order)} />;
}
function start() {
  const fetchImpl = vi.fn<typeof fetch>();
  const discountCodes = createMedusaDiscountCodes({ baseUrl: 'https://store.test', token: () => 't', fetchImpl });
  render(<TaxProvider {...taxProviderProps(pricing)}><SaleView discountCodes={discountCodes} /></TaxProvider>);
  act(() => { sale.add(blue, traits); sale.add(blue, traits); });
  return fetchImpl;
}
const input = () => screen.getByRole('textbox', { name: 'Coupon code' }) as HTMLInputElement;
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const apply = () => fireEvent.click(screen.getByTestId('coupon-apply'));
const response = (coupons: unknown[]) => new Response(JSON.stringify({ coupons }), { status: 200 });
const priced = (amountMinor = 500) => response([{ code: 'save5', couponId: 'PROMO_1',
  lines: [{ lineId: sale.order.lineItems[0].id, amountMinor }] }]);
async function applySave5(fetchImpl: ReturnType<typeof start>) {
  fetchImpl.mockResolvedValueOnce(priced());
  type('save5');
  apply();
  await screen.findByTestId('coupon-row-save5');
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('CouponField', () => {
  it('applies a store-priced code once, displays its amount and keeps the total and Discount row correct', async () => {
    const fetchImpl = start();
    await applySave5(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('https://store.test/tally/v1/promotions/preview', expect.objectContaining({ method: 'POST' }));
    const row = within(screen.getByTestId('coupon-row-save5'));
    expect(row.getByText('Coupon SAVE5')).toBeTruthy();
    expect(row.getByText(`−${money(500)}`)).toBeTruthy();
    expect(input().value).toBe('');
    expect(sale.order.totalMinor).toBe(2500);
    const footer = within(screen.getByTestId('cart-footer'));
    expect(footer.getByText('Total').parentElement!.textContent).toBe(`Total${money(2500)}`);
    const discount = footer.queryByText('Discount');
    expect(discount?.parentElement?.textContent ?? '').not.toContain(money(500));
  });

  it('shows a store refusal, keeps the entered code and clears the message when typing', async () => {
    const fetchImpl = start();
    fetchImpl.mockResolvedValueOnce(response([{ code: 'save5', storeCode: 'not_found', message: "That code doesn't exist" }]));
    type('save5');
    fireEvent.keyDown(input(), { key: 'Enter', code: 'Enter' });
    const field = within(screen.getByTestId('coupon-field'));
    expect((await field.findByRole('alert')).textContent).toBe("That code doesn't exist");
    expect(screen.queryByTestId('coupon-row-save5')).toBeNull();
    expect(input().value).toBe('save5');
    type('save10');
    expect(field.queryByRole('alert')).toBeNull();
  });

  it('removes the applied code and restores the total', async () => {
    const fetchImpl = start();
    await applySave5(fetchImpl);
    fireEvent.click(screen.getByRole('button', { name: 'Remove coupon SAVE5' }));
    expect(screen.queryByTestId('coupon-row-save5')).toBeNull();
    expect(sale.order.totalMinor).toBe(3125);
  });

  it('disables empty or blank Apply and sends no second POST while applying', async () => {
    const fetchImpl = start();
    const button = screen.getByTestId('coupon-apply');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    type('   ');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    apply();
    fireEvent.keyDown(input(), { key: 'Enter', code: 'Enter' });
    expect(fetchImpl).not.toHaveBeenCalled();
    let resolve!: (reply: Response) => void;
    fetchImpl.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    type('save5');
    act(() => { apply(); apply(); fireEvent.keyDown(input(), { key: 'Enter', code: 'Enter' }); });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(priced()); });
    expect(screen.getByTestId('coupon-row-save5')).toBeTruthy();
    type('next');
    expect(button.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('shows repricing progress and retries a failed re-price with fresh store amounts', async () => {
    const fetchImpl = start();
    await applySave5(fetchImpl);
    let reject!: (reason: Error) => void;
    fetchImpl.mockReturnValueOnce(new Promise<Response>((_, fail) => { reject = fail; }));
    act(() => { sale.add(blue, traits); });
    expect(await screen.findByText('Checking coupon prices…')).toBeTruthy();
    expect(screen.queryByTestId('coupon-reprice')).toBeNull();
    await act(async () => { reject(new Error('Offline')); });
    expect(screen.queryByText('Checking coupon prices…')).toBeNull();
    expect(screen.getByTestId('coupon-reprice').textContent).toBe('Check coupons again');
    expect(within(screen.getByTestId('coupon-field')).queryByRole('alert')).toBeNull();
    fetchImpl.mockResolvedValueOnce(priced(750));
    fireEvent.click(screen.getByTestId('coupon-reprice'));
    await waitFor(() => expect(within(screen.getByTestId('coupon-row-save5')).getByText(`−${money(750)}`)).toBeTruthy());
    expect(screen.queryByTestId('coupon-reprice')).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('enables coupons only with coupons and order.create v6 or above', () => {
    expect(couponsEnabled({ coupons: true, orderCreate: 6 })).toBe(true);
    expect(couponsEnabled(undefined)).toBe(false);
    expect(couponsEnabled({ orderCreate: 6 })).toBe(false);
    expect(couponsEnabled({ coupons: true, orderCreate: 5 })).toBe(false);
  });

  it('sums displayed coupon amounts and returns zero without coupons', () => {
    start();
    expect(couponDiscountMinor(sale.order)).toBe(0);
    expect(couponDiscountMinor({ ...sale.order, display: { ...sale.order.display,
      coupons: [{ code: 'save5', amountMinor: 500 }, { code: 'save2', amountMinor: 200 }] } })).toBe(700);
  });
});
