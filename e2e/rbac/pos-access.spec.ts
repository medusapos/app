import { expect, type Page } from '@playwright/test';
import { captureCommands, sellBySku, signIn, submitSignIn, test } from '../helpers';

// ADR 0023, "Who may use the POS", on a store with RBAC on: the users come from seed-e2e-rbac and the
// roles from the plugin's tally-pos-roles, as a store owner would create them.
const cashier = { email: 'pos-cashier@tally.test', password: 'e2e-password' };
const noPos = { email: 'no-pos@tally.test', password: 'e2e-password' };

// Signs in as `as`, syncs the catalogue, opens the register (openRegister asserts the store applied it)
// and sells E2E-1 for cash. The store must apply the sale, and no request the till made may answer 403.
async function signInAndSell(page: Page, as?: typeof cashier) {
  const refused: string[] = [];
  page.on('response', response => { if (response.status() === 403) refused.push(`${response.request().method()} ${response.url()}`); });
  const sales = captureCommands(page);
  await signIn(page, 'Europe', true, as);
  await sellBySku(page, ['E2E-1'], 'exact');
  await expect(page.getByText('Sales are up to date.', { exact: true })).toBeVisible();
  expect(new Set(sales.map(({ id }) => id)).size).toBe(1);
  await expect.poll(() => sales.at(-1)?.status).toBe('applied');
  expect(refused, 'requests the store refused with 403').toEqual([]);
}

// Refused by the /tally/v1/info probe, before any session: a later 403 (the store-settings read) would sign the
// till out with the same words, so the screen alone can't tell a refused sign-in from an admitted one.
test('a user with no POS role is refused at sign-in', async ({ page }) => {
  const admin: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/admin/')) admin.push(request.url()); });
  const info = page.waitForResponse(response => new URL(response.url()).pathname === '/tally/v1/info' && response.request().method() === 'GET');
  await submitSignIn(page, noPos);
  expect((await info).status()).toBe(403);
  await expect(page.getByText("This account can't use the POS. Ask the store owner for POS access.", { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByText('Set up this till', { exact: true })).toHaveCount(0);
  expect(admin, 'requests after a refused sign-in').toEqual([]);
});

test('a POS cashier signs in, opens the register and sells', async ({ page }) => {
  await signInAndSell(page, cashier);
});

test('a super admin still signs in and sells', async ({ page }) => {
  await signInAndSell(page);
});
