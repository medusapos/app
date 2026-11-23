import { expect, type Page } from '@playwright/test';
import { addE2E1, adminToken, backend, cartTab, createAdminCustomer, discount, openArea, openRegisterPanel, productsTab, sellBySku, signIn } from '../helpers';

export type Size = 'desktop' | 'tablet' | 'phone';
export type CaptureRow = {
  id: string;
  title: string;
  state: string;
  skip?: string;
  only?: Size[];
  reach: (page: Page, size: Size) => Promise<void>;
};

const phone = (size: Size) => size === 'phone';
const search = (page: Page) => page.getByPlaceholder('Search or scan barcode / SKU', { exact: true });
const tiles = (page: Page) => page.getByTestId(/^product-tile-/);
const headerState = (page: Page) => page.getByTestId('header-register-state');
const nothing = async () => {};

// Adds each SKU as a scan in the search box does.
export async function add(page: Page, ...skus: string[]) {
  for (const sku of skus) {
    await search(page).fill(sku);
    await search(page).press('Enter');
    await expect(search(page)).toHaveValue('');
  }
}

// A phone shows the cart in its own tab.
export async function cart(page: Page, size: Size) {
  if (phone(size)) await cartTab(page).click();
}

// A whole sale for exact cash, from the Products view; ends on a new sale.
async function sell(page: Page, size: Size, ...skus: string[]) {
  await add(page, ...skus);
  await cart(page, size);
  await sellBySku(page, [], 'exact');
  if (phone(size)) await productsTab(page).click();
}

// Signs out from the user sheet, past "Sign out anyway" while the register is open; ends on the Sign in screen.
async function signOut(page: Page) {
  await page.getByTestId('user-menu').click();
  await page.getByTestId('user-sheet-sign-out').click();
  const confirm = page.getByTestId('switch-confirm-confirm');
  await expect(confirm.or(page.getByLabel('Email', { exact: true }))).toBeVisible();
  if (await confirm.isVisible()) await confirm.click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
}

async function keypad(page: Page, amount: string) {
  const keys = page.getByTestId('tender-keypad');
  await keys.getByRole('button', { name: 'Clear', exact: true }).click();
  for (const digit of amount.replace(/\D/g, '')) await keys.getByRole('button', { name: digit, exact: true }).click();
}

// The count is blind (no expected figure on the count screen), so the cash in the drawer is read off the user sheet
// first; its register row opens the panel, whose Close register opens the count.
async function startClose(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 600) await page.getByTestId('user-menu').click();
  else await page.getByRole('button', { name: 'Open register panel', exact: true }).click();
  const drawer = await page.getByTestId('user-sheet-drawer').textContent();
  const cash = drawer?.match(/([\d.,]+)\D*$/)?.[1];
  if (!cash) throw new Error(`no cash in the drawer on the user sheet: ${drawer}`);
  await page.getByTestId('user-sheet-register').click();
  await page.getByTestId('register-panel').getByTestId('register-panel-close').click();
  return cash.replace(/,/g, '');
}

// Counts exactly the drawer's cash and closes (a count already open goes back to selling first); `done` leaves the closure.
export async function finishClose(page: Page, done = true) {
  const count = page.getByTestId('register-count');
  if (await count.isVisible()) {
    await page.getByRole('button', { name: 'Back to selling', exact: true }).click();
    await expect(count).toHaveCount(0);
  }
  const cash = await startClose(page);
  await expect(count).toBeVisible();
  await count.getByTestId('count-amount').fill(cash);
  await count.getByTestId('count-close').click();
  await expect(page.getByTestId('closure-sheet')).toBeVisible();
  if (done) {
    await page.getByTestId('closure-done').click();
    await expect(page.getByTestId('closure-sheet')).toHaveCount(0);
  }
}

const closeRegister = finishClose;

async function settings(page: Page, size: Size, id: string) {
  await openArea(page, 'Settings');
  if (phone(size)) {
    await page.getByTestId(`settings-list-${id}`).click();
    await expect(page.getByTestId('settings-back')).toBeVisible();
  } else {
    await page.getByTestId(`settings-nav-${id}`).click();
    await expect(page.getByTestId('settings-section-title')).toBeVisible();
  }
}

async function customer(email: string) {
  await createAdminCustomer(await adminToken(), email, 'Ada', 'Lovelace');
}

const skip = (id: string, title: string, reason: string): CaptureRow => ({ id, title, state: '—', skip: reason, reach: nothing });

export const rows: CaptureRow[] = [
  { id: '01', title: 'POS main, empty cart', state: 'Empty Sale', reach: async (page) => {
    await expect(tiles(page).first()).toBeVisible();
  } },
  // The e2e catalogue has no shirt; "product 4" filters the grid to one tile.
  { id: '02a', title: 'Product tiles, search', state: 'Search box holding "product 4", grid filtered', reach: async (page) => {
    await search(page).fill('product 4');
    await expect(tiles(page)).toHaveCount(1);
  } },
  { id: '02b', title: 'Product table', state: 'Table view (a phone has no table view)', only: ['desktop', 'tablet'], reach: async (page) => {
    await page.getByTestId('view-toggle-table').click();
    await expect(page.getByTestId('product-table-sort-name')).toBeVisible();
  } },
  { id: '02c', title: 'Variable product', state: 'Variant chooser open on E2E product 4', reach: async (page) => {
    await page.getByText('E2E product 4', { exact: true }).click();
    await expect(page.getByRole('button', { name: /E2E-4B/ })).toBeVisible();
  } },
  { id: '02d', title: 'Product display settings', state: 'Product display settings open', reach: async (page) => {
    await page.getByTestId('product-settings-button').click();
    await expect(page.getByTestId('product-settings-sheet')).toBeVisible();
  } },
  { id: '02e', title: 'Category filter', state: 'Drinks chip selected', reach: async (page) => {
    await page.getByRole('radiogroup', { name: 'Categories' }).getByRole('radio', { name: 'Drinks', exact: true }).click();
    await expect(tiles(page)).toHaveCount(2);
  } },
  { id: '02f', title: 'Barcode scan on the sale', state: 'Scan toast after a wedge scan of E2E-2', reach: async (page) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.type('E2E-2', { delay: 10 });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('scan-toast')).toContainText('Added to cart');
  } },
  { id: '03a', title: 'Cart with items', state: 'Three lines in the cart', reach: async (page, size) => {
    await add(page, 'E2E-1', 'E2E-2', 'E2E-3');
    await cart(page, size);
  } },
  { id: '03b', title: 'Line qty / price edit', state: 'Quantity keypad open on a line', reach: async (page, size) => {
    await addE2E1(page);
    await cart(page, size);
    await page.getByTestId('quantity-popover-trigger').first().click();
    await expect(page.getByTestId('quantity-popover')).toBeVisible();
  } },
  { id: '03c', title: 'Line discount', state: 'Price keypad with quick-discount keys (a phone: the quantity popover, it has no price column)', reach: async (page, size) => {
    await addE2E1(page);
    await cart(page, size);
    const price = page.getByTestId('price-popover-trigger').first();
    await (await price.isVisible() ? price : page.getByTestId('quantity-popover-trigger').first()).click();
    await expect(page.getByTestId('price-popover-action-discount').first().or(page.getByTestId('quantity-popover'))).toBeVisible();
  } },
  { id: '04a', title: 'Customer picker', state: 'Customer picker searching for Ada Lovelace', reach: async (page, size) => {
    const email = `ada-${crypto.randomUUID()}@example.com`;
    await customer(email);
    await cart(page, size);
    await page.getByRole('button', { name: 'Customer: Guest', exact: true }).click();
    await page.getByTestId('customer-picker-search').fill(email);
    await expect(page.getByLabel(`Ada Lovelace, ${email}`, { exact: true })).toBeVisible();
  } },
  { id: '04b', title: 'New customer', state: 'New-customer form', reach: async (page, size) => {
    await cart(page, size);
    await page.getByRole('button', { name: 'Customer: Guest', exact: true }).click();
    await page.getByRole('button', { name: 'New customer', exact: true }).click();
    await expect(page.getByPlaceholder('First name')).toBeVisible();
  } },
  { id: '04c', title: 'Order note', state: '⋮ Order details sheet with its Form | JSON tabs (#511)', reach: async (page, size) => {
    await addE2E1(page);
    await cart(page, size);
    await page.getByTestId('cart-foot-more').click();
    await page.getByTestId('cart-foot-menu').getByRole('menuitem', { name: 'Order details', exact: true }).click();
    await expect(page.getByTestId('cart-order-tab-json')).toBeVisible();
    await page.getByTestId('cart-note-field').fill('Gift wrap, please');
  } },
  { id: '05a', title: 'Cart add menu', state: 'Cart "+" menu open', reach: async (page, size) => {
    await addE2E1(page);
    await cart(page, size);
    await page.getByTestId('cart-add-menu').click();
    await expect(page.getByRole('menuitem', { name: 'Add Fee', exact: true })).toBeVisible();
  } },
  { id: '05b', title: 'Fee / shipping line', state: 'A fee and a shipping line added', reach: async (page, size) => {
    await addE2E1(page);
    await cart(page, size);
    for (const [kind, name, amount] of [['Add Fee', 'Gift wrap', '2.00'], ['Add Shipping', 'Local delivery', '4.95']]) {
      await page.getByTestId('cart-add-menu').click();
      await page.getByRole('menuitem', { name: kind, exact: true }).click();
      const form = page.getByTestId('charge-form');
      await form.getByLabel('Name', { exact: true }).fill(name);
      await form.getByLabel('Amount', { exact: true }).fill(amount);
      await form.getByRole('button', { name: 'Add to Cart', exact: true }).click();
      await expect(form).toHaveCount(0);
    }
  } },
  { id: '05c', title: 'Order discount', state: 'A 10% order discount applied', reach: async (page, size) => {
    await add(page, 'E2E-1', 'E2E-2');
    await cart(page, size);
    await discount(page, 'order', 'Percent', '10');
  } },
  { id: '05d', title: 'Cart settings', state: 'Cart settings open', reach: async (page, size) => {
    await cart(page, size);
    await page.getByTestId('cart-settings-button').click();
    await expect(page.getByTestId('cart-settings-sheet')).toBeVisible();
  } },
  { id: '06a', title: 'Tender, cash', state: 'Cash tender open', reach: async (page, size) => {
    await addE2E1(page);
    await cart(page, size);
    await page.getByTestId('cart-checkout').click();
    await expect(page.getByTestId('tender-pane')).toBeVisible();
  } },
  { id: '06b', title: 'Change due', state: 'Tender after €10.00 cash for €2.50, change due', reach: async (page, size) => {
    await addE2E1(page);
    await cart(page, size);
    await page.getByTestId('cart-checkout').click();
    await keypad(page, '10.00');
    await page.getByTestId('tender-take').click();
    await expect(page.getByTestId('tender-change')).toBeVisible();
  } },
  { id: '06c', title: 'Split payment', state: '€2.00 card terminal, then €5.00 cash: a second payment in the tender', reach: async (page, size) => {
    await add(page, 'E2E-1', 'E2E-1');
    await cart(page, size);
    await page.getByTestId('cart-checkout').click();
    await page.getByTestId('tender-method-external').click();
    await keypad(page, '2.00');
    await page.getByTestId('tender-take').click();
    await expect(page.getByTestId('tender-headline')).toHaveText(/^Remaining/);
    await page.getByTestId('tender-method-cash').click();
    await keypad(page, '5.00');
    await page.getByTestId('tender-take').click();
    await expect(page.getByTestId('tender-change')).toBeVisible();
  } },
  { id: '07', title: 'Paid / receipt', state: 'Paid screen after a cash sale, with the Template and Printer pickers (#512)', reach: async (page, size) => {
    await addE2E1(page);
    await cart(page, size);
    await page.getByTestId('cart-checkout').click();
    await page.getByTestId('tender-quick-exact').click();
    await page.getByTestId('tender-take').click();
    await page.getByTestId('tender-complete').click();
    await expect(page.getByTestId('receipt-template-select')).toBeVisible();
    await expect(page.getByTestId('receipt-printer-select')).toBeVisible();
  } },
  { id: '07e', title: 'Email receipt (paid screen)', state: 'Email receipt open on the paid screen', reach: async (page, size) => {
    await addE2E1(page);
    await cart(page, size);
    await page.getByTestId('cart-checkout').click();
    await page.getByTestId('tender-quick-exact').click();
    await page.getByTestId('tender-take').click();
    await page.getByTestId('tender-complete').click();
    await page.getByTestId('receipt-email-open').click();
    await expect(page.getByTestId('receipt-email-dialog')).toBeVisible();
  } },
  { id: '07f', title: 'Paid, offline (awaiting store)', state: 'Paid while offline: Awaiting store', reach: async (page, size) => {
    await page.context().setOffline(true);
    await add(page, 'E2E-2');
    await cart(page, size);
    await page.getByTestId('cart-checkout').click();
    await page.getByTestId('tender-quick-exact').click();
    await page.getByTestId('tender-take').click();
    await page.getByTestId('tender-complete').click();
    await expect(page.getByTestId('paid-awaiting-status')).toHaveText('Awaiting store · Cash');
  } },
  { id: '08', title: 'Open orders / parked', state: 'Two open sales as tabs, a third in the cart', reach: async (page, size) => {
    // Every sale holding items has a tab, the one in the cart too.
    const tabs = page.getByTestId(/^open-sale-tab-.*-who$/);
    const empty = page.getByTestId('cart-empty');
    const again = page.getByText(/park it again/);
    for (const [parked, sku] of ['E2E-1', 'E2E-2'].entries()) {
      await add(page, sku);
      await cart(page, size);
      await expect(tabs).toHaveCount(parked + 1);
      // A park that lands while the line still saves is refused ("park it again"); it is parked again then.
      await page.getByTestId('new-sale-tab').click();
      await expect(empty.or(again).first()).toBeVisible();
      if (await again.isVisible()) await page.getByTestId('new-sale-tab').click();
      await expect(empty).toBeVisible();
      if (phone(size)) await productsTab(page).click();
    }
    await add(page, 'E2E-3');
    await cart(page, size);
    await expect(tabs).toHaveCount(3);
  } },
  // Switch register is locked while a session exists, even a closed one; Clear all local data unbinds the till.
  { id: '09a', title: 'Choose register', state: 'Register picker on a till with no register bound', reach: async (page, size) => {
    await openArea(page, 'Settings');
    await page.getByTestId(phone(size) ? 'settings-list-danger' : 'settings-nav-danger').click();
    await page.getByTestId('clear-local-data').click();
    await page.getByTestId('clear-local-data-word').fill('CLEAR');
    await page.getByTestId('clear-local-data-confirm').click();
    await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
    await signIn(page, 'Europe', false);
    await expect(headerState(page)).toHaveText('Choose register');
    if (phone(size)) await headerState(page).click();
    await expect(page.getByTestId('register-picker')).toBeVisible();
  } },
  { id: '09b', title: 'Open register / float', state: 'Open-register float form after a close', reach: async (page, size) => {
    await closeRegister(page);
    if (phone(size)) await headerState(page).click();
    await expect(page.getByTestId('open-register-amount')).toBeVisible();
  } },
  { id: '09c', title: 'Register panel / cashier sheet', state: 'Session open: the header register entry opens the one sheet (#513)', reach: async (page, size) => {
    if (phone(size)) await page.getByTestId('user-menu').click();
    else await page.getByRole('button', { name: 'Open register panel', exact: true }).click();
    await expect(page.getByTestId('user-sheet-register')).toBeVisible();
  } },
  { id: '09d', title: 'Pay in / out', state: 'Pay in open', reach: async (page) => {
    await openRegisterPanel(page);
    await page.getByTestId('register-panel').getByTestId('register-panel-paid-in').click();
    await page.getByTestId('movement-sheet').getByTestId('movement-amount').fill('5.00');
    await page.getByTestId('movement-sheet').getByTestId('movement-reason').fill('Change for the float');
  } },
  { id: '09e', title: 'Count / close', state: 'Count screen', reach: async (page) => {
    await openRegisterPanel(page);
    await page.getByTestId('register-panel').getByTestId('register-panel-close').click();
    await expect(page.getByTestId('register-count')).toBeVisible();
  } },
  { id: '09f', title: 'Closure (Z)', state: 'Closure sheet after closing', reach: async (page) => {
    await closeRegister(page, false);
  } },
  { id: '10', title: 'Orders', state: 'Orders after two sales', reach: async (page, size) => {
    await sell(page, size, 'E2E-2');
    await sell(page, size, 'E2E-3');
    await openArea(page, 'Orders');
    await expect(page.getByRole('button', { name: /^Open order / }).nth(1)).toBeVisible();
  } },
  { id: '11', title: 'Customers', state: 'Customers searched to Ada Lovelace', reach: async (page) => {
    const email = `ada-${crypto.randomUUID()}@example.com`;
    await customer(email);
    await openArea(page, 'Customers');
    await page.getByTestId('customers-search').fill(email);
    await expect(page.getByLabel(`Ada Lovelace, ${email}`, { exact: true })).toBeVisible();
  } },
  { id: '12', title: 'Products', state: 'Products area', reach: async (page) => {
    await openArea(page, 'Products');
    await expect(page.getByTestId('products-footer')).toBeVisible();
  } },
  { id: '13', title: 'Reports', state: 'Reports after a sale', reach: async (page, size) => {
    await sell(page, size, 'E2E-2');
    await openArea(page, 'Reports');
    await expect(page.getByTestId('sales-filters')).toBeVisible();
  } },
  { id: '13b', title: 'Closure history', state: 'Closures view after a close', reach: async (page) => {
    await closeRegister(page);
    await openArea(page, 'Reports');
    await page.getByTestId('register-strip-open-closures').click();
    await expect(page.getByTestId('closures-view')).toBeVisible();
  } },
  { id: '14a', title: 'Navigation (rail / header)', state: 'The Sale shell (a phone: its header)', reach: async (page) => {
    await expect(page.getByTestId('user-menu')).toBeVisible();
  } },
  { id: '14b', title: 'User menu', state: 'User sheet open', reach: async (page) => {
    await page.getByTestId('user-menu').click();
    await expect(page.getByTestId('user-sheet')).toBeVisible();
  } },
  skip('14c', 'Notifications', 'N/A: WCPOS notification service; Medusa has no cashier inbox'),
  { id: '14d', title: 'Online / sync status', state: 'Offline header state', reach: async (page) => {
    await page.context().setOffline(true);
    await expect(headerState(page)).toHaveText('Offline');
  } },
  skip('14e', 'Store health', 'N/A: WordPress/WooCommerce plugin health'),
  skip('14f', 'Support', 'N/A: WCPOS product support chat'),
  { id: '15a', title: 'Settings, general', state: 'Settings › General', reach: (page, size) => settings(page, size, 'store') },
  skip('15b', 'Settings, tax', 'N/A: Medusa sets tax per region in Medusa Admin'),
  { id: '15c', title: 'Settings, printing', state: 'Settings › Printing', reach: (page, size) => settings(page, size, 'printing') },
  { id: '15d', title: 'Settings, card readers', state: 'Settings › Card readers', reach: (page, size) => settings(page, size, 'card-readers') },
  skip('15e', 'Settings, customer display', 'gap, no section: no customer-facing display'),
  { id: '15f', title: 'Settings, barcode scanning', state: 'Settings › Barcode Scanning', reach: (page, size) => settings(page, size, 'scanner') },
  { id: '15g', title: 'Settings, theme', state: 'Settings › Theme', reach: (page, size) => settings(page, size, 'theme') },
  { id: '16', title: 'Sign-in / connect', state: 'Sign-in screen after Sign out', reach: signOut },
  { id: '17a', title: 'Phone, POS', state: 'The Sale with a line in the cart', only: ['phone'], reach: async (page) => {
    await addE2E1(page);
    await expect(page.getByTestId('phone-tab-cart-count')).toBeVisible();
  } },
  { id: '17b', title: 'Phone, menu', state: 'Drawer menu open', only: ['phone'], reach: async (page) => {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.getByTestId('nav-drawer-panel')).toBeVisible();
  } },
  { id: '17c', title: 'Phone, tender', state: 'Tender', only: ['phone'], reach: async (page, size) => {
    await addE2E1(page);
    await cart(page, size);
    await page.getByTestId('cart-checkout').click();
    await expect(page.getByTestId('tender-pane')).toBeVisible();
  } },
  { id: '18', title: 'Coupons', state: 'A €1.00 coupon applied', reach: async (page, size) => {
    const code = `E2E-SAVE-${Date.now()}`;
    const response = await fetch(`${backend}/admin/promotions`, { method: 'POST',
      headers: { Authorization: `Bearer ${await adminToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, type: 'standard', status: 'active', is_automatic: false, is_tax_inclusive: false,
        application_method: { type: 'fixed', target_type: 'items', allocation: 'across', value: 1, currency_code: 'eur' } }) });
    if (!response.ok) throw new Error(`promotion: ${response.status}`);
    // The stored session keeps no coupons capability, so after a reload the till offers no coupon field until a sign-in.
    await signOut(page);
    await signIn(page, 'Europe', false);
    await add(page, 'E2E-1', 'E2E-1');
    await cart(page, size);
    await page.getByLabel('Coupon code', { exact: true }).fill(code);
    await page.getByTestId('coupon-apply').click();
    await expect(page.getByTestId(`coupon-row-${code.toLowerCase()}`)).toBeVisible();
  } },
  { id: '19', title: 'Sale, offline', state: 'The Sale offline with one unsent sale', reach: async (page, size) => {
    await page.context().setOffline(true);
    await expect(headerState(page)).toHaveText('Offline');
    await sell(page, size, 'E2E-2');
    await expect(headerState(page)).toHaveText('Offline · 1 sale to send');
  } },
];
