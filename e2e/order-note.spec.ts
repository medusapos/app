import { expect, type Page } from '@playwright/test';
import { addE2E1, adminToken, captureCommands, cartTab, inventoryLevel, ordersByClientId, setInventoryLevel, signIn, tenderCash, test,
  type PostedCommand } from './helpers';

// The sale's note (v2 parity rows 8 and 04c, ADR 0024): the cart's note sheet (v2's Order details) and note row, kept with a
// parked sale, shown on the receipt and sent as order.create v7's `note`, which the store keeps as the order's
// metadata.tally_note. Sells only E2E-1.
type Sale = { clientOrderId: string; note?: string };
const NOTE = 'Leave at reception, gift wrap';

for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 780 }]) {
  test.describe(`at ${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport });
    const phone = viewport.width < 600;
    // On a phone the cart, and so the note, shows in the cart view, which the Cart tab opens.
    const openCart = async (page: Page) => { if (phone) await cartTab(page).click(); };
    const noteField = (page: Page) => page.getByPlaceholder('Order note', { exact: true });
    // v2's ⋮ beside Checkout, then its Order details item, opens the note sheet.
    const openOrderDetails = async (page: Page) => {
      await page.getByTestId('cart-foot-more').click();
      await page.getByTestId('cart-foot-menu').getByRole('menuitem', { name: 'Order details', exact: true }).click();
    };
    const addNote = async (page: Page, note: string) => {
      await openOrderDetails(page);
      await noteField(page).fill(note);
      await page.getByTestId('cart-note-close').click();
    };
    const noteRow = (page: Page) => page.getByTestId('cart-note-row');
    // Cash exact and Complete sale, as sellBySku pays, stopping on the receipt (before New sale).
    const payCashExact = async (page: Page) => {
      await page.getByTestId('cart-checkout').click();
      await tenderCash(page, 'exact');
      await page.getByRole('button', { name: 'Complete sale', exact: true }).click();
      await expect(page.getByRole('button', { name: 'New sale', exact: true })).toBeVisible();
    };
    // The suite shares E2E-1 stock (as register.spec.ts does): read its level before each test sells anything, and
    // give it back after, once every sale the test sent has applied, so no sale lands late in a later spec and the
    // restore can't come before the decrement. Restored also when the test fails.
    let token: string;
    let level: Awaited<ReturnType<typeof inventoryLevel>>;
    let commands: PostedCommand<Sale>[];
    test.beforeEach(async ({ page }) => {
      token = await adminToken();
      level = await inventoryLevel(token, 'E2E-1');
      commands = captureCommands<Sale>(page);
    });
    test.afterEach(async () => {
      try {
        await expect.poll(() => commands.every(({ status }) => status === 'applied')).toBe(true);
      } finally {
        await setInventoryLevel(token, level.inventoryItemId, level.locationId, level.stockedQuantity);
      }
    });

    test('a note added in the cart reaches the receipt and the Medusa order', async ({ page }) => {
      await signIn(page);
      await addE2E1(page);
      await openCart(page);
      await addNote(page, NOTE);
      await expect(noteRow(page)).toContainText(NOTE);
      await expect(noteRow(page)).toBeInViewport();
      await page.screenshot({ path: test.info().outputPath(`cart-note-${viewport.width}.png`) });
      await payCashExact(page);
      await expect(page.getByTestId('receipt-note')).toContainText(NOTE);
      await expect(page.getByTestId('receipt-note-not-sent')).toHaveCount(0);
      await expect.poll(() => commands.length).toBeGreaterThan(0);
      const [{ version, payload }] = commands;
      expect(version).toBe(7);
      expect(payload.note).toBe(NOTE);
      await page.getByRole('button', { name: 'New sale', exact: true }).click();
      // A phone's cart bar shows only with items, so the new sale takes one to open its cart view.
      if (phone) await addE2E1(page);
      await openCart(page);
      await expect(page.getByText('Add order note', { exact: true })).toHaveCount(0);
      await expect(noteRow(page)).toHaveCount(0);
      await expect.poll(async () => (await ordersByClientId(token))
        .find((order) => order.metadata.tally_client_id === payload.clientOrderId)?.metadata.tally_note, { timeout: 30_000 })
        .toBe(NOTE);
    });

    test('a note stays with a parked sale and goes with it when resumed', async ({ page }) => {
      await signIn(page);
      await addE2E1(page);
      await openCart(page);
      await addNote(page, 'Park me');
      await page.getByTestId('new-sale-tab').click();
      await expect(page.getByTestId(/^open-sale-tab-.*-who$/)).toBeVisible();
      await expect(page.getByTestId('cart-empty')).toBeVisible();
      await expect(page.getByText('Add order note', { exact: true })).toHaveCount(0);
      await expect(noteRow(page)).toHaveCount(0);
      await page.getByTestId(/^open-sale-tab-.*-who$/).click();
      await expect(noteRow(page)).toContainText('Park me');
      await expect(noteRow(page)).toBeInViewport();
      await payCashExact(page);
      await expect.poll(() => commands.length).toBeGreaterThan(0);
      const [{ version, payload }] = commands;
      expect(version).toBe(7);
      expect(payload.note).toBe('Park me');
    });

    test('a note is clamped to 1000 characters', async ({ page }) => {
      await signIn(page);
      await addE2E1(page);
      await openCart(page);
      await openOrderDetails(page);
      await noteField(page).fill('x'.repeat(1001));
      await expect(noteField(page)).toHaveValue('x'.repeat(1000));
    });

    test('the Order details Form and JSON tabs sit side by side', async ({ page }) => {
      await signIn(page);
      await addE2E1(page);
      await openCart(page);
      await openOrderDetails(page);
      const formTab = page.getByTestId('cart-order-tab-form');
      const form = (await formTab.boundingBox())!;
      const json = (await page.getByTestId('cart-order-tab-json').boundingBox())!;
      const list = (await formTab.locator('..').boundingBox())!;
      expect(Math.abs(json.y - form.y)).toBeLessThanOrEqual(1);
      expect(json.x).toBeGreaterThanOrEqual(form.x + form.width - 1);
      for (const tab of [form, json]) {
        expect(tab.x).toBeGreaterThanOrEqual(list.x - 1);
        expect(tab.y).toBeGreaterThanOrEqual(list.y - 1);
        expect(tab.x + tab.width).toBeLessThanOrEqual(list.x + list.width + 1);
        expect(tab.y + tab.height).toBeLessThanOrEqual(list.y + list.height + 1);
      }
      await page.getByTestId('cart-note-close').click();
    });

    test('a sale with no note goes at its base version, with no note', async ({ page }) => {
      await signIn(page);
      await addE2E1(page);
      await openCart(page);
      await payCashExact(page);
      await expect.poll(() => commands.length).toBeGreaterThan(0);
      const [{ version, payload }] = commands;
      expect(version).toBeLessThan(7);
      expect(payload).not.toHaveProperty('note');
    });
  });
}
