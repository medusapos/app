import { expect, type Page } from '@playwright/test';
import { addE2E1, backend, captureCommands, cartLineQuantity, cartTab, closeStoreRegister, expectSwitchThumbInTrack, openArea, openRegister, productsTab, refusedStoreOpen, signIn, test } from './helpers';

// Settings → Scanner (ADR 0016): minChars gates the phone-cart wedge listener, and the test-scan
// field judges a scan the same way, against the currently saved settings.
test.use({ viewport: { width: 360, height: 740 } });

const SECTION_LABELS = ['General', 'Tax', 'Printing', 'Card readers', 'Barcode Scanning', 'Theme', 'Register', 'Health', 'Danger zone'];

// A phone's Settings lists the sections; `section` (its label) opens that section's own page from the list.
async function openSettings(page: Page, section?: string) {
  await openArea(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  if (!section) return;
  await page.getByTestId('settings-list').getByRole('button', { name: section, exact: true }).click();
  await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible();
}

// A section page is its own history entry: the first back returns to the list, the second leaves Settings.
async function leaveSettings(page: Page) {
  await page.goBack();
  await expect(page.getByTestId('settings-list')).toBeVisible();
  await page.goBack();
}

async function setMinChars(page: Page, value: string) {
  await page.getByLabel('Minimum characters', { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}

async function openCart(page: Page) {
  await cartTab(page).click();
  await expect(cartTab(page)).toHaveAttribute('aria-selected', 'true');
}

test('a saved minChars gates the wedge scan, and the test-scan field reports its verdict', async ({ page }) => {
  await signIn(page);
  await addE2E1(page);

  await openSettings(page, 'Barcode Scanning');
  await setMinChars(page, '6');
  await leaveSettings(page);

  await openCart(page);
  await page.keyboard.type('E2E-2', { delay: 10 });
  await page.keyboard.press('Enter');
  await expect(page.getByText('E2E product 2', { exact: true })).toHaveCount(0);

  await productsTab(page).click();
  await openSettings(page, 'Barcode Scanning');
  await setMinChars(page, '3');
  const testField = page.getByLabel('Test scan here', { exact: true });
  await testField.pressSequentially('E2E-2', { delay: 10 });
  await testField.press('Enter');
  await expect(page.getByText('Counts as a scan', { exact: true })).toBeVisible();
  await leaveSettings(page);

  await openCart(page);
  await page.keyboard.type('E2E-2', { delay: 10 });
  await page.keyboard.press('Enter');
  await expect(cartLineQuantity(page, 'E2E product 2')).toHaveText('1');
});

test('scanner affixes are stripped in the test field and cart, with sound enabled', async ({ page }) => {
  await signIn(page);
  await addE2E1(page);
  await openSettings(page, 'Barcode Scanning');
  await page.getByLabel('Scanner prefix', { exact: true }).fill('#');
  await page.getByLabel('Scanner suffix', { exact: true }).fill('!');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const testField = page.getByLabel('Test scan here', { exact: true });
  await testField.pressSequentially('#E2E-2!', { delay: 10 });
  await testField.press('Enter');
  await expect(page.getByText(/^Last scan: E2E-2 · 5 characters/)).toBeVisible();
  await expect(page.getByText('Counts as a scan', { exact: true })).toBeVisible();
  const sound = page.getByRole('switch', { name: 'Play a sound on scan' });
  await sound.click();
  await expect(sound).toBeChecked();
  await leaveSettings(page);
  await openCart(page);
  await page.keyboard.type('#E2E-2!', { delay: 10 });
  await page.keyboard.press('Enter');
  await expect(cartLineQuantity(page, 'E2E product 2')).toHaveText('1');
});

// The same minChars is the Products search's minCodeLength (TallyUI #148): below it, Enter does no code lookup.
test('a saved minChars gates Enter in the Products search: a shorter code stays a search', async ({ page }) => {
  await signIn(page);
  const search = page.getByPlaceholder('Search or scan barcode / SKU', { exact: true });

  await openSettings(page, 'Barcode Scanning');
  await setMinChars(page, '6');
  await leaveSettings(page);
  await search.fill('E2E-2');
  await search.press('Enter');
  await expect(search).toHaveValue('E2E-2');
  await expect(page.getByRole('tab', { name: 'Cart, New', exact: true })).toBeVisible();

  await openSettings(page, 'Barcode Scanning');
  await setMinChars(page, '3');
  await leaveSettings(page);
  await search.fill('E2E-2');
  await search.press('Enter');
  await expect(search).toHaveValue('');
  await expect(cartTab(page)).toBeVisible();
  await expect(cartTab(page)).toHaveAccessibleName(/^Cart, 1 item$/);
});

// Settings → Register (ADR 0016): the till name is the deviceName of this till's register v2 opens (ADR-078), so another
// till that finds Register 1 open is told "Front counter", not the platform label.
test('a till named in Settings opens Register 1 under that name at the store', async ({ page }) => {
  const opens = captureCommands<{ deviceName?: string }>(page, 'register.session.open');
  await signIn(page, 'Europe', false);
  await openSettings(page, 'Register');
  const tillName = page.getByLabel('Till name', { exact: true });
  await tillName.fill('Front counter');
  await page.getByRole('button', { name: 'Save till name', exact: true }).click();
  await leaveSettings(page);
  try {
    await openRegister(page);
    expect(opens.map(({ payload }) => payload.deviceName)).toEqual(['Front counter']);
    expect(await refusedStoreOpen()).toMatchObject({ deviceName: 'Front counter' });

    // An empty name goes back to the platform label.
    await openSettings(page, 'Register');
    await expect(tillName).toHaveValue('Front counter');
    await tillName.fill('');
    await page.getByRole('button', { name: 'Save till name', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Register', exact: true })).toBeVisible();
    await expect(tillName).toHaveValue('');
  } finally {
    await closeStoreRegister();
  }
});

// The frame's Sale goes back to the Products screen under Settings: a replace mounted a second, empty one over it,
// hiding the sale in progress (and any pending save) behind a fresh cart.
test('the frame\'s Sale from Settings returns to the same sale, with one Products screen mounted', async ({ page }) => {
  await signIn(page);
  await addE2E1(page);
  const cart = cartTab(page);
  await expect(cart).toBeVisible();
  await expect(cart).toHaveAccessibleName(/^Cart, 1 item$/);

  await openSettings(page);
  await openArea(page, 'POS');
  await expect(page.getByRole('heading', { name: / · Register 1$/ })).toBeVisible();
  await expect(cart).toBeVisible();
  await expect(cart).toHaveAccessibleName(/^Cart, 1 item$/);
  // Hidden stack screens stay in the DOM, so this counts every mounted Products screen.
  await expect(page.getByPlaceholder('Search or scan barcode / SKU', { exact: true })).toHaveCount(1);
  await expect(cart).not.toHaveAccessibleName('Cart, New');
});

// v2's phone Settings: the section names in a list, each opening its own page, with browser back to the list.
test('a phone lists the sections, opens each on its own page, and back returns to the list', async ({ page }) => {
  await signIn(page);
  await openSettings(page);
  const list = page.getByTestId('settings-list');
  await expect(list.getByRole('button')).toHaveText(SECTION_LABELS);
  await list.getByRole('button', { name: 'Tax', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tax', exact: true })).toBeVisible();
  await expect(page.getByTestId('settings-tax')).toBeVisible();
  await expect(page).toHaveURL(/section=tax/);
  await page.getByTestId('settings-back').click();
  await expect(list).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

  await list.getByRole('button', { name: 'Printing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Printing', exact: true })).toBeVisible();
  await expect(page.getByTestId('settings-printing')).toBeVisible();
  await page.goBack();
  await expect(list).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
});

test('opening /settings directly by URL still lands back on the sale', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await openArea(page, 'POS');
  await expect(page.getByRole('heading', { name: / · Register 1$/ })).toBeVisible();
});

test('Theme: Dark puts the dark class on <html> and its tokens, the first frame after a reload is dark, and System follows the browser', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await signIn(page, 'Europe', false);
  const html = page.locator('html');
  await expect(html).toHaveClass(/(^|\s)light(\s|$)/);
  await openSettings(page, 'Theme');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.getByTestId('theme-tile-dark')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('theme-tile-light')).toHaveAttribute('aria-selected', 'false');
  await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  await expect(html).not.toHaveClass(/(^|\s)light(\s|$)/);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim())).toBe('#0d1117');
  expect(await page.evaluate(() => localStorage.getItem('medusapos.theme'))).toBe('dark');

  await page.addInitScript(() => {
    const themeFrames = (window as Window & { themeFrames: string[] }).themeFrames = [];
    let frames = 0;
    function record() {
      if (document.getElementById('splash') === null) themeFrames.push(document.documentElement.className);
      frames += 1;
      if (frames < 600) requestAnimationFrame(record);
    }
    requestAnimationFrame(record);
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Theme', exact: true })).toBeVisible();
  await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  // The next animation frame may not have run yet, so wait for the first recorded frame.
  await expect.poll(() => page.evaluate(() => (window as Window & { themeFrames: string[] }).themeFrames.length)).toBeGreaterThan(0);
  const themeFrames = await page.evaluate(() => (window as Window & { themeFrames: string[] }).themeFrames);
  expect(themeFrames.some((classes) => /(^|\s)light(\s|$)/.test(classes))).toBe(false);

  await page.getByRole('button', { name: 'System', exact: true }).click();
  await expect(html).toHaveClass(/(^|\s)light(\s|$)/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveClass(/(^|\s)dark(\s|$)/);
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(html).toHaveClass(/(^|\s)light(\s|$)/);
  expect(await page.evaluate(() => localStorage.getItem('medusapos.theme'))).toBe('light');
});

test("Theme: Light draws the selected rail entry in v2's navy, and Dark keeps TallyUI's", async ({ page }) => {
  const token = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-rail-selected-foreground').trim());
  await page.emulateMedia({ colorScheme: 'light' });
  await signIn(page, 'Europe', false);
  await expect(page.locator('html')).toHaveClass(/(^|\s)light(\s|$)/);
  await expect.poll(token).toBe('#26365e');
  // The phone drawer labels its entries; the selected one (POS) draws its label in the token's colour.
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const selected = page.getByRole('navigation', { name: 'Main' }).locator('[data-testid^="nav-item-"][aria-current="page"]');
  await expect(selected).toHaveCount(1);
  await expect(selected.getByText('POS', { exact: true })).toHaveCSS('color', 'rgb(38, 54, 94)');

  // The drawer is open, so go to Settings › Theme from it.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('settings-list').getByRole('button', { name: 'Theme', exact: true }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
  await expect.poll(token).toBe('#818cf8');
});

test('Scale: Regular is the default, Auto persists after reload, and Regular restores the default size', async ({ page }) => {
  await signIn(page, 'Europe', false);
  await openSettings(page, 'Theme');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-base').trim())).toBe('14px');
  await expect(page.getByTestId('scale-choice-regular')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('scale-choice-auto').click();
  await expect(page.getByTestId('scale-choice-auto')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-base').trim())).toBe('13px');
  expect(await page.evaluate(() => localStorage.getItem('medusapos.scale'))).toBe('auto');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Theme', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-base').trim())).toBe('13px');
  await expect(page.getByTestId('scale-choice-auto')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('scale-choice-regular').click();
  await expect(page.getByTestId('scale-choice-regular')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--text-base').trim())).toBe('14px');
  expect(await page.evaluate(() => localStorage.getItem('medusapos.scale'))).toBe('regular');
});

test.describe('at 1280 × 800', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('Settings\' switch thumbs sit inside their tracks at 1280 wide, at the start off and the end on', async ({ page }) => {
    await signIn(page);
    await openArea(page, 'Settings');
    for (const [nav, id] of [['store', 'settings-default-customer-is-cashier'], ['printing', 'settings-printing-auto-print'],
      ['scanner', 'settings-scanner-sound']]) {
      await page.getByTestId(`settings-nav-${nav}`).click();
      const sw = page.getByTestId(id);
      await sw.scrollIntoViewIfNeeded();
      const was = (await sw.getAttribute('aria-checked')) === 'true';
      await expectSwitchThumbInTrack(sw);
      await sw.click();
      await expect(sw).toHaveAttribute('aria-checked', String(!was));
      await expectSwitchThumbInTrack(sw);
      await sw.click();
      await expect(sw).toHaveAttribute('aria-checked', String(was));
      await expectSwitchThumbInTrack(sw);
    }
  });

  // Row 15a: v2's General, flat rows in the one section card, each value in a column right after its label.
  test('General\'s groups are flat in the section card, each value starting within 320 px of its label', async ({ page }) => {
    await signIn(page);
    await openArea(page, 'Settings');
    await page.getByTestId('settings-nav-store').click();
    const card = page.getByTestId('settings-section-card');
    const rows = [['Store name', 'settings-store-name'], ['Currency', 'settings-store-currency'],
      ['Stock location', 'settings-store-location'], ['Sales channel', 'settings-store-sales-channel'],
      ['Default customer', 'settings-default-customer-field'], ['Default customer is cashier', 'settings-default-customer-is-cashier'],
      ['Symbol', 'settings-currency-symbol'], ['Symbol position', 'settings-currency-position'],
      ['Thousands separator', 'settings-currency-thousands'], ['Decimal separator', 'settings-currency-decimal'],
      ['Number of decimals', 'settings-currency-decimals'], ['Example', 'settings-currency-example'], ['Send feedback', 'settings-feedback-link']];
    for (const [label, value] of rows) {
      const labelBox = (await card.getByText(label, { exact: true }).boundingBox())!;
      const valueBox = (await card.getByTestId(value).boundingBox())!;
      expect(valueBox.x, `${label}: the value starts after its label`).toBeGreaterThanOrEqual(labelBox.x + labelBox.width);
      expect(valueBox.x - labelBox.x, `${label}: the value sits beside its label`).toBeLessThanOrEqual(320);
    }
    // The "Open ↗" follows its value on the same line.
    const value = (await card.getByTestId('settings-store-name').boundingBox())!;
    const open = (await card.getByTestId('settings-store-name-admin').boundingBox())!;
    expect(open.x).toBeGreaterThanOrEqual(value.x + value.width);
    expect(Math.abs((open.y + open.height / 2) - (value.y + value.height / 2))).toBeLessThan(4);
    // No box inside the card: nothing in it but an input or button draws a border (TallyUI's box is an inner View).
    const bordered = await card.evaluate((root) => Array.from(root.querySelectorAll('*')).filter((el) => {
      if (el.closest('input, textarea, button, [role="button"], [role="switch"]')) return false;
      const style = getComputedStyle(el);
      return parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none' && style.borderTopColor !== 'rgba(0, 0, 0, 0)';
    }).map((el) => el.getAttribute('data-testid') ?? el.className));
    expect(bordered).toEqual([]);
  });

  // Desktop Chromium has WebHID and Web Serial, so "Direct connection" renders; its value sits in the switch's column.
  test('Barcode Scanning\'s "Direct connection" value starts in the same column as "Play a sound on scan"\'s switch', async ({ page }) => {
    await signIn(page);
    await openArea(page, 'Settings');
    await page.getByTestId('settings-nav-scanner').click();
    const direct = page.getByTestId('settings-section-card').getByTestId('settings-scanner-direct');
    await direct.scrollIntoViewIfNeeded();
    const label = (await direct.getByText('Direct connection', { exact: true }).boundingBox())!;
    const button = direct.getByRole('button', { name: 'Connect a scanner directly (advanced)' });
    const buttonBox = (await button.boundingBox())!;
    expect(buttonBox.x, 'the button starts after its label').toBeGreaterThanOrEqual(label.x + label.width);
    expect(buttonBox.x - label.x, 'the button sits beside its label').toBeLessThanOrEqual(320);
    // The value (the "None" note, then the button) starts where the switch above it does.
    const value = (await button.locator('xpath=..').boundingBox())!;
    const sound = (await page.getByTestId('settings-scanner-sound').boundingBox())!;
    expect(Math.abs(value.x - sound.x), 'the value starts in the switch\'s column').toBeLessThanOrEqual(4);
  });
});

// Settings › Health (AUDIT 27): what this till talks to, what it holds, and its recent warnings and errors.
test('Health shows the store URL, plugin contract, storage used, waiting sales and the log view', async ({ page }) => {
  await signIn(page);
  await openSettings(page, 'Health');
  await expect(page.getByTestId('settings-health-store-url')).toHaveText(backend);
  await expect(page.getByTestId('settings-health-plugin-contract')).toHaveText(/^\d+$/);
  // Chromium has navigator.storage.estimate.
  await expect(page.getByTestId('settings-health-storage')).toHaveText(/^\d+(\.\d)? (B|KB|MB|GB)$/);
  await expect(page.getByTestId('settings-health-sales-pending')).toHaveText('0');
  await expect(page.getByTestId('settings-health-logs-empty').or(page.getByTestId('settings-health-log-line').first())).toBeVisible();
  await expect(page.getByTestId('settings-health-copy')).toBeVisible();
});

// Settings › Card readers (ready item 24): the till's region's terminal providers, each Not paired. The e2e store's only
// provider is Manual payment, so the second half adds a Stripe terminal row to the real answer.
test('Card readers: reads the till\'s region\'s providers; a terminal provider reads Not paired', async ({ page }) => {
  await signIn(page);
  const read = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith('/tally/v1/payment-providers'));
  await openSettings(page, 'Card readers');
  expect((await read).url()).toContain('region_id=');
  await expect(page.getByTestId('settings-payment-providers')).toContainText('Manual payment');
  await expect(page.getByTestId('settings-card-readers-how')).toContainText('No card readers');
  await expect(page.getByTestId(/^settings-card-reader-pp_/)).toHaveCount(0);

  const providers = (url: URL) => url.pathname.endsWith('/tally/v1/payment-providers');
  await page.route(providers, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, providers: [...body.providers,
      { id: 'pp_stripe_stripe', name: 'Stripe', tillCanTake: false, terminal: true }] } });
  });
  try {
    await page.goBack();
    await expect(page.getByTestId('settings-list')).toBeVisible();
    await page.getByTestId('settings-list').getByRole('button', { name: 'Card readers', exact: true }).click();
    await expect(page.getByTestId('settings-card-reader-pp_stripe_stripe')).toContainText('Stripe');
    await expect(page.getByTestId('settings-card-reader-pp_stripe_stripe-state')).toHaveText('Not paired');
    await expect(page.getByTestId('settings-payment-provider-pp_stripe_stripe')).toHaveCount(0);
  } finally {
    await page.unroute(providers);
  }
});

// #660 item 5: from 600 px (where the actions leave the phone stack) up, each receipt template's printer select and
// Preview stay inside their row and the card, clear of the template name, with no horizontal scroll. Flat rows (768 up)
// keep v2's convention, the actions starting beside the name, and the select keeps its full 224 px wherever it fits.
test('Printing: each receipt template\'s printer select and Preview fit their row from 600 to 1440 wide', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await signIn(page);
  await openArea(page, 'Settings');
  const card = page.getByTestId('settings-receipt-templates');
  const inside = (box: { x: number; y: number; width: number; height: number }, outer: typeof box) =>
    box.x >= outer.x - 1 && box.y >= outer.y - 1 && box.x + box.width <= outer.x + outer.width + 1 && box.y + box.height <= outer.y + outer.height + 1;
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
  for (const width of [1440, 1024, 900, 800, 768, 700, 600]) {
    await page.setViewportSize({ width, height: 900 });
    if (width >= 768) await page.getByTestId('settings-nav-printing').click();
    else {
      // Below 768 the split gives way to the phone's list, or to the Printing page it opened.
      await expect(page.getByTestId('settings-nav')).toHaveCount(0);
      const list = page.getByTestId('settings-list');
      await expect(list.or(card).filter({ visible: true }).first()).toBeVisible();
      if (!(await card.isVisible())) await list.getByRole('button', { name: 'Printing', exact: true }).click();
    }
    await expect(card).toBeVisible();
    for (const [id, name, tag] of [['standard', 'Standard Receipt', 'Sales'], ['thermal-80mm', 'Thermal Receipt (80mm)', 'Thermal 80mm'],
      ['thermal-58mm', 'Thermal Receipt (58mm)', 'Thermal 58mm']]) {
      const row = page.getByTestId(`settings-receipt-template-${id}`);
      await row.scrollIntoViewIfNeeded();
      const [rowBox, cardBox, nameBox] = [(await row.boundingBox())!, (await card.boundingBox())!, (await row.getByText(name, { exact: true }).boundingBox())!];
      // Squeezed out by the actions, the name wraps letter by letter in a column 0 px wide.
      expect.soft(nameBox.height, `${width} px: ${id}'s name keeps to two lines`).toBeLessThanOrEqual(40);
      const [badgeBox, selectBox] = [(await row.getByText(tag, { exact: true }).boundingBox())!,
        (await page.getByTestId(`settings-receipt-template-${id}-printer`).boundingBox())!];
      if (width >= 768) expect.soft(badgeBox.x - nameBox.x, `${width} px: ${id}'s actions sit beside its name`).toBeLessThanOrEqual(320);
      if (width >= 900) expect.soft(Math.abs(selectBox.width - 224), `${width} px: ${id}'s select keeps 224 px`).toBeLessThanOrEqual(1);
      for (const part of id === 'standard' ? ['printer'] : ['printer', 'preview']) {
        const box = (await page.getByTestId(`settings-receipt-template-${id}-${part}`).boundingBox())!;
        expect.soft(inside(box, rowBox), `${width} px: ${id} ${part} lies inside its row`).toBe(true);
        expect.soft(inside(box, cardBox), `${width} px: ${id} ${part} lies inside the card`).toBe(true);
        expect.soft(overlaps(box, nameBox), `${width} px: ${id} ${part} clears the template name`).toBe(false);
      }
    }
    expect.soft(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} px: no horizontal scroll`).toBe(true);
  }
});
