import { expect, test, type Page } from '@playwright/test';
import { sellBySku, signIn } from './helpers';

// The password used by the e2e fixture account (mirrors the fallback in helpers.ts's `signIn`).
const password = process.env.E2E_PASSWORD ?? 'e2e-password';

// Intercepts only the POS's command endpoint, leaving catalogue/settings requests alone so a
// wrong-endpoint 401 can't be confused with the auth-required strip this file is testing.
async function routeCommands(page: Page, status: number, body: unknown) {
  await page.route('**/tally/v1/commands', route =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
}

test('sign-in strip: outbox pauses after three 401s, resumes once signed in again', async ({ page }) => {
  await signIn(page);
  await routeCommands(page, 401, {});
  await sellBySku(page, ['E2E-1'], 'exact');

  // createOrderOutbox pauses with authRequired after AUTH_FAILURES_BEFORE_PROMPT (3) 401s, retrying
  // with a doubling backoff (default initialBackoffMs 1000, so ~1s then ~2s between attempts) —
  // give it well beyond that before calling it stuck.
  await expect(page.getByText('1 sale saved, waiting to send ·', { exact: true })).toBeVisible({ timeout: 20_000 });
  const signInLink = page.getByRole('button', { name: 'Sign in', exact: true });
  await expect(signInLink).toBeVisible();

  await page.unroute('**/tally/v1/commands');
  await signInLink.click();
  await expect(page.getByRole('heading', { name: 'Sign in again', exact: true })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Sign in again', exact: true })).not.toBeVisible();
  await expect(page.getByText('saved, waiting to send', { exact: false })).not.toBeVisible();

  await page.getByRole('button', { name: /^Orders(?: \(\d+\))?$/ }).click();
  await expect(page.getByText('· Synced', { exact: false })).toBeVisible();
});

test('refused strip: shows the store\'s refusal reason and recovers via Try again', async ({ page }) => {
  await signIn(page);
  await routeCommands(page, 400, { code: 'unsupported_protocol', message: 'Unsupported protocol' });
  await sellBySku(page, ['E2E-2'], 'exact');

  await expect(page.getByText('1 sale not accepted ·', { exact: true })).toBeVisible();
  const detailsLink = page.getByRole('button', { name: 'Details', exact: true });
  await expect(detailsLink).toBeVisible();
  await detailsLink.click();

  await expect(page.getByRole('heading', { name: 'Not accepted by the store', exact: true })).toBeVisible();
  // http-transport.ts prefers the response body's `message` over `code` as the refusal reason.
  await expect(page.getByText('Unsupported protocol', { exact: false })).toBeVisible();
  await expect(page.getByText('HTTP 400', { exact: false })).toBeVisible();

  await page.unroute('**/tally/v1/commands');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Not accepted by the store', exact: true })).not.toBeVisible();
  await expect(page.getByText('not accepted', { exact: false })).not.toBeVisible();

  await page.getByRole('button', { name: /^Orders(?: \(\d+\))?$/ }).click();
  await expect(page.getByText('· Synced', { exact: false })).toBeVisible();
});
