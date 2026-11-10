import { expect, type Page } from '@playwright/test';
import { signIn, test } from './helpers';

// Settings › Danger zone › Clear all local data (WCPOS v2's): the reload wipes the OPFS pool, the legacy Dexie
// databases and every medusapos. key before anything opens, and lands on sign-in.
test.use({ viewport: { width: 360, height: 740 } });

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

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByTestId('clear-local-data').click();
  await expect(page.getByTestId('clear-local-data-warning')).toHaveText('Nothing is waiting to be sent, so your server already has your sales.');
  await page.getByTestId('clear-local-data-confirm').click();

  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  // The OutboxProvider issues a new device id on startup, so the wiped till starts as a new device.
  expect(await local(page)).toEqual({ pool: false, keys: ['medusapos.register_id'], legacy: [] });
  const newId = await page.evaluate(() => localStorage.getItem('medusapos.register_id'));
  expect(oldId).not.toBeNull();
  expect(newId).not.toBe(oldId);

  await signIn(page);
});
