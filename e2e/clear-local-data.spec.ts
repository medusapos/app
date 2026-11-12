import { expect, type Page } from '@playwright/test';
import { addE2E1, openArea, signIn, test } from './helpers';

// Settings › Danger zone › Clear all local data (WCPOS v2's): the reload wipes the OPFS pool, the legacy Dexie
// databases and every medusapos. key before anything opens, and lands on sign-in.
test.use({ viewport: { width: 360, height: 740 } });

const takeOver = 'The till is open. Its session stays open on your server: after the reset, open this register again and choose Take over.';

const local = (page: Page) => page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  return {
    pool: await root.getDirectoryHandle('.tallyui').then(() => true, () => false),
    keys: Object.keys(localStorage).filter((k) => k.startsWith('medusapos.')),
    legacy: (await indexedDB.databases()).map((db) => db.name).filter((name) => name?.startsWith('rxdb-dexie-medusapos_')),
  };
});

test('Clear all local data wipes the device and returns to sign-in', async ({ page }) => {
  await signIn(page);
  const before = await local(page);
  expect(before.pool).toBe(true);
  expect(before.keys).not.toEqual([]);
  const oldId = await page.evaluate(() => localStorage.getItem('medusapos.register_id'));

  await openArea(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByTestId('clear-local-data').click();
  await expect(page.getByTestId('clear-local-data-warning')).toHaveText('Nothing is waiting to be sent, so your server already has your sales.');
  // signIn left the till open, so the dialog names it and asks for the typed word.
  await expect(page.getByTestId('clear-local-data-warning-1')).toHaveText(takeOver);
  await expect(page.getByTestId('clear-local-data-confirm')).toBeDisabled();
  await page.getByTestId('clear-local-data-word').fill('CLEAR');
  await expect(page.getByTestId('clear-local-data-confirm')).toBeEnabled();
  await page.getByTestId('clear-local-data-confirm').click();

  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  // The OutboxProvider issues a new device id on startup, so the wiped till starts as a new device.
  expect(await local(page)).toEqual({ pool: false, keys: ['medusapos.register_id'], legacy: [] });
  const newId = await page.evaluate(() => localStorage.getItem('medusapos.register_id'));
  expect(oldId).not.toBeNull();
  expect(newId).not.toBe(oldId);

  await signIn(page);
});

test('after a wipe the open server session is taken over, not lost', async ({ page }) => {
  await signIn(page);
  await openArea(page, 'Settings');
  await page.getByTestId('clear-local-data').click();
  await page.getByTestId('clear-local-data-word').fill('CLEAR');
  await page.getByTestId('clear-local-data-confirm').click();
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();

  // Not openRegister: it would close the server session first. The new device id's open is refused.
  await signIn(page, 'Europe', false);
  await page.getByTestId('register-bar-pill').click();
  await page.getByTestId('register-picker-row-register-1').click();
  await page.getByTestId('open-register-amount').fill('100.00');
  await page.getByTestId('open-register-button').click();
  const card = page.getByTestId('register-conflict-card');
  await expect(card).toBeVisible();
  await card.getByTestId('register-conflict-take-over').click();
  await expect(page.getByRole('button', { name: 'Open register panel', exact: true })).toBeVisible();
  await expect(card).toHaveCount(0);
});

test.describe('with a parked sale', () => {
  // parked-sales.spec.ts's park steps, at its wide layout.
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the dialog names the parked sale and Confirm waits for CLEAR', async ({ page }) => {
    await signIn(page);
    await addE2E1(page);
    await page.getByRole('button', { name: 'Parked sales', exact: true }).click();
    await page.getByTestId('parked-sales-park').click();
    await expect(page.getByTestId(/^parked-resume-/)).toHaveCount(1);
    await page.getByTestId('parked-sales-dismiss').click();
    await expect(page.getByTestId('cart-empty')).toBeVisible();

    await openArea(page, 'Settings');
    await page.getByTestId('clear-local-data').click();
    await expect(page.getByTestId('clear-local-data-warning'))
      .toHaveText('1 parked sale on this device has never reached your server and will be permanently lost.');
    await expect(page.getByTestId('clear-local-data-warning-1')).toHaveText('Parked sales are kept only on this device.');
    await expect(page.getByTestId('clear-local-data-confirm')).toBeDisabled();
    await page.getByTestId('clear-local-data-word').fill('CLEA');
    await expect(page.getByTestId('clear-local-data-confirm')).toBeDisabled();
    await page.getByTestId('clear-local-data-word').fill('CLEAR');
    await expect(page.getByTestId('clear-local-data-confirm')).toBeEnabled();
  });
});
