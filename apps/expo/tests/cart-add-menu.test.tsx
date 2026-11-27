// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { cartLine } from './tender-pane';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProductsScreen from '../app/index';
import { openOrderStore } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { useSession } from '../lib/session-context';
import { sessionFixture } from './session-fixture';
import { fetchStoreSettings } from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { capabilities, storeSettings } from './pos-connector-mock';
import { openRegisterFixture } from './register-fixture';
import { setWindowWidth } from './window-width';

const { createCustomer, connectorOptions } = vi.hoisted(() => ({ createCustomer: vi.fn(), connectorOptions: { createCustomer: true } }));
vi.mock('../lib/pos-connector', async (original) => {
  const mocked = await (await import('./pos-connector-mock')).mockPosConnector(original);
  return { ...mocked, createPosConnector: () => {
    const { createCustomer: _real, ...connector } = mocked.createPosConnector();
    return connectorOptions.createCustomer ? { ...connector, createCustomer } : connector;
  } };
});
vi.mock('expo-router', () => ({ usePathname: () => '/', Redirect: () => null, Stack: { Screen: () => null } }));
vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));
vi.mock('../lib/session-context', () => ({ useSession: vi.fn() }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('../lib/use-replicated-products', () => ({ useReplicatedProducts: vi.fn() }));
vi.mock('../lib/register-context', async (original) => ({
  ...await original<typeof import('../lib/register-context')>(), useRegister: vi.fn(),
}));
vi.mock('../lib/store-settings', async (original) => ({
  ...await original<typeof import('../lib/store-settings')>(), fetchStoreSettings: vi.fn(),
}));

let store: Awaited<ReturnType<typeof openOrderStore>>;
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
beforeEach(async () => {
  setWindowWidth(1280);
  connectorOptions.createCustomer = true;
  createCustomer.mockReset().mockResolvedValue({ id: 'nia', name: 'Nia', firstName: 'Nia', email: 'new@example.com' });
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  const session = { baseUrl: `https://cart-add-${crypto.randomUUID()}.test`, email: 'admin@store.test', token: 'jwt',
    capabilities: { orderCreate: 5, taxRounding: { granularity: 'per_order' as const, mode: 'half_away_from_zero' as const },
      lineTax: { none: false, classes: false } } };
  vi.mocked(useSession).mockReturnValue(sessionFixture(session));
  capabilities.mockResolvedValue(session.capabilities);
  storeSettings.mockResolvedValue({ currency: 'EUR', pricesIncludeTax: true, taxRatesPpm: { default: 250000 },
    pricingContext: { region_id: 'reg_eu', currency_code: 'eur', publishable_key: 'pk_1' } });
  vi.mocked(fetchStoreSettings).mockResolvedValue({ storeName: 'Test shop', currency: 'EUR',
    location: { id: 'loc', name: 'Main', countryCode: 'dk' } });
  vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
  vi.mocked(useReplicatedProducts).mockReturnValue({ products: [{ id: 'shirt', title: 'Shirt', status: 'published',
    variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 19.2, currency_code: 'eur' }] }] }],
    state: 'synced', error: null, lastSyncedAt: null, stockOverlay: undefined, lastStockCheckAt: null,
    reconcileStock: vi.fn(async () => {}), pullNotice: undefined, resumePull: vi.fn(), syncNow: vi.fn(), clearAndRefresh: vi.fn(), unlisted: undefined });
  store = await openOrderStore(session.baseUrl);
  vi.mocked(useOutboxContext).mockReturnValue({ orders: store.orders, record: vi.fn(async () => {}), state: { pending: 0, sending: false },
    recent: [], savesInFlight: 0, stuckCommandIds: [], flush: vi.fn(), requeue: vi.fn(), discard: vi.fn(), cancelOnStore: vi.fn(), payRestOnStore: vi.fn(), reverseOnStore: vi.fn(), isStored: vi.fn(async () => true) });
});
afterEach(async () => {
  cleanup();
  await store.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function start() {
  await act(async () => { render(<><ProductsScreen /><PortalHost /></>); });
  await screen.findByTestId('product-tile-Shirt');
}
function openMenu(name?: string) {
  fireEvent.click(screen.getByTestId('cart-add-menu'));
  if (name) fireEvent.click(screen.getByRole('menuitem', { name }));
}
const SIX_ROWS = ['Add new customer', 'Add Miscellaneous Product', 'Add Fee', 'Add Discount', 'Add Coupon', 'Add Shipping'];
it('lists the six actions in order and hides the inline controls', async () => {
  await start();
  fireEvent.click(screen.getByTestId('product-tile-Shirt'));
  expect(screen.queryByRole('button', { name: /^(Add charge|Order discount)$/ })).toBeNull();
  const trigger = screen.getByRole('button', { name: 'Add to cart' });
  expect(trigger.textContent).toBe('');
  expect(trigger.querySelector('svg')).toBeTruthy();
  openMenu();
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(SIX_ROWS);
});
it('lists all six rows on an empty cart, Add Discount enabled', async () => {
  await start();
  openMenu();
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(SIX_ROWS);
  expect(screen.getByRole('menuitem', { name: 'Add Discount' }).getAttribute('aria-disabled')).not.toBe('true');
});
it('each + menu row leads with its own icon', async () => {
  await start();
  openMenu();
  const rows = screen.getAllByRole('menuitem');
  expect(rows.map((item) => item.textContent)).toEqual(SIX_ROWS);
  const icons = rows.map((row) => {
    const svgs = row.querySelectorAll('svg');
    expect(svgs).toHaveLength(1);
    expect(svgs[0].getAttribute('aria-hidden')).toBe('true');
    const first = row.firstElementChild!;
    expect(first === svgs[0] || first.contains(svgs[0])).toBe(true);
    expect(first.textContent).toBe('');
    return svgs[0].innerHTML;
  });
  expect(new Set(icons).size).toBe(SIX_ROWS.length);
});
it('a greyed row keeps its icon', async () => {
  connectorOptions.createCustomer = false;
  await start();
  openMenu();
  const item = screen.getByRole('menuitem', { name: 'Add new customer' });
  expect(item.getAttribute('aria-disabled')).toBe('true');
  expect(item.querySelector('svg')).toBeTruthy();
});
it('marks the trigger open only while its menu is open', async () => {
  await start();
  const trigger = screen.getByTestId('cart-add-menu');
  expect(trigger.getAttribute('data-open')).toBe('false');
  openMenu();
  expect(trigger.getAttribute('data-open')).toBe('true');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add Fee' }));
  expect(screen.getByTestId('cart-add-menu').getAttribute('data-open')).toBe('false');
});
it('Add new customer creates the customer and makes it the sale\'s customer', async () => {
  await start();
  openMenu('Add new customer');
  const dialog = screen.getByTestId('new-customer-dialog');
  expect(within(dialog).getByRole('heading', { name: 'Add Customer' })).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText('email@example.com'), { target: { value: 'new@example.com' } });
  fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Nia' } });
  await act(async () => { fireEvent.click(screen.getByTestId('customer-save')); });
  expect(createCustomer).toHaveBeenCalledExactlyOnceWith(expect.anything(), { email: 'new@example.com', firstName: 'Nia' });
  expect(screen.getByTestId('customer-chip').getAttribute('aria-label')).toBe('Customer: Nia');
  expect(screen.queryByTestId('new-customer-dialog')).toBeNull();
  expect(screen.getByTestId('customer-saved-toast').textContent).toBe('Nia saved');
});
it('the "Nia saved" message hides when a tender starts', async () => {
  await start();
  fireEvent.click(screen.getByTestId('product-tile-Shirt'));
  openMenu('Add new customer');
  fireEvent.change(screen.getByPlaceholderText('email@example.com'), { target: { value: 'new@example.com' } });
  fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'Nia' } });
  await act(async () => { fireEvent.click(screen.getByTestId('customer-save')); });
  expect(screen.getByTestId('customer-saved-toast').textContent).toBe('Nia saved');
  await act(async () => { fireEvent.click(screen.getByTestId('cart-checkout')); });
  expect(screen.getByTestId('tender-slot')).toBeTruthy();
  expect(screen.queryByTestId('customer-saved-toast')).toBeNull();
});
it('greys Add new customer when the connector cannot create customers', async () => {
  connectorOptions.createCustomer = false;
  await start();
  openMenu();
  const item = screen.getByRole('menuitem', { name: 'Add new customer' });
  expect(item.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(item);
  expect(screen.queryByTestId('new-customer-dialog')).toBeNull();
});
it.each([
  ['Add Fee', 'Add fee', 'Gift wrap'],
  ['Add Miscellaneous Product', 'Add custom item', 'Engraving'],
])('%s applies and closes the dialog', async (item, title, name) => {
  await start();
  openMenu(item);
  const form = within(screen.getByTestId('cart-add-dialog')).getByTestId('charge-form');
  expect(form.getAttribute('aria-label')).toBe(title);
  fireEvent.change(within(form).getByLabelText('Name'), { target: { value: name } });
  fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '2.00' } });
  click('Add to Cart');
  expect((item === 'Add Fee' ? screen.getByTestId('cart-fee-0') : cartLine(name)).textContent).toContain(name);
  expect(screen.queryByTestId('cart-add-dialog')).toBeNull();
});
const discountSheet = () => screen.queryByTestId('cart-add-discount-sheet');
function addDiscount(type: 'Percent' | 'Amount', value: string) {
  const sheet = within(discountSheet()!);
  fireEvent.click(sheet.getByRole('button', { name: type }));
  fireEvent.change(sheet.getByLabelText('Discount value'), { target: { value } });
  fireEvent.click(sheet.getByRole('button', { name: 'Add discount' }));
}
it('Add Discount opens v2\'s left sheet: its title and ✕, the value field then the switch, Cancel and Add discount', async () => {
  await start();
  fireEvent.click(screen.getByTestId('product-tile-Shirt'));
  openMenu('Add Discount');
  expect(screen.queryByTestId('cart-add-dialog')).toBeNull();
  // A side sheet slides in on translateX; TallyUI's centred dialog fades and scales instead.
  expect(discountSheet()!.getAttribute('style')).toMatch(/translateX/);
  const sheet = within(discountSheet()!);
  expect(sheet.getByRole('heading', { name: 'Add Discount' })).toBeTruthy();
  expect(sheet.getByRole('group', { name: 'Add Discount' })).toBeTruthy();
  const field = sheet.getByLabelText('Discount value');
  expect(field.compareDocumentPosition(sheet.getByTestId('discount-percent-switch')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(sheet.getAllByRole('button').map((button) => button.textContent || button.getAttribute('aria-label')))
    .toEqual(['Percent', 'Amount', 'Cancel', 'Add discount', 'Close']);
  // No Coupon tab: the store serves no coupon list yet.
  expect(sheet.queryByText('Coupon')).toBeNull();
  fireEvent.click(sheet.getByRole('button', { name: 'Close' }));
  expect(discountSheet()).toBeNull();
});
it('applies a 10% order discount and closes the sheet', async () => {
  await start();
  fireEvent.click(screen.getByTestId('product-tile-Shirt'));
  openMenu('Add Discount');
  addDiscount('Percent', '10');
  // v2's "Discount (10%) ✕" row in the totals, not a chip under the lines.
  expect(screen.getByTestId('order-discount-row-0').textContent).toMatch(/^Discount \(10%\)−/);
  expect(screen.queryByRole('button', { name: /^Remove discount Order discount/ })).toBeNull();
  expect(discountSheet()).toBeNull();
});
// The sheet's layout="dialog" opens on Amount (v2's $-first sheet); the old inline form opened on Percent. A typed "5" is €5.
it('the sheet opens on Amount: 5 with no switch press is a −€5.00 order discount', async () => {
  await start();
  fireEvent.click(screen.getByTestId('product-tile-Shirt'));
  expect(screen.getByTestId('cart-checkout').textContent).toBe('Checkout €19.20');
  openMenu('Add Discount');
  const sheet = within(discountSheet()!);
  expect(sheet.getByRole('button', { name: 'Amount' }).getAttribute('aria-selected')).toBe('true');
  expect(sheet.getByRole('button', { name: 'Percent' }).getAttribute('aria-selected')).not.toBe('true');
  fireEvent.change(sheet.getByLabelText('Discount value'), { target: { value: '5' } });
  fireEvent.click(sheet.getByRole('button', { name: 'Add discount' }));
  expect(screen.getByTestId('order-discount-row-0').textContent).toBe('Discount−€5.00');
  expect(screen.getByTestId('cart-checkout').textContent).toBe('Checkout €14.20');
});
it('keeps the sheet open with the refusal inline for an amount above the order, and Cancel applies nothing', async () => {
  await start();
  fireEvent.click(screen.getByTestId('product-tile-Shirt'));
  openMenu('Add Discount');
  addDiscount('Amount', '50');
  expect(within(discountSheet()!).getByRole('alert').textContent).toBe('The discount is more than the order');
  fireEvent.click(within(discountSheet()!).getByRole('button', { name: 'Cancel' }));
  expect(discountSheet()).toBeNull();
  expect(screen.queryByTestId('order-discount-row-0')).toBeNull();
  expect(screen.getByTestId('cart-checkout').textContent).toBe('Checkout €19.20');
});
it('below order.create 5 offers only Add new customer and a discount, on an empty cart too', async () => {
  const context = vi.mocked(useSession).getMockImplementation()!();
  const session = { ...context.session!, capabilities: { ...context.session!.capabilities, orderCreate: 4 } };
  vi.mocked(useSession).mockReturnValue({ ...context, session });
  capabilities.mockResolvedValue(session.capabilities);
  await start();
  openMenu();
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Add new customer', 'Add Discount', 'Add Coupon']);
});
it('greys Add Coupon when the till does not offer coupons', async () => {
  await start();
  openMenu();
  expect(screen.getByRole('menuitem', { name: 'Add Coupon' }).getAttribute('aria-disabled')).toBe('true');
});
it('a press outside the menu closes it; the overlay sits under the menu, out of the tab order', async () => {
  await start();
  openMenu();
  const overlay = screen.getByTestId('cart-add-menu-overlay');
  expect(overlay.compareDocumentPosition(screen.getByRole('menu')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(overlay.getAttribute('aria-hidden')).toBe('true');
  expect(overlay.getAttribute('tabindex')).toBe('-1');
  fireEvent.click(overlay);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.queryByTestId('cart-add-menu-overlay')).toBeNull();
  expect(screen.getByTestId('cart-add-menu').getAttribute('data-open')).toBe('false');
  expect(screen.queryByTestId('cart-add-dialog')).toBeNull();
});
