import { expect, type Page } from '@playwright/test';
import { addE2E1, adminToken, captureCommands, inventoryLevel, ordersByClientId, setInventoryLevel, signIn, tenderCash, test,
  type PostedCommand } from './helpers';

// The sale's note (v2 parity row 8, ADR 0024): CartNoteInput in the cart, kept with a parked sale, shown on the
// receipt and sent as order.create v7's `note`, which the store keeps as the order's metadata.tally_note. Sells only E2E-1.
type Sale = { clientOrderId: string; note?: string };
const NOTE = 'Leave at reception, gift wrap';

for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 780 }]) {
  test.describe(`at ${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport });
    const phone = viewport.width < 600;
    // On a phone the cart, and so the note, shows in the cart view, which the cart bar opens.
    const openCart = async (page: Page) => { if (phone) await page.getByRole('button', { name: /^Open cart, / }).click(); };
    const noteField = (page: Page) => page.getByPlaceholder('Order note', { exact: true });
    const addNote = async (page: Page, note: string) => {
      await page.getByText('Add order note', { exact: true }).click();
      await noteField(page).fill(note);
    };
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
      await expect(noteField(page)).toHaveValue(NOTE);
      await expect(noteField(page)).toBeInViewport();
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
      await expect(page.getByText('Add order note', { exact: true })).toBeVisible();
      await expect(noteField(page)).toHaveCount(0);
      await expect.poll(async () => (await ordersByClientId(token))
        .find((order) => order.metadata.tally_client_id === payload.clientOrderId)?.metadata.tally_note, { timeout: 30_000 })
        .toBe(NOTE);
    });

    test('a note stays with a parked sale and goes with it when resumed', async ({ page }) => {
      await signIn(page);
      await addE2E1(page);
      await openCart(page);
      await addNote(page, 'Park me');
      await page.getByRole('button', { name: 'Parked sales', exact: true }).click();
      await page.getByTestId('parked-sales-park').click();
      await expect(page.getByTestId(/^parked-resume-/)).toHaveCount(1);
      await page.getByTestId('parked-sales-dismiss').click();
      await expect(page.getByTestId('cart-empty')).toBeVisible();
      await expect(page.getByText('Add order note', { exact: true })).toBeVisible();
      await expect(noteField(page)).toHaveCount(0);
      await page.getByRole('button', { name: 'Parked sales (1)', exact: true }).click();
      await page.getByTestId(/^parked-resume-/).click();
      await expect(noteField(page)).toHaveValue('Park me');
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
      await addNote(page, 'x'.repeat(1001));
      await expect(noteField(page)).toHaveValue('x'.repeat(1000));
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
