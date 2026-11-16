// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createExtensionHost, ExtensionHostProvider, ExtensionTarget, useSaleSource, type ExtensionHost } from '@tallyui/extensions';
import { TaxProvider, taxProviderProps, useSale } from '@tallyui/pos';
import { OPEN_TO_PAY } from '../components/register';
import { tillExtension, TILL_GRANT } from '../extensions/till';

vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }], getLocales: () => [{ languageTag: 'en-GB' }] }));
const pricing = { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 } };
function SaleView({ host }: { host: ExtensionHost }) {
  const sale = useSale(pricing, { registerId: 'register-1', cashierRef: 'cashier', capabilities: { orderCreate: 6, coupons: true } });
  const source = useSaleSource(sale);
  return <ExtensionHostProvider host={host}><ExtensionTarget id="pos.cart.after-subtotal" sale={source} /></ExtensionHostProvider>;
}
afterEach(cleanup);

it('accepts the till extension', () => {
  const host = createExtensionHost({ extensions: [tillExtension], grant: TILL_GRANT });
  expect(host.accepted).toEqual(['medusapos.till']);
  expect(host.refused).toEqual([]);
});

it('refuses tender when the register is closed', async () => {
  const host = createExtensionHost({ extensions: [tillExtension], grant: TILL_GRANT });
  await expect(host.dispatch('checkout.tender.start', { method: 'cash' }, {
    register: { value: { open: false }, subscribe: () => () => {} },
  })).resolves.toBe(OPEN_TO_PAY);
});

it('allows tender when the register is open', async () => {
  const host = createExtensionHost({ extensions: [tillExtension], grant: TILL_GRANT });
  await expect(host.dispatch('checkout.tender.start', { method: 'cash' }, {
    register: { value: { open: true }, subscribe: () => () => {} },
  })).resolves.toBeNull();
});

it('renders the coupon field through the host', async () => {
  const host = createExtensionHost({ extensions: [tillExtension], grant: TILL_GRANT });
  render(<TaxProvider {...taxProviderProps(pricing)}><SaleView host={host} /></TaxProvider>);
  expect(await screen.findByTestId('coupon-field')).toBeTruthy();
});

it('omits the coupon field without the coupon actions grant', async () => {
  const host = createExtensionHost({ extensions: [tillExtension], grant: { 'medusapos.till': ['sale.read'] } });
  render(<TaxProvider {...taxProviderProps(pricing)}><SaleView host={host} /></TaxProvider>);
  await act(async () => { await waitFor(() => new Promise((resolve) => setTimeout(resolve, 0))); });
  expect(screen.queryByTestId('coupon-field')).toBeNull();
});
