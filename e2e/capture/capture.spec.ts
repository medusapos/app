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
// Each size runs in its own worker, and a capture may run in parts (CAPTURE_ROWS): the index in the output folder is the
// merge state, so a part keeps every other row's cells, and a folder with no index starts afresh.
const index = path.join(out, 'README.md');
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
  // A phone shows a count in progress (row 09e) in place of the products.
  const count = page.getByTestId('register-count');
  await expect(page.getByText(/Up to date · \d+ products/).or(pane).or(newSale).or(count).first()).toBeVisible({ timeout: 60_000 });
  if (await page.getByTestId('closure-done').isVisible()) await page.getByTestId('closure-done').click();
  if (await visibleText(page) === 'Counting') await finishClose(page);
  if (await page.getByTestId('view-toggle-grid').isVisible()) await page.getByTestId('view-toggle-grid').click();
  // Right after a reload the header reads "Closed" until the till has loaded its open session; only a state that
  // lasts means the register is really closed. No condition tells the two apart: a loading session reads "Closed" too,
  // and the header can go blank and back to "Closed" while it loads, so a wait that ends on the first other reading
  // reopened an open register (a full run, 2026-11-23). Hence a fixed 5 s. An unbound till (row 09a) shows the picker
  // in place of the cart, so this comes before the cart is cleared.
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
  // A sale left over fails this row here rather than showing in the next shots.
  if (phone && await cartTab(page).isVisible()) await cartTab(page).click();
  await expect(empty).toBeVisible();
  await expect(page.getByTestId(/^open-sale-tab-.*-who$/)).toHaveCount(0);
  if (phone && await productsTab(page).isVisible()) await productsTab(page).click();
  await expect(page.getByText(/Up to date · \d+ products/)).toBeVisible();
  // The category stays chosen across a reload (row 02e picks Drinks).
  const all = page.getByRole('radiogroup', { name: 'Categories' }).getByRole('radio', { name: 'All products', exact: true });
  if (await all.isVisible() && !await all.isChecked()) await all.click();
  if (await all.isVisible()) await expect(all).toBeChecked();
}

async function shoot(page: Page, row: CaptureRow, size: Size) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  // The pointer rests on the header's top edge, so no hover state or tooltip (a rail's "Orders") shows in the shot.
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
  await page.mouse.move(Math.round(viewport.width / 2), 1);
  // Sheets and menus slide in, some driven by script rather than CSS, so the shot is taken once two frames in a row
  // match. Something that never stops moving (a spinner) is shot as it is after 3 s.
  let shot = await page.screenshot({ type: 'jpeg', quality: 70 });
  for (const until = Date.now() + 3_000; Date.now() < until;) {
    const next = await page.screenshot({ type: 'jpeg', quality: 70 });
    if (next.equals(shot)) break;
    shot = next;
  }
  writeFileSync(path.join(out, `${row.id}-${size}.jpg`), shot);
}

const escape = (text: string) => text.replace(/\|/g, '\\|');
const link = (row: CaptureRow, size: Size) => `[${size}](${row.id}-${size}.jpg)`;

// The outcomes in an existing index: per row, per size, 'shot' for a link, else the cell's text.
function readIndex(): Record<string, Partial<Record<Size, string>>> {
  const state: Record<string, Partial<Record<Size, string>>> = {};
  if (!existsSync(index)) return state;
  for (const line of readFileSync(index, 'utf8').split('\n')) {
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim());
    const row = rows.find(candidate => candidate.id === cells[0]);
    if (!row || cells.length !== 3 + SIZES.length) continue;
    state[row.id] = Object.fromEntries(SIZES.map((size, i) =>
      [size, cells[3 + i] === link(row, size) ? 'shot' : cells[3 + i].replace(/\\\|/g, '|')]));
  }
  return state;
}

// The commit the shots were taken at, "dirty" when the tree differs from it (the output folder aside).
function commit() {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const inside = path.relative(root, out);
  const exclude = inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? [`:(exclude)${inside}`] : [];
  const dirty = git('status', '--porcelain', '--', '.', ...exclude) !== '';
  return `${git('rev-parse', '--short', 'HEAD')}${dirty ? ' dirty' : ''}`;
}

function writeIndex() {
  if (!ranSize) return;
  const state = readIndex();
  for (const [id, outcome] of Object.entries(outcomes)) state[id] = { ...state[id], [ranSize]: outcome };
  const cell = (row: CaptureRow, size: Size) => {
    const outcome = state[row.id]?.[size];
    return outcome === 'shot' ? link(row, size) : escape(outcome ?? '—');
  };
  const listed = rows.filter(row => state[row.id]);
  const shots = listed.reduce((count, row) => count + SIZES.filter(size => state[row.id]?.[size] === 'shot').length, 0);
  const tallyui = JSON.parse(readFileSync(path.join(root, 'apps/expo/package.json'), 'utf8')).dependencies['@tallyui/components'];
  writeFileSync(index, [
    '# MedusaPOS capture',
    '',
    `Taken ${new Date().toISOString().slice(0, 10)} at \`${commit()}\` with TallyUI ${tallyui}, by \`pnpm capture\` against the throwaway e2e store (e2e/README.md). ${shots} shots.`,
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
