import { expect, test, type Page } from '@playwright/test';
import { sellBySku, signIn } from './helpers';

// Mirrors helpers.ts's own fallbacks (not exported there); COMMANDS_PATH is hardcoded rather than
// imported from @tallyui/core, matching strips.spec.ts — the e2e runner's Node ESM resolution of
// that package (unlike vitest's own aliasing) fails on this worktree's node_modules layout.
const backend = process.env.E2E_BACKEND_URL ?? 'http://localhost:9100';
const password = process.env.E2E_PASSWORD ?? 'e2e-password';
const COMMANDS_PATH = '/tally/v1/commands';

// The product the follower's replicated (multiInstance, shared IndexedDB) catalogue is checked
// against before selling on it — proof the leader's own replication has already reached it.
const READY_PRODUCT = 'E2E product 1';

// Counts POST /tally/v1/commands requests this specific page makes (each Playwright Page only
// sees requests from its own frame tree, so this attributes a send to leader or follower).
function countCommands(page: Page) {
  const counter = { count: 0 };
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url() === `${backend}${COMMANDS_PATH}`) counter.count++;
  });
  return counter;
}

function countInventoryRequests(page: Page) {
  const counter = { count: 0 };
  page.on('request', (request) => {
    if (request.method() === 'GET' && request.url().includes('/admin/inventory-items')) counter.count++;
  });
  return counter;
}

// The stock-reconcile runner listens for page visibility (react-native-web's AppState); a real
// background/foreground cycle triggers a pass without waiting for its timer (mirrors live-stock.spec.ts).
async function triggerReconcile(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function openFollowerTab(page: Page): Promise<Page> {
  await page.goto('/');
  await expect(page.getByText(READY_PRODUCT, { exact: true })).toBeVisible({ timeout: 30_000 });
  return page;
}

test('follower sale, leader sends', async ({ page, context }) => {
  await signIn(page);
  const pageB = await openFollowerTab(await context.newPage());
  const countA = countCommands(page);
  const countB = countCommands(pageB);

  await context.setOffline(true);
  await sellBySku(pageB, ['E2E-1'], 'exact');
  await context.setOffline(false);

  await pageB.getByRole('button', { name: /^Orders(?: \(\d+\))?$/ }).click();
  await expect(pageB.getByText('· Synced', { exact: false })).toBeVisible({ timeout: 60_000 });

  expect(countB.count).toBe(0);
  expect(countA.count).toBeGreaterThan(0);
});

test('leader close, follower takes over', async ({ page, context }) => {
  await signIn(page);
  const pageB = await openFollowerTab(await context.newPage());
  const countB = countCommands(pageB);

  await context.setOffline(true);
  await sellBySku(pageB, ['E2E-2'], 'exact');
  await page.close();
  await context.setOffline(false);

  await pageB.getByRole('button', { name: /^Orders(?: \(\d+\))?$/ }).click();
  await expect(pageB.getByText('· Synced', { exact: false })).toBeVisible({ timeout: 60_000 });
  expect(countB.count).toBeGreaterThan(0);
});

test('strips in the follower: shared auth-required state, sign-in from B reaches the leader', async ({ page, context }) => {
  await signIn(page);
  const pageB = await openFollowerTab(await context.newPage());

  await context.route(`**${COMMANDS_PATH}`, (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await sellBySku(pageB, ['E2E-3'], 'exact');

  // createOrderOutbox pauses with authRequired after 3 401s (from the leader, A); the shared
  // state reaches the follower via the outbox's local doc (TallyUI #42).
  await expect(pageB.getByText('1 sale saved, waiting to send ·', { exact: true })).toBeVisible({ timeout: 20_000 });
  const signInLink = pageB.getByRole('button', { name: 'Sign in', exact: true });
  await expect(signInLink).toBeVisible();

  await context.unroute(`**${COMMANDS_PATH}`);
  await signInLink.click();
  await expect(pageB.getByRole('heading', { name: 'Sign in again', exact: true })).toBeVisible();
  await pageB.getByLabel('Password', { exact: true }).fill(password);
  await pageB.getByRole('button', { name: 'Sign in', exact: true }).click();

  // B's sign-in saves a new token to the shared session key; the leader (A) picks it up via the
  // storage event and B's flush() (forwarded to A) can now send with it.
  await expect(pageB.getByRole('heading', { name: 'Sign in again', exact: true })).not.toBeVisible();
  await expect(pageB.getByText('saved, waiting to send', { exact: false })).not.toBeVisible();

  await pageB.getByRole('button', { name: /^Orders(?: \(\d+\))?$/ }).click();
  await expect(pageB.getByText('· Synced', { exact: false })).toBeVisible({ timeout: 60_000 });
});

test('stock runner only in the leader tab', async ({ page, context }) => {
  await signIn(page);
  const pageB = await openFollowerTab(await context.newPage());
  const countA = countInventoryRequests(page);
  const countB = countInventoryRequests(pageB);

  await triggerReconcile(page);
  await triggerReconcile(pageB);
  await expect.poll(() => countA.count, { timeout: 30_000 }).toBeGreaterThan(0);
  expect(countB.count).toBe(0);

  await page.close();
  await triggerReconcile(pageB);
  await expect.poll(() => countB.count, { timeout: 60_000 }).toBeGreaterThan(0);
});
