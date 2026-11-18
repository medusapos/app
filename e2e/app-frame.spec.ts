import { expect, type Locator } from '@playwright/test';
import { openArea, signIn, test } from './helpers';

// The app frame: the rail beside every signed-in area at 1440 x 900, the drawer behind the header's Menu at 390 x 844.
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`at ${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport });
    const wide = viewport.width >= 768;

    test('the frame reaches Products, Orders, Customers, Reports, Settings and back to the sale', async ({ page }) => {
      await signIn(page);
      await expect(page.getByTestId('app-frame')).toBeVisible();
      await expect(page.getByTestId('nav-rail')).toHaveCount(wide ? 1 : 0);
      await expect(page.getByRole('button', { name: 'Menu', exact: true })).toHaveCount(wide ? 0 : 1);
      if (!wide) {
        await page.getByRole('button', { name: 'Menu', exact: true }).click();
        await expect(page.getByTestId('nav-drawer-panel')).toBeVisible();
        // The backdrop spans the window under the 200 px panel, so click it to the panel's right, not at its centre.
        await page.getByTestId('nav-drawer-backdrop').click({ position: { x: viewport.width - 20, y: viewport.height / 2 } });
        await expect(page.getByTestId('nav-drawer')).toHaveCount(0);
      }
      for (const [area, path] of [['Products', /\/products$/], ['Orders', /\/orders$/], ['Customers', /\/customers$/],
        ['Reports', /\/reports$/], ['Settings', /\/settings$/]] as const) {
        await openArea(page, area);
        await expect(page).toHaveURL(path);
        if (wide) {
          // v2's areas start at their own first row on a wide window: no title bar, a main landmark carries the name.
          await expect(page.getByRole('main', { name: area })).toBeVisible();
          await expect(page.getByRole('heading', { name: area, exact: true })).toHaveCount(0);
        } else {
          await expect(page.getByRole('heading', { name: area, exact: true })).toBeVisible();
        }
        await expect(page.getByTestId('nav-drawer')).toHaveCount(0);
      }
      await openArea(page, 'POS');
      await expect(page.getByRole('heading', { name: / · Register 1$/ })).toBeVisible();
      // Back to the sale dismisses to it: one sale screen is mounted (hidden stack screens stay in the DOM).
      await expect(page.getByPlaceholder('Search or scan barcode / SKU', { exact: true })).toHaveCount(1);
    });

    test('every area has the account avatar at the top right, Settings on a phone only, opening the user sheet (row 14a)', async ({ page }) => {
      await signIn(page);
      const expectTopRight = async (avatar: Locator) => {
        await expect(avatar).toBeVisible();
        const box = (await avatar.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(80);
        expect(box.x).toBeGreaterThanOrEqual(viewport.width - 120);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      };
      for (const area of ['Products', 'Orders', 'Customers', 'Reports'] as const) {
        await openArea(page, area);
        const avatar = page.getByTestId('area-user-menu');
        await expectTopRight(avatar);
        if (area === 'Orders') {
          await avatar.click();
          await expect(page.getByTestId('user-sheet')).toBeVisible();
          await expect(page.getByTestId('user-sheet-name')).toBeVisible();
          await page.getByTestId('user-sheet-close').click();
          await expect(page.getByTestId('user-sheet')).toHaveCount(0);
        }
      }
      await openArea(page, 'Settings');
      await expect(page).toHaveURL(/\/settings$/);
      if (wide) {
        await expect(page.getByTestId('area-user-menu')).toHaveCount(0);
        return;
      }
      await expectTopRight(page.getByTestId('area-user-menu'));
      await page.getByTestId('settings-list').getByRole('button', { name: 'Tax', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Tax', exact: true })).toBeVisible();
      // The list stays mounted under the section page (hidden stack screens stay in the DOM), so take the visible avatar.
      const sectionAvatar = page.getByTestId('area-user-menu').filter({ visible: true });
      await expectTopRight(sectionAvatar);
      await sectionAvatar.click();
      await expect(page.getByTestId('user-sheet')).toBeVisible();
      await expect(page.getByTestId('user-sheet-name')).toBeVisible();
      await page.getByTestId('user-sheet-close').click();
      await expect(page.getByTestId('user-sheet')).toHaveCount(0);
    });
  });
}
