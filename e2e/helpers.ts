import { expect, test as base, type BrowserContext, type Page, type Request } from '@playwright/test';
import { E2E_RUN } from './ports';

const backend = process.env.E2E_BACKEND_URL ?? `http://localhost:${E2E_RUN.backendPort}`;
export const credentials = { email: process.env.E2E_EMAIL ?? 'e2e@tally.test', password: process.env.E2E_PASSWORD ?? 'e2e-password' };

// CSP gate (#154, ADR 0002): this auto fixture collects CSP violations in the test's context from its first navigation
// (page events and Chromium console reports) and, taking `page` to read them before it closes, fails the test with any
// at its end. Page events live in each document and are lost on navigation; the console channel keeps those too.
// Specs take `test` from here: a top-level afterEach in this module would bind only to the first spec file loading it.
type CspViolation = { violatedDirective: string; blockedURI: string; sourceFile: string } | { console: string };
type CspWindow = Window & { __cspViolations?: CspViolation[] };
const cspConsole = new Map<BrowserContext, string[]>();
let cspArmedFor: string | undefined;
export const test = base.extend<{ cspGate: void }>({ cspGate: [async ({ page }, use, testInfo) => {
  cspArmedFor = testInfo.testId;
  await watchCsp(page.context());
  await use();
  const violations = (await Promise.all([...cspConsole.keys()].map(cspViolations))).flat();
  cspConsole.clear();
  expect(violations, 'Content-Security-Policy violations').toEqual([]);
}, { auto: true }] });

async function watchCsp(context: BrowserContext) {
  if (cspConsole.has(context)) return;
  const reports = cspConsole.set(context, []).get(context)!;
  context.on('console', message => { if (/Content[- ]Security[- ]Policy/.test(message.text())) reports.push(message.text()); });
  await context.addInitScript(() => {
    const found: CspViolation[] = (window as CspWindow).__cspViolations = [];
    addEventListener('securitypolicyviolation', ({ violatedDirective, blockedURI, sourceFile }) => found.push({ violatedDirective, blockedURI, sourceFile }));
  });
}

export async function cspViolations(context: BrowserContext): Promise<CspViolation[]> {
  const events = await Promise.all(context.pages().map(page => page.evaluate(() => (window as CspWindow).__cspViolations ?? []).catch(() => [])));
  return [...events.flat(), ...(cspConsole.get(context) ?? []).map(text => ({ console: text }))];
}

export async function resetCspViolations(context: BrowserContext) {
  cspConsole.get(context)?.splice(0);
  await Promise.all(context.pages().map(page => page.evaluate(() => (window as CspWindow).__cspViolations?.splice(0)).catch(() => {})));
}

// The e2e store has two regions and no default one, so a fresh till shows "Set up this till";
// the existing specs keep Europe (dk, 25% exclusive). Returns whether the choice screen showed;
// with `region` null it returns there, without choosing. Then opens the register, unless `register` is false; 'unsynced'
// opens it without waiting for the store, for a till whose register commands can't reach it (aborted, or no register capability).
export async function signIn(page: Page, region: string | null = 'Europe', register: boolean | 'unsynced' = true): Promise<boolean> {
  expect(cspArmedFor, "CSP gate is off: take `test` from './helpers'").toBe(test.info().testId);
  await watchCsp(page.context());
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByLabel('Backend URL', { exact: true })).toBeEditable();
  await expect(async () => {
    await page.getByLabel('Backend URL', { exact: true }).clear();
    await page.getByLabel('Backend URL', { exact: true }).fill(backend);
    await page.getByLabel('Email', { exact: true }).fill(credentials.email);
    await page.getByLabel('Password', { exact: true }).fill(credentials.password);
    await expect(page.getByLabel('Backend URL', { exact: true })).toHaveValue(backend, { timeout: 1000 });
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue(credentials.email, { timeout: 1000 });
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue(credentials.password, { timeout: 1000 });
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 20000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const setUp = page.getByText('Set up this till', { exact: true });
  const hosted = process.env.E2E_BACKEND_URL !== undefined;
  await expect(setUp.or(page.getByText(/Up to date · /))).toBeVisible({ timeout: hosted ? 5 * 60_000 : undefined });
  const chose = await setUp.isVisible();
  if (chose && region === null) return true;
  if (chose) await chooseRegion(page, region!);
  if (hosted) {
    await expect(page.getByText(/Up to date · [\d,.  ]+ products/)).toBeVisible({ timeout: 5 * 60_000 });
  } else {
    await expect(page.getByText(/Up to date · 5 products/)).toBeVisible();
  }
  if (register) await openRegister(page, undefined, register !== 'unsynced');
  return chose;
}

// ADR 0017: paying needs an open register session. Binds this fresh till to Register 1 through the picker and
// opens it with `float` through the open card, both above the cart. On a phone they show in the cart view, which
// the register pill opens even with an empty cart; it then returns to Products. The store keeps one open session per
// register (spec-42) and every earlier till left Register 1 open there, so this first closes the store's session, then
// waits for the store to apply this till's open (unless not `synced`): a refused open (ADR-078's conflict) fails here, not in a later sale.
export async function openRegister(page: Page, float = '100.00', synced = true) {
  const phone = (page.viewportSize()?.width ?? 1280) < 600;
  await closeStoreRegister();
  const opened = synced && page.waitForResponse(response => isCommandPost(response.request())
    && (response.request().postDataJSON().commands as PostedCommand<unknown>[]).some(({ type }) => type === 'register.session.open'));
  if (phone) await page.getByTestId('register-bar-pill').click();
  await page.getByTestId('register-picker-row-register-1').click();
  await page.getByTestId('open-register-amount').fill(float);
  await page.getByTestId('open-register-button').click();
  if (opened) {
    const response = await opened;
    const opens = (response.request().postDataJSON().commands as PostedCommand<unknown>[]).filter(({ type }) => type === 'register.session.open');
    const { results = [] } = await response.json() as { results?: { id: string; status: string }[] };
    const result = results.find(({ id }) => opens.some(open => open.id === id));
    expect(result?.status, `The store refused this till's register.session.open: ${JSON.stringify(result)}`).toBe('applied');
  }
  await expect(page.getByRole('button', { name: 'Open register panel', exact: true })).toBeVisible();
  await expect(page.getByTestId('open-register-card')).toHaveCount(0);
  if (phone) await page.getByRole('button', { name: 'Products', exact: true }).click();
}

// On "Set up this till": pick a region and continue.
export async function chooseRegion(page: Page, region: string) {
  await page.getByRole('radio', { name: region, exact: true }).click();
  await page.getByText('Continue', { exact: true }).click();
}

// Numeric cash is in EUR major units. Return the displayed receipt total before New sale.
export async function sellBySku(page: Page, skus: string[], cash: 'exact' | number | 'external') {
  const search = page.getByPlaceholder('Search or scan barcode / SKU', { exact: true });
  for (const sku of skus) {
    await search.fill(sku);
    await search.press('Enter');
    try {
      await expect(search).toHaveValue('');
    } catch (error) {
      try {
        const snapshot = await page.evaluate(() => (window as Window & { __medusaposCatalogue?: unknown }).__medusaposCatalogue);
        const body = JSON.stringify(snapshot ?? null, null, 2);
        console.log(`Catalogue snapshot after SKU lookup failed for ${sku}:\n${body}`);
        await test.info().attach('catalogue-snapshot', { body, contentType: 'application/json' });
      } finally {
        throw error;
      }
    }
  }
  if (cash === 'external') {
    await page.getByRole('button', { name: 'Card terminal', exact: true }).click();
    await page.getByLabel('Terminal reference', { exact: true }).fill('e2e-offline-terminal');
    await page.getByRole('button', { name: 'Payment approved on terminal', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Cash', exact: true }).click();
    const tender = page.getByText('Cash Tendered', { exact: true }).locator('..');
    const amount = tender.locator('input');
    if (cash === 'exact') {
      // The first quick amount is the exact total, followed by rounded amounts.
      await tender.locator('[tabindex="0"]').first().click();
      await amount.fill(await amount.inputValue());
    } else {
      await amount.fill(cash.toFixed(2));
    }
    await page.getByRole('button', { name: 'Complete sale', exact: true }).click();
  }
  const newSale = page.getByRole('button', { name: 'New sale', exact: true });
  await expect(newSale).toBeVisible();
  const receiptText = (await page.getByLabel(/^Total: /).getAttribute('aria-label')) ?? '';
  const total = Number(receiptText.replace(/[^\d.,]/g, '').replace(',', '.'));
  await newSale.click();
  return total;
}

type SalePayload = {
  clientOrderId: string; totalMinor: number;
  lines: { variantId: string; quantity: number; unitPriceMinor: number }[];
  payments: { method: string }[];
};

export type PostedCommand<P> = { id: string; type: string; version: number; payload: P; status?: string };
const isCommandPost = (request: Request) => request.method() === 'POST' && request.url() === `${backend}/tally/v1/commands`;

// Every `type` command the till POSTs to /tally/v1/commands, once per attempt, each with the status the store last
// answered for its id. The till sends its register facts there too (register >= 1), so sale tests take order.create.
export function captureCommands<P>(page: Page, type = 'order.create'): PostedCommand<P>[] {
  const commands: PostedCommand<P>[] = [];
  page.on('request', request => {
    if (isCommandPost(request)) commands.push(...(request.postDataJSON().commands as PostedCommand<P>[]).filter(command => command.type === type));
  });
  page.on('response', async response => {
    if (!isCommandPost(response.request())) return;
    const { results = [] } = await response.json().catch(() => ({})) as { results?: { id: string; status: string }[] };
    for (const { id, status } of results) for (const command of commands) if (command.id === id) command.status = status;
  });
  return commands;
}

// The sales POSTed to /tally/v1/commands (order.create only), one per clientOrderId however often it was sent.
export function captureSales(page: Page) {
  const sales = new Map<string, SalePayload>();
  page.on('request', request => {
    if (!isCommandPost(request)) return;
    for (const { type, payload } of request.postDataJSON().commands as PostedCommand<SalePayload>[]) {
      if (type === 'order.create') sales.set(payload.clientOrderId, payload);
    }
  });
  return sales;
}

export async function adminToken(): Promise<string> {
  const response = await fetch(`${backend}/auth/user/emailpass`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
  });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  return (await response.json()).token;
}

// One register command POSTed to the store as another till would (device `e2e`), which the store must apply.
async function storeRegisterCommand(type: string, version: number, payload: Record<string, unknown>) {
  const at = new Date().toISOString();
  const response = await fetch(`${backend}/tally/v1/commands`, { method: 'POST', headers: { Authorization: `Bearer ${await adminToken()}`,
    'Content-Type': 'application/json', 'X-Tally-Protocol': '1' }, body: JSON.stringify({ commands: [{
    id: crypto.randomUUID(), type, version, createdAt: at, deviceId: 'e2e', attempt: 1, payload: { ...payload, ...(type === 'register.session.open' ? { openedAt: at } : { at }) },
  }] }) });
  expect((await response.json()).results).toEqual([expect.objectContaining({ status: 'applied' })]);
}

// The store keeps one open session per register (spec-42); this closes the store's open session, as a till would.
export async function closeStoreRegister(registerId = 'register-1') {
  const state = await fetch(`${backend}/tally/v1/registers/${registerId}`, { headers: { Authorization: `Bearer ${await adminToken()}` } });
  const { session } = state.status === 404 ? {} : await state.json() as { session?: { id: string; status: string } };
  if (!session || session.status === 'closed') return;
  await storeRegisterCommand('register.session.transition', 1, { sessionId: session.id, status: 'closed' });
}

// Another till (`deviceName`) opens `registerId` at the store with a register v2 open (ADR-078); it must be closed first.
export async function openStoreRegister(deviceName: string, registerId = 'register-1') {
  await storeRegisterCommand('register.session.open', 2, { sessionId: crypto.randomUUID(), registerId, countedFloatMinor: 10000, deviceName });
}

export async function createAdminCustomer(token: string, email: string, firstName: string, lastName: string): Promise<string> {
  const response = await fetch(`${backend}/admin/customers`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, first_name: firstName, last_name: lastName }) });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  return (await response.json()).customer.id;
}

export type AdminOrder = {
  id: string; display_id: number; metadata: { tally_client_id?: string }; total: number;
  status: string; payment_status: string; customer_id: string | null;
  payment_collections: { amount: number; status: string }[];
  items: { quantity: number; variant_id: string }[];
};

export async function ordersByClientId(token: string): Promise<AdminOrder[]> {
  const fields = 'id,display_id,metadata,total,status,payment_status,customer_id,payment_collections.amount,payment_collections.status,items.quantity,items.variant_id';
  const all: AdminOrder[] = [];
  let count: number;
  do {
    const response = await fetch(`${backend}/admin/orders?limit=100&offset=${all.length}&fields=${fields}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.ok, await response.clone().text()).toBeTruthy();
    const body = await response.json();
    all.push(...body.orders);
    count = body.count;
  } while (all.length < count);
  return all.filter(order => order.metadata?.tally_client_id);
}

export async function stockBySku(token: string): Promise<Record<string, number>> {
  const skus = ['E2E-1', 'E2E-2', 'E2E-3', 'E2E-4', 'E2E-5'].map(sku => `sku[]=${sku}`).join('&');
  const response = await fetch(`${backend}/admin/inventory-items?limit=100&fields=sku,location_levels.stocked_quantity&${skus}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { inventory_items } = await response.json();
  return Object.fromEntries(inventory_items.map((item: { sku: string; location_levels: { stocked_quantity: number }[] }) =>
    [item.sku, item.location_levels.reduce((total, level) => total + Number(level.stocked_quantity), 0)]));
}

// A single SKU's inventory level at its (single) e2e stock location, for tests that flip one
// variant's stock status server-side and need to restore it afterwards.
export async function inventoryLevel(token: string, sku: string): Promise<{ inventoryItemId: string; locationId: string; stockedQuantity: number }> {
  const response = await fetch(`${backend}/admin/inventory-items?limit=1&sku[]=${sku}&fields=id,sku,location_levels.location_id,location_levels.stocked_quantity`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { inventory_items } = await response.json();
  const [item] = inventory_items as { id: string; location_levels: { location_id: string; stocked_quantity: number }[] }[];
  const [level] = item.location_levels;
  return { inventoryItemId: item.id, locationId: level.location_id, stockedQuantity: Number(level.stocked_quantity) };
}

export async function setInventoryLevel(token: string, inventoryItemId: string, locationId: string, stockedQuantity: number): Promise<void> {
  const response = await fetch(`${backend}/admin/inventory-items/${inventoryItemId}/location-levels/${locationId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ stocked_quantity: stockedQuantity }),
  });
  expect(response.ok, await response.clone().text()).toBeTruthy();
}

export async function variantIdBySku(token: string, sku: string): Promise<string> {
  const response = await fetch(`${backend}/admin/product-variants?limit=1&sku[]=${sku}&fields=id,sku`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  const { variants } = await response.json();
  const [variant] = variants as { id: string }[];
  return variant.id;
}

// Adds one E2E-1 by scanning its SKU into the search box.
export async function addE2E1(page: Page) {
  const search = page.getByPlaceholder('Search or scan barcode / SKU', { exact: true });
  await search.fill('E2E-1');
  await search.press('Enter');
  await expect(search).toHaveValue('');
}

// Applies a discount from the cart's one line (its Discount action) or the Order discount button.
export async function discount(page: Page, opener: 'line' | 'order', type: 'Percent' | 'Amount', value: string) {
  await (opener === 'line' ? page.getByText('Discount', { exact: true }) : page.getByRole('button', { name: 'Order discount', exact: true })).click();
  await page.getByRole('button', { name: type, exact: true }).click();
  await page.getByLabel('Discount value', { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
}
