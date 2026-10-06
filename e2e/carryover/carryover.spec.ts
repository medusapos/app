import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { addE2E1, adminToken, createAdminCustomer, cspViolations, discount, ordersByClientId, sellBySku, signIn, test } from '../helpers';
import { E2E_RUN } from '../ports';

const root = resolve(__dirname, '../..');
const backendUrl = `http://localhost:${E2E_RUN.backendPort}`;
const appUrl = `http://localhost:${E2E_RUN.appPort}`;
const released = resolve(root, 'e2e/.tmp/carryover/released');
const current = resolve(root, 'e2e/.tmp/carryover/current');
// @tallyui/pos 2.0.0 wrote these versions; 3.3.0 migrates orders to v8 with these outputs.
const RELEASE_EXPECTATIONS: Record<string, {
  stored: { name: string; version: number }[];
  orderVersion: number; sentVersion: number; discountedSentVersion: number;
  taxRounding: { granularity: string; mode: string };
}> = {
  'v0.1.0': {
    stored: [
      { name: 'cash_movements', version: 0 }, { name: 'closures', version: 0 },
      { name: 'pos_orders', version: 2 }, { name: 'register_sessions', version: 0 },
    ],
    orderVersion: 8, sentVersion: 1, discountedSentVersion: 2,
    taxRounding: { granularity: 'per_order', mode: 'half_away_from_zero' },
  },
};
// These 3.2.x bases wrote pos_orders v7 and use the v8 identity-migration proof.
const TALLYUI_32X_BASES = ['c2db7b2b0107505865c51bf6798b296c2c661c25'];
type Dump = {
  rxdbVersion: string; stored: { name: string; version: number }[];
  docs: Record<'pos_orders' | 'register_sessions' | 'cash_movements' | 'closures' | 'drafts', Record<string, any>[]>;
  register: { stores: Record<string, { register_id: string; register_name: string }> } | null;
};

function serve(dir: string) {
  const child = spawn(process.execPath, ['e2e/serve.mjs'], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, E2E_APP_PORT: String(E2E_RUN.appPort), E2E_APP_ROOT: dir },
  });
  return {
    ready: () => expect.poll(async () => {
      if (child.exitCode !== null) throw new Error(`App server exited with ${child.exitCode}`);
      return fetch(appUrl).then(response => response.status, () => 0);
    }).toBe(200),
    stop: async () => {
      child.kill();
      await expect.poll(() => new Promise<string>((done) => {
        const socket = createConnection({ host: 'localhost', port: E2E_RUN.appPort });
        socket.once('connect', () => { socket.destroy(); done('connected'); });
        socket.once('error', (error: NodeJS.ErrnoException) => done(error.code ?? 'unknown'));
      })).toBe('ECONNREFUSED');
    },
  };
}

// The CSP gate reads page events only from pages still open at the test's end, so a current-build page is gated as it closes.
async function closeGated(page: Page) {
  expect(await cspViolations(page.context()), 'Content-Security-Policy violations').toEqual([]);
  await page.close();
}

async function dump(page: Page): Promise<Dump> {
  await page.addInitScript(() => localStorage.removeItem('medusapos.session'));
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  return page.evaluate((base) => (window as unknown as {
    __medusaposDumpAppStore: (url: string) => Promise<Dump>;
  }).__medusaposDumpAppStore(base), backendUrl);
}

test('released till documents survive the web storage upgrade intact', async ({ context }) => {
  test.setTimeout(15 * 60_000);
  const releasedRef = JSON.parse(readFileSync(resolve(released, 'BUILD_REF.json'), 'utf8'));
  test.skip(TALLYUI_32X_BASES.includes(releasedRef.commit), '3.2.x bases use the pos_orders v7 to v8 carry-over test.');
  const currentRef = JSON.parse(readFileSync(resolve(current, 'BUILD_REF.json'), 'utf8'));
  expect(Object.keys(RELEASE_EXPECTATIONS),
    `Update RELEASE_EXPECTATIONS for ${releasedRef.tag} after checking the new release's schema versions and migration outputs.`,
  ).toContain(releasedRef.tag);
  const migration = RELEASE_EXPECTATIONS[releasedRef.tag];
  let server: ReturnType<typeof serve> | undefined;
  try {
    server = serve(released);
    await server.ready();
    const totals = await test.step('A: released build writes four sales and register history', async () => {
      const page = await context.newPage();
      await signIn(page);
      const sale1 = await sellBySku(page, ['E2E-1'], 'exact');
      await expect(page.getByLabel('Sync status', { exact: true })).toHaveText('All sales synced');

      await page.getByRole('button', { name: 'Open register panel', exact: true }).click();
      const panel = page.getByTestId('register-panel');
      await panel.getByTestId('register-panel-paid-in').click();
      const sheet = page.getByTestId('movement-sheet');
      await sheet.getByTestId('movement-amount').fill('5.00');
      await sheet.getByTestId('movement-reason').fill('Change for the float');
      await sheet.getByTestId('movement-confirm').click();
      await expect(sheet).toHaveCount(0);
      await panel.getByTestId('register-panel-movements').click();
      const paidIn = panel.getByText(/^Paid in · .*5[.,]00.* · Change for the float$/);
      await expect(paidIn).toBeVisible();
      await panel.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(paidIn).toHaveCount(0);
      // TallyUI 2.0.0's dialog has no Escape or overlay dismissal, so a reload closes the released panel.
      await page.reload();
      await expect(page.getByRole('button', { name: 'Open register panel', exact: true })).toBeVisible();
      await expect(panel).toHaveCount(0);

      await page.route('**/tally/v1/commands', route => route.abort());
      await addE2E1(page);
      await discount(page, 'line', 'Percent', '10');
      const sale2 = await sellBySku(page, [], 'exact');
      const sale3 = await sellBySku(page, ['E2E-2'], 'external');
      await page.getByRole('button', { name: 'Open register panel', exact: true }).click();
      await panel.getByTestId('register-panel-close').click();
      const count = page.getByTestId('register-count');
      await expect(count).toBeVisible();
      const counted = 10000 + Math.round(sale1 * 100) + Math.round(sale2 * 100);
      let remaining = counted;
      for (const face of [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1]) {
        for (; remaining >= face; remaining -= face) await count.getByTestId(`den-tile-${face}`).click();
      }
      await expect(count.getByTestId('count-amount')).toHaveValue((counted / 100).toFixed(2));
      await expect(count.getByTestId('count-variance')).toContainText('Exact');
      await count.getByTestId('count-close').click();
      const closure = page.getByTestId('closure-sheet');
      await expect(closure.getByTestId('closure-number')).toHaveText('Closure #1');
      await closure.getByTestId('closure-done').click();
      await expect(closure).toHaveCount(0);
      await page.getByTestId('open-register-amount').fill('50.00');
      await page.getByTestId('open-register-button').click();
      await expect(page.getByTestId('open-register-card')).toHaveCount(0);
      const sale4 = await sellBySku(page, ['E2E-3'], 10);
      const receiptTotals = [sale1, sale2, sale3, sale4].map(total => Math.round(total * 100));
      expect(new Set(receiptTotals).size).toStrictEqual(4);
      await page.close();
      return receiptTotals;
    });

    const OLD = await test.step('B: released store contains exactly the activity performed', async () => {
      const page = await context.newPage();
      const old = await dump(page);
      await page.close();
      expect(old.rxdbVersion).toStrictEqual(releasedRef.rxdb);
      expect(old.stored).toStrictEqual(migration.stored);
      expect(old.docs.drafts).toStrictEqual([]);
      expect(old.docs.pos_orders).toHaveLength(4);
      expect(old.docs.pos_orders.map(order => order.totalMinor).sort((a, b) => a - b))
        .toStrictEqual([...totals].sort((a, b) => a - b));
      for (const [index, total] of totals.entries()) {
        const order = old.docs.pos_orders.find(order => order.totalMinor === total)!;
        expect(order.syncStatus).toStrictEqual(index === 0 ? 'applied' : 'pending');
        expect(Object.hasOwn(order, 'sentVersion')).toStrictEqual(false);
        expect(Object.hasOwn(order, 'taxRounding')).toStrictEqual(false);
      }
      expect(old.docs.register_sessions).toHaveLength(2);
      const closed = old.docs.register_sessions.filter(session => session.status === 'closed');
      const open = old.docs.register_sessions.filter(session => session.status === 'open');
      expect(closed).toHaveLength(1);
      expect(open).toHaveLength(1);
      expect(typeof closed[0].closure_id).toStrictEqual('string');
      expect(open[0].counted_float_minor).toStrictEqual(5000);
      expect(old.docs.cash_movements).toHaveLength(2);
      expect(old.docs.cash_movements.map(movement => movement.type).sort()).toStrictEqual(['paid_in', 'void']);
      const paidIn = old.docs.cash_movements.find(movement => movement.type === 'paid_in')!;
      const reversal = old.docs.cash_movements.find(movement => movement.type === 'void')!;
      expect(paidIn.amountMinor).toStrictEqual(500);
      expect(reversal.voids).toStrictEqual(paidIn.id);
      expect(old.docs.closures).toHaveLength(1);
      expect(old.docs.closures[0].number).toStrictEqual(1);
      expect(old.docs.closures[0].session_id).toStrictEqual(closed[0].id);
      expect(closed[0].closure_id).toStrictEqual(old.docs.closures[0].id);
      expect(old.register === null).toStrictEqual(false);
      expect(old.register!.stores[backendUrl].register_id).toStrictEqual('register-1');
      expect(old.register!.stores[backendUrl].register_name).toStrictEqual('Register 1');
      return old;
    });

    await server.stop();
    server = serve(current);
    await server.ready();
    await test.step('C: whole documents equal released documents plus known migrations', async () => {
      const page = await context.newPage();
      const NEW = await dump(page);
      await closeGated(page);
      expect(NEW.rxdbVersion).toStrictEqual(currentRef.rxdb);
      expect(NEW.stored).toStrictEqual([...migration.stored.map(entry => entry.name === 'pos_orders'
        ? { name: 'pos_orders', version: migration.orderVersion } : entry.name === 'register_sessions'
          ? { ...entry, version: 1 } : entry), { name: 'register_commands', version: 0 }, { name: 'drafts', version: 0 }]
        .sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version));
      expect(NEW.docs.pos_orders).toStrictEqual(OLD.docs.pos_orders.map(order => ({
        ...order,
        taxRounding: migration.taxRounding,
        sentVersion: order.totalMinor === totals[1] ? migration.discountedSentVersion : migration.sentVersion,
      })));
      expect(NEW.docs.register_sessions).toStrictEqual(OLD.docs.register_sessions.map(session => ({
        ...session, server_session_id: session.server_session_id ?? null,
      })));
      expect(NEW.docs.cash_movements).toStrictEqual(OLD.docs.cash_movements);
      expect(NEW.docs.closures).toStrictEqual(OLD.docs.closures);
      expect(NEW.docs.drafts).toStrictEqual([]); // The released build predates parked sales.
      expect(NEW.register).toStrictEqual(OLD.register);
    });

    await test.step('D: migrated till syncs pending orders once and retains its open register', async () => {
      const page = await context.newPage();
      await signIn(page, 'Europe', false);
      const token = await adminToken();
      const pending = OLD.docs.pos_orders.filter(order => order.syncStatus === 'pending');
      expect(pending).toHaveLength(3);
      await expect.poll(async () => {
        const orders = await ordersByClientId(token);
        return pending.map(order => orders.filter(sent => sent.metadata.tally_client_id === order.id).length);
      }).toStrictEqual([1, 1, 1]);
      await expect(page.getByText('Choose a register', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Open register panel', exact: true })).toBeVisible();
      await expect(page.getByTestId('open-register-card')).toHaveCount(0);
      // RegisterPanelSheet shows LastClosureSheet only when there is no open session.
      // The poll proves "once" only when it first matches: settle the till, then count every sale again.
      await page.reload();
      await expect(page.getByText('Sales are up to date.', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: /^Orders(?: \(\d+\))?$/ }).click();
      await expect(page.getByText('· Synced', { exact: false })).toHaveCount(4);
      const settled = await ordersByClientId(token);
      expect(OLD.docs.pos_orders.map(order => settled.filter(sent => sent.metadata.tally_client_id === order.id).length))
        .toStrictEqual([1, 1, 1, 1]);
      await closeGated(page);
    });
    await test.step('E: a current-build parked draft survives reopening with its whole document intact', async () => {
      const page = await context.newPage();
      await page.goto('/login');
      await page.evaluate(() => localStorage.removeItem('medusapos.session'));
      await signIn(page, 'Europe', false);
      await addE2E1(page);
      await page.getByRole('button', { name: 'Parked sales', exact: true }).click();
      await page.getByTestId('parked-sales-park').click();
      await expect(page.getByTestId(/^parked-resume-/)).toHaveCount(1);
      const before = await dump(page);
      expect(before.docs.drafts).toHaveLength(1);
      expect(JSON.parse(before.docs.drafts[0].data).lineItems).toHaveLength(1);
      await closeGated(page);
      const reopened = await context.newPage();
      expect((await dump(reopened)).docs.drafts).toStrictEqual(before.docs.drafts);
      await closeGated(reopened);
    });
  } finally {
    await server?.stop();
  }
});

test('a 3.2.x till (pos_orders v7) upgrades to 3.3.0 (v8): sales, split payments, a parked draft and register history survive, and pending sales sync once', async ({ context }) => {
  test.setTimeout(15 * 60_000);
  const releasedRef = JSON.parse(readFileSync(resolve(released, 'BUILD_REF.json'), 'utf8'));
  const currentRef = JSON.parse(readFileSync(resolve(current, 'BUILD_REF.json'), 'utf8'));
  test.skip(!TALLYUI_32X_BASES.includes(releasedRef.commit), 'This carry-over test requires a 3.2.x base with pos_orders v7.');
  const token = await adminToken();
  const email = `carryover-${crypto.randomUUID()}@example.com`;
  const customerId = await createAdminCustomer(token, email, 'Ada', 'Lovelace');
  let server: ReturnType<typeof serve> | undefined;
  try {
    server = serve(released);
    await server.ready();
    const totals = await test.step('A: released 3.2.1 build writes three sales, split payments and a parked customer draft', async () => {
      const page = await context.newPage();
      await signIn(page);
      const sale1 = await sellBySku(page, ['E2E-1'], 'exact');
      await expect(page.getByText('Sales are up to date.', { exact: true })).toBeVisible();
      await page.route('**/tally/v1/commands', route => route.abort());
      await addE2E1(page);
      await addE2E1(page);
      await expect(page.getByText('Total', { exact: true }).locator('..')).toHaveText(/Total\D*5\.00$/);
      await page.getByRole('button', { name: 'Cash', exact: true }).click();
      await page.getByRole('button', { name: 'Split payment', exact: true }).click();
      await expect(page.getByText('Cash Tendered', { exact: true })).toHaveCount(0);
      await page.getByTestId('split-tender-method-card').click();
      await page.getByTestId('split-tender-amount').fill('2.00');
      await page.getByTestId('split-tender-add-button').click();
      await expect(page.getByTestId('split-tender-summary')).toContainText('Remaining: €3.00');
      await page.getByTestId('split-tender-method-cash').click();
      await page.getByTestId('split-tender-amount').fill('5.00');
      await page.getByTestId('split-tender-add-button').click();
      await expect(page.getByTestId('split-tender-summary')).toContainText('Change: €2.00');
      await page.getByTestId('split-tender-complete').click();
      await expect(page.getByLabel(/^Total: \D*5\.00$/)).toBeVisible();
      await page.getByRole('button', { name: 'New sale', exact: true }).click();
      const sale3 = await sellBySku(page, ['E2E-2'], 'exact');
      await page.getByRole('button', { name: 'Customer: Guest', exact: true }).click();
      await page.getByLabel('Search customers', { exact: true }).fill(email);
      await page.getByLabel(`Ada Lovelace, ${email}`, { exact: true }).click();
      await expect(page.getByRole('button', { name: 'Customer: Ada Lovelace', exact: true })).toBeVisible();
      await addE2E1(page);
      await page.getByRole('button', { name: 'Parked sales', exact: true }).click();
      await page.getByTestId('parked-sales-park').click();
      await expect(page.getByTestId(/^parked-resume-/)).toHaveCount(1);
      await page.getByTestId('parked-sales-dismiss').click();
      await expect(page.getByTestId('cart-empty')).toBeVisible();
      const receiptTotals = [sale1, 5, sale3].map(t => Math.round(t * 100));
      expect(new Set(receiptTotals).size).toStrictEqual(3);
      await page.close();
      return receiptTotals;
    });

    const OLD = await test.step('B: released store contains exactly the activity performed', async () => {
      const page = await context.newPage();
      const old = await dump(page);
      await page.close();
      expect(old.rxdbVersion).toStrictEqual(releasedRef.rxdb);
      expect(old.stored).toContainEqual({ name: 'pos_orders', version: 7 });
      expect(old.stored).toContainEqual({ name: 'drafts', version: 0 });
      expect(old.docs.pos_orders).toHaveLength(3);
      expect(old.docs.pos_orders.map(order => order.totalMinor).sort((a, b) => a - b))
        .toStrictEqual([...totals].sort((a, b) => a - b));
      for (const [index, total] of totals.entries()) {
        const order = old.docs.pos_orders.find(order => order.totalMinor === total)!;
        expect(order.syncStatus).toStrictEqual(index === 0 ? 'applied' : 'pending');
        expect(order.payments).toHaveLength(total === 500 ? 2 : 1);
      }
      expect(old.docs.drafts).toHaveLength(1);
      expect(old.docs.register_sessions).toHaveLength(1);
      expect(old.docs.register_sessions[0].status).toStrictEqual('open');
      expect(old.register === null).toStrictEqual(false);
      expect(old.register!.stores[backendUrl].register_id).toStrictEqual('register-1');
      return old;
    });

    await server.stop();
    server = serve(current);
    await server.ready();
    await test.step('C: whole documents equal released documents after the v8 identity migration', async () => {
      const page = await context.newPage();
      const NEW = await dump(page);
      await closeGated(page);
      expect(NEW.rxdbVersion).toStrictEqual(currentRef.rxdb);
      expect(NEW.stored).toStrictEqual(OLD.stored.map(entry => entry.name === 'pos_orders'
        ? { ...entry, version: 8 } : entry.name === 'register_sessions'
          ? { ...entry, version: 1 } : entry));
      expect(NEW.docs.pos_orders).toStrictEqual(OLD.docs.pos_orders);
      expect(NEW.docs.drafts).toStrictEqual(OLD.docs.drafts);
      expect(NEW.docs.register_sessions).toStrictEqual(OLD.docs.register_sessions.map(session => ({
        ...session, server_session_id: session.server_session_id ?? null,
      })));
      expect(NEW.docs.cash_movements).toStrictEqual(OLD.docs.cash_movements);
      expect(NEW.docs.closures).toStrictEqual(OLD.docs.closures);
      expect(NEW.register).toStrictEqual(OLD.register);
    });

    await test.step('D: migrated till syncs pending orders once and resumes its parked customer sale', async () => {
      const page = await context.newPage();
      await signIn(page, 'Europe', false);
      await expect(page.getByTestId('open-register-card')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Open register panel', exact: true })).toBeVisible();
      const pending = OLD.docs.pos_orders.filter(order => order.syncStatus === 'pending');
      await expect.poll(async () => {
        const orders = await ordersByClientId(token);
        return pending.map(order => orders.filter(sent => sent.metadata.tally_client_id === order.id).length);
      }).toStrictEqual([1, 1]);
      const split = OLD.docs.pos_orders.find(order => order.totalMinor === 500)!;
      const splitOrder = (await ordersByClientId(token)).find(order => order.metadata.tally_client_id === split.id)!;
      expect((splitOrder.metadata as { tally_payments: unknown[] }).tally_payments).toHaveLength(2);
      await page.getByRole('button', { name: 'Parked sales (1)', exact: true }).click();
      await page.getByTestId(/^parked-resume-/).click();
      await expect(page.getByRole('button', { name: 'Customer: Ada Lovelace', exact: true })).toBeVisible();
      const resumed = await sellBySku(page, [], 'exact');
      expect(resumed).toStrictEqual(2.5);
      await page.reload();
      await expect(page.getByText('Sales are up to date.', { exact: true })).toBeVisible();
      const settled = await ordersByClientId(token);
      expect(OLD.docs.pos_orders.map(order => settled.filter(sent => sent.metadata.tally_client_id === order.id).length))
        .toStrictEqual([1, 1, 1]);
      expect(settled.filter(sent => sent.customer_id === customerId
        && !OLD.docs.pos_orders.some(order => sent.metadata.tally_client_id === order.id))).toHaveLength(1);
      await closeGated(page);
    });
  } finally {
    await server?.stop();
  }
});
