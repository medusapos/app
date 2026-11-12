import { expect } from '@playwright/test';
import { openArea, signIn, test } from './helpers';

// The app frame: the rail beside every signed-in area at 1440 x 900, the drawer behind the header's Menu at 390 x 844.
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`at ${viewport.width} × ${viewport.height}`, () => {
    test.use({ viewport });
    const wide = viewport.width >= 768;

    test('the frame reaches Orders, Reports, Settings and back to the sale', async ({ page }) => {
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
      for (const [area, path] of [['Orders', /\/orders$/], ['Reports', /\/reports$/], ['Settings', /\/settings$/]] as const) {
        await openArea(page, area);
        await expect(page).toHaveURL(path);
        await expect(page.getByRole('heading', { name: area, exact: true })).toBeVisible();
        await expect(page.getByTestId('nav-drawer')).toHaveCount(0);
      }
      await openArea(page, 'Sale');
      await expect(page.getByRole('heading', { name: 'Products', exact: true })).toBeVisible();
      // Back to the sale dismisses to it: one Products screen is mounted (hidden stack screens stay in the DOM).
      await expect(page.getByPlaceholder('Search or scan barcode / SKU', { exact: true })).toHaveCount(1);
    });
  });
}
