import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { cartTab, openRegister, productsTab, signIn, test } from '../helpers';
import { finishClose, rows, type CaptureRow, type Size } from './rows';

// One shot per DEMO-PARITY row and size (e2e/README.md, Capture). CAPTURE_ROWS picks rows; CAPTURE_OUT is the folder.
const root = path.resolve(__dirname, '../..');
const out = path.resolve(root, process.env.CAPTURE_OUT || 'e2e/.tmp/capture');
const wanted = process.env.CAPTURE_ROWS?.split(',').map(id => id.trim()).filter(Boolean);
const unknown = wanted?.filter(id => !rows.some(row => row.id === id)) ?? [];
if (unknown.length) throw new Error(`CAPTURE_ROWS names no row ${unknown.join(', ')}`);
// These close the register, so they go last.
const LAST = ['09e', '09f', '13b'];
const selected = rows.filter(row => !wanted || wanted.includes(row.id));
const order = [...selected.filter(row => !LAST.includes(row.id)), ...LAST.flatMap(id => selected.filter(row => row.id === id))];
const SIZES: Size[] = ['desktop', 'tablet', 'phone'];
// Each size runs in its own worker, and a long capture may run in parts (CAPTURE_ROWS); the outcomes behind the index
// are kept outside the output folder and merged, and start afresh with a folder that has no index yet.
const index = path.join(out, 'README.md');
const statePath = path.join(root, 'e2e/.tmp/capture-index', `${out.replace(/[^\w.-]+/g, '_')}.json`);
const outcomes: Partial<Record<string, string>> = {};
let ranSize: Size | undefined;

test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

const headerState = (page: Page) => page.getByTestId('header-register-state');
// The state can go between the two reads (a session loading), so the read does not wait.
const visibleText = async (page: Page) => await headerState(page).isVisible()
  ? headerState(page).textContent({ timeout: 1_000 }).catch(() => null) : null;

// Pays what the open tender still owes, then starts a new sale.
async function pay(page: Page) {
  const complete = page.getByTestId('tender-complete');
  if (!await complete.isEnabled()) {
    await page.getByTestId('tender-quick-exact').click();
    await page.getByTestId('tender-take').click();
  }
  await complete.click();
  await page.getByRole('button', { name: 'New sale', exact: true }).click();
}

// Back to a signed-in, open, empty Sale: online, reloaded, every open sale voided (or paid, once it has a payment).
async function reset(page: Page, size: Size) {
  const phone = size === 'phone';
  await page.context().setOffline(false);
  await page.goto('/');
  const signInHeading = page.getByRole('heading', { name: 'Sign in', exact: true });
  const pane = page.getByTestId('tender-pane');
  const newSale = page.getByRole('button', { name: 'New sale', exact: true });
  await expect(signInHeading.or(page.getByTestId('user-menu')).or(pane).or(newSale).first()).toBeVisible({ timeout: 60_000 });
  if (await signInHeading.isVisible()) await signIn(page, 'Europe', false);
  await expect(page.getByText(/Up to date · \d+ products/).or(pane).or(newSale).first()).toBeVisible({ timeout: 60_000 });
  if (await page.getByTestId('closure-done').isVisible()) await page.getByTestId('closure-done').click();
  if (await visibleText(page) === 'Counting') await finishClose(page);
  if (await page.getByTestId('view-toggle-grid').isVisible()) await page.getByTestId('view-toggle-grid').click();
  // Right after a reload the header reads "Closed" until the till has loaded its open session; only a state that
  // lasts means the register is really closed. An unbound till (row 09a) shows the picker in place of the cart, so this
  // comes before the cart is cleared.
  const closed = async () => ['Closed', 'Choose register'].includes(await visibleText(page) ?? '');
  if (await closed()) await page.waitForTimeout(5_000);
  const state = await visibleText(page);
  if (await closed()) await openRegister(page, '100.00', true, state === 'Choose register');
  const empty = page.getByTestId('cart-empty');
  const more = page.getByTestId('cart-foot-more');
  for (let i = 0; i < 8; i++) {
    if (phone && await cartTab(page).isVisible()) await cartTab(page).click();
    await expect(newSale.or(pane).or(empty).or(more).first()).toBeVisible();
    if (await newSale.isVisible()) await newSale.click();
    else if (await pane.isVisible()) await pay(page);
    else if (await empty.isVisible()) {
      const parked = page.getByTestId(/^open-sale-tab-.*-who$/).first();
      if (!await parked.isVisible()) break;
      await parked.click();
    } else {
      await more.click();
      const menu = page.getByTestId('cart-foot-menu');
      await expect(menu.getByRole('menuitem', { name: 'Order details', exact: true })).toBeVisible();
      const voidItem = menu.getByRole('menuitem', { name: 'Void', exact: true });
      if (await voidItem.isVisible()) {
        await voidItem.click();
        await page.getByTestId('cart-void-confirm').click();
      } else {
        await page.keyboard.press('Escape');
        await page.getByTestId('cart-checkout').click();
        await pay(page);
      }
    }
  }
  if (phone && await productsTab(page).isVisible()) await productsTab(page).click();
  await expect(page.getByText(/Up to date · \d+ products/)).toBeVisible();
}

async function shoot(page: Page, row: CaptureRow, size: Size) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  // Sheets and menus slide in; let them settle.
  await page.waitForTimeout(400);
  writeFileSync(path.join(out, `${row.id}-${size}.jpg`), await page.screenshot({ type: 'jpeg', quality: 70 }));
}

const escape = (text: string) => text.replace(/\|/g, '\\|');

function writeIndex() {
  if (!ranSize) return;
  const state: Record<string, Partial<Record<Size, string>>> = existsSync(index) && existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  for (const [id, outcome] of Object.entries(outcomes)) state[id] = { ...state[id], [ranSize]: outcome };
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 1));
  const cell = (row: CaptureRow, size: Size) => {
    const outcome = state[row.id]?.[size];
    return outcome === 'shot' ? `[${size}](${row.id}-${size}.jpg)` : escape(outcome ?? '—');
  };
  const listed = rows.filter(row => state[row.id]);
  const shots = listed.reduce((count, row) => count + SIZES.filter(size => state[row.id]?.[size] === 'shot').length, 0);
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const tallyui = JSON.parse(readFileSync(path.join(root, 'apps/expo/package.json'), 'utf8')).dependencies['@tallyui/components'];
  writeFileSync(index, [
    '# MedusaPOS capture',
    '',
    `Taken ${new Date().toISOString().slice(0, 10)} at \`${sha}\` with TallyUI ${tallyui}, by \`pnpm capture\` against the throwaway e2e store (e2e/README.md). ${shots} shots.`,
    '',
    '| Row | Screen | State | Desktop 1280×800 | Tablet 1024×768 | Phone 390×844 |',
    '|---|---|---|---|---|---|',
    ...listed.map(row => `| ${row.id} | ${escape(row.title)} | ${escape(row.state)} | ${SIZES.map(size => cell(row, size)).join(' | ')} |`),
    '',
  ].join('\n'));
}

test.afterAll(writeIndex);

// Each project's grep (e2e/capture/playwright.config.ts) keeps only the test of its own size.
for (const size of SIZES) {
  test(`capture ${size}`, async ({ page }) => {
    ranSize = size;
    mkdirSync(out, { recursive: true });
    await signIn(page);
    let fresh = true;
    for (const row of order) {
      if (row.skip) outcomes[row.id] = size === 'desktop' ? `skipped: ${row.skip}` : '—';
      else if (row.only && !row.only.includes(size)) outcomes[row.id] = '—';
      else {
        try {
          await test.step(`${row.id} ${row.title}`, async () => {
            if (!fresh) await reset(page, size);
            fresh = false;
            await row.reach(page, size);
            await shoot(page, row, size);
          });
          outcomes[row.id] = 'shot';
        } catch (error) {
          outcomes[row.id] = `failed: ${String(error instanceof Error ? error.message : error).replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0]}`;
        }
      }
    }
    writeIndex();
    expect(Object.entries(outcomes).filter(([, outcome]) => outcome?.startsWith('failed:'))).toEqual([]);
  });
}
