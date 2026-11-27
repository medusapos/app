// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { toOrderCreateEnvelope, type PosOrder } from '@tallyui/pos';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProductsScreen from '../app/index';
import { openOrderStore } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { useSession } from '../lib/session-context';
import { sessionFixture } from './session-fixture';
import { fetchStoreSettings } from '../lib/store-settings';
import { useReplicatedProducts } from '../lib/use-replicated-products';
import { loadReceiptTemplate, printSalePage, saveReceiptTemplate } from '../lib/receipt-templates';
import { savePrintingSettings } from '../lib/printing-settings';
import { capabilities, storeSettings } from './pos-connector-mock';
import { openRegisterFixture } from './register-fixture';
import { setWindowWidth } from './window-width';
import { pickMethod, take, takeLeg, tenderBalance, tenderEntry } from './tender-pane';

vi.mock('../lib/pos-connector', async (original) => (await import('./pos-connector-mock')).mockPosConnector(original));
vi.mock('expo-router', () => ({ usePathname: () => '/', Redirect: () => null, Stack: { Screen: () => null } }));
vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));
vi.mock('../lib/session-context', () => ({ useSession: vi.fn() }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('../lib/use-replicated-products', () => ({ useReplicatedProducts: vi.fn() }));
vi.mock('../lib/register-context', async (original) => ({
  ...await original<typeof import('../lib/register-context')>(), useRegister: vi.fn(),
}));
// The thermal print queue, observed; the templates and the page stay real.
vi.mock('../lib/receipt-templates', async (original) => ({
  ...await original<typeof import('../lib/receipt-templates')>(), printSalePage: vi.fn(),
}));
vi.mock('../lib/store-settings', async (original) => ({
  ...await original<typeof import('../lib/store-settings')>(), fetchStoreSettings: vi.fn(),
}));

let store: Awaited<ReturnType<typeof openOrderStore>>;
const record = vi.fn(async (_order: PosOrder) => {});
const add = () => fireEvent.click(screen.getByTestId('product-tile-Shirt'));
const headline = () => screen.getByTestId('tender-headline').textContent;
/** The ledger's payment legs (each row's testID; its status and Cancel payment ids end -status and -void). */
const legs = () => screen.queryAllByTestId(/^tender-leg-/).filter((row) => !/-(status|void)$/.test(row.getAttribute('data-testid')!));
beforeEach(async () => {
  setWindowWidth(1280);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  const session = { baseUrl: `https://split-${crypto.randomUUID()}.test`, email: 'admin@store.test', token: 'jwt',
    capabilities: { orderCreate: 4, taxRounding: { granularity: 'per_order' as const, mode: 'half_away_from_zero' as const } } };
  vi.mocked(useSession).mockReturnValue(sessionFixture(session));
  capabilities.mockResolvedValue(session.capabilities);
  storeSettings.mockResolvedValue({ currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 },
    pricingContext: { region_id: 'reg_eu', currency_code: 'eur', publishable_key: 'pk_1' } });
  vi.mocked(fetchStoreSettings).mockResolvedValue({ storeName: 'Test shop', currency: 'EUR',
    location: { id: 'loc', name: 'Main', countryCode: 'dk' } });
  vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
  vi.mocked(useReplicatedProducts).mockReturnValue({ products: [{ id: 'shirt', title: 'Shirt', status: 'published',
    variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 19.2, currency_code: 'eur' }] }] }],
    state: 'synced', error: null, lastSyncedAt: null, stockOverlay: undefined, lastStockCheckAt: null,
    reconcileStock: vi.fn(async () => {}), pullNotice: undefined, resumePull: vi.fn(), syncNow: vi.fn(), clearAndRefresh: vi.fn(), unlisted: undefined });
  store = await openOrderStore(session.baseUrl);
  record.mockReset().mockResolvedValue(undefined);
  vi.mocked(useOutboxContext).mockReturnValue({ orders: store.orders, record, state: { pending: 0, sending: false },
    recent: [], savesInFlight: 0, stuckCommandIds: [], flush: vi.fn(), requeue: vi.fn(), discard: vi.fn(), cancelOnStore: vi.fn(), payRestOnStore: vi.fn(), reverseOnStore: vi.fn(), isStored: vi.fn(async () => true) });
});
afterEach(async () => {
  cleanup();
  await store.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function startSplit() {
  await act(async () => { render(<><ProductsScreen /><PortalHost /></>); });
  await screen.findByTestId('product-tile-Shirt');
  add();
  // v2's cart foot: Checkout opens the one tender pane, which takes split legs itself.
  await act(async () => { fireEvent.click(screen.getByTestId('cart-checkout')); });
  expect(headline()).toBe('To paySplit');
  expect(tenderBalance()).toBe('€24.00');
}
function tender(method: 'card' | 'cash', amount: string) {
  takeLeg(method === 'card' ? 'external' : 'cash', amount);
}
async function complete() {
  await act(async () => { fireEvent.click(screen.getByTestId('tender-complete')); });
  await screen.findByRole('button', { name: 'New sale' });
  expect(record).toHaveBeenCalledOnce();
  const order = record.mock.calls[0][0];
  return toOrderCreateEnvelope(order, 'register-1');
}

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('takes a card part and a cash remainder, shows change from cash only, and records both payments', async () => {
  await startSplit();
  tender('card', '10.00');
  expect([headline(), tenderBalance()]).toEqual(['RemainingSplit€10.00 of €24.00 paid', '€14.00']);
  expect(screen.queryByTestId('tender-change')).toBeNull();
  expect(tenderEntry()).toBe('€14.00');
  tender('cash', '20.00');
  expect(tenderBalance()).toBe('€0.00');
  expect(screen.getByTestId('tender-change').textContent).toBe('Change €6.00');
  const command = await complete();
  expect(command.type).toBe('order.create');
  expect(command.payload.totalMinor).toBe(2400);
  expect(command.payload.payments).toEqual([
    expect.objectContaining({ method: 'external', amountMinor: 1000 }),
    expect.objectContaining({ method: 'cash', amountMinor: 1400, tenderedMinor: 2000, changeMinor: 600 }),
  ]);
  expect(screen.getByLabelText('Card terminal: €10.00')).toBeTruthy();
  expect(screen.getByLabelText('Cash tendered: €20.00')).toBeTruthy();
  expect(screen.getByLabelText('Change: €6.00')).toBeTruthy();
  expect(screen.getByTestId('paid-change-figure').textContent).toBe('Change €6.00');
  expect(screen.getByTestId('paid-change-tendered').textContent).toBe('Paid €24.00 · tendered €20.00 in cash');
  expect(screen.getByTestId('paid-change-tick')).toBeTruthy();
}, 15000);

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('leads a cash sale with change with v2\'s tick, change heading and paid · tendered line', async () => {
  await startSplit();
  tender('cash', '30.00');
  await complete();
  expect(screen.getByTestId('paid-change-figure').textContent).toBe('Change €6.00');
  expect(screen.getByTestId('paid-change-tendered').textContent).toBe('Paid €24.00 · tendered €30.00 in cash');
  expect(screen.getByTestId('paid-change-tick')).toBeTruthy();
  expect(screen.getByTestId('paid-change-due').textContent).not.toContain('Change Due');
}, 15000);

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('caps a card part at the balance due, with no change from card', async () => {
  await startSplit();
  // The pane caps a card leg before it is taken: over the balance, Take is refused with v2's hint, and nothing is recorded.
  tender('card', '30.00');
  expect(screen.getByTestId('tender-entry-hint').textContent).toBe("Only €24.00 is due — Card terminal can't give change");
  expect(screen.getByTestId('tender-take').getAttribute('aria-disabled')).toBe('true');
  expect(legs()).toHaveLength(0);
  tender('card', '24.00');
  expect(screen.getByTestId('tender-paid').textContent).toBe('€24.00 of €24.00 paid');
  expect(tenderBalance()).toBe('€0.00');
  expect(screen.queryByTestId('tender-change')).toBeNull();
  const { payload } = await complete();
  expect(payload.payments).toEqual([expect.objectContaining({ method: 'external', amountMinor: 2400 })]);
  expect(payload.payments[0].changeMinor ?? 0).toBe(0);
  expect(screen.queryByTestId('paid-change-due')).toBeNull();
}, 15000);

it('removing a tender restores the balance due', async () => {
  await startSplit();
  tender('card', '10.00');
  expect(tenderBalance()).toBe('€14.00');
  // The pane's Cancel payment voids the leg: it stays on the ledger, struck through, and counts nothing.
  fireEvent.click(screen.getByTestId(/^tender-leg-.*-void$/));
  expect(screen.queryByTestId('tender-paid')).toBeNull();
  expect([headline(), tenderBalance()]).toEqual(['To paySplit', '€24.00']);
  expect(tenderEntry()).toBe('€24.00');
  expect(screen.queryByTestId(/^tender-leg-.*-void$/)).toBeNull();
  expect(screen.getByTestId(/^tender-leg-.*-status$/).textContent).toBe('Cancelled');
  expect(screen.getByTestId('tender-complete').getAttribute('aria-disabled')).toBe('true');
  expect(record).not.toHaveBeenCalled();
});

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('takes a cash part and the rest on the card terminal, and records both payments against the order total', async () => {
  await startSplit();
  tender('cash', '5.00');
  expect([headline(), tenderBalance()]).toEqual(['RemainingSplit€5.00 of €24.00 paid', '€19.00']);
  // The Card terminal tile prefills the balance due, so Take settles the rest.
  pickMethod('external');
  expect(tenderEntry()).toBe('€19.00');
  take();
  expect(tenderBalance()).toBe('€0.00');
  expect(screen.queryByTestId('tender-change')).toBeNull();
  const { payload } = await complete();
  expect(payload.totalMinor).toBe(2400);
  expect(payload.payments).toEqual([
    expect.objectContaining({ method: 'cash', amountMinor: 500 }),
    expect.objectContaining({ method: 'external', amountMinor: 1900 }),
  ]);
}, 15000);

it('shows the screen-only paid summary beside the receipt on wide windows', async () => {
  await startSplit();
  tender('card', '10.00');
  tender('cash', '20.00');
  await complete();
  const summary = screen.getByTestId('paid-summary');
  expect(summary.parentElement?.closest('[data-print="hide"]')).toBeTruthy();
  expect(screen.getByTestId('paid-layout').contains(summary)).toBe(true);
  for (const text of ['Card terminal', '€10.00', 'Cash', '€14.00', 'Tendered €20.00 · change €6.00', 'Total', '€24.00', 'Paid in full']) {
    expect(summary.textContent).toContain(text);
  }
  expect(summary.textContent).toContain('Paid€24.00');
  expect(summary.textContent).not.toContain('€30.00');
  expect(screen.getByTestId('paid-change-due').textContent).toContain('€6.00');
  expect(screen.getByLabelText('Card terminal: €10.00')).toBeTruthy();
  expect(screen.getByLabelText('Total: €24.00')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'New sale' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Print receipt' })).toBeTruthy();
  // v2's footer bar is the left pane's, never the summary column's.
  const footer = screen.getByTestId('paid-footer');
  expect(summary.parentElement!.contains(footer)).toBe(false);
  expect(screen.getByTestId('paid-pane').contains(footer)).toBe(true);
}, 15000);

// v2's footer bar: one Print receipt and one New sale, with Email receipt, along the bottom and outside the receipt card.
it('puts Email receipt, Print receipt and New sale in the paid footer, not in the receipt', async () => {
  await startSplit();
  tender('cash', '30.00');
  await complete();
  const footer = screen.getByTestId('paid-footer');
  const card = screen.getByTestId('receipt-order').parentElement!;
  for (const name of ['Print receipt', 'New sale']) {
    const buttons = screen.getAllByRole('button', { name });
    expect(buttons).toHaveLength(1);
    expect(footer.contains(buttons[0])).toBe(true);
    expect(card.contains(buttons[0])).toBe(false);
  }
  expect(screen.queryByTestId('receipt-footer')).toBeNull();
  expect(footer.contains(screen.getByTestId('receipt-email-open'))).toBe(true);
  expect(card.contains(screen.getByTestId('receipt-email-open'))).toBe(false);
}, 15000);

it('starts a new sale from the ✕ at the top of the paid screen', async () => {
  await startSplit();
  tender('cash', '24.00');
  await complete();
  const close = screen.getByTestId('paid-close');
  expect(close.getAttribute('aria-label')).toBe('Close');
  expect(close.closest('[data-print="hide"]')).toBeTruthy();
  await act(async () => { fireEvent.click(close); });
  expect(screen.queryByTestId('paid-footer')).toBeNull();
  expect(screen.getByText('Tap a product to start a sale')).toBeTruthy();
}, 15000);

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('shows each payment of a sent split sale as Captured with no Recorded offline', async () => {
  await startSplit();
  tender('card', '10.00');
  tender('cash', '20.00');
  await complete();
  const summary = screen.getByTestId('paid-summary');
  const payments = record.mock.calls[0][0].payments;
  expect(payments).toHaveLength(2);
  for (const { id } of payments) {
    expect(within(summary).getByTestId(`summary-payment-${id}-status`).textContent).toBe('Captured');
  }
  expect(summary.textContent).not.toContain('Recorded offline');
}, 15000);

// The keypad tender pane's steps exceed the 5 s default on CI runners.
it('shows a sent cash payment as Captured', async () => {
  await startSplit();
  tender('cash', '24.00');
  await complete();
  const summary = screen.getByTestId('paid-summary');
  const [{ id }] = record.mock.calls[0][0].payments;
  expect(within(summary).getByTestId(`summary-payment-${id}-status`).textContent).toBe('Captured');
  expect(summary.textContent).not.toContain('Recorded offline');
}, 15000);

it('keeps the receipt without a paid summary at column widths', async () => {
  setWindowWidth(800);
  await startSplit();
  tender('card', '24.00');
  await complete();
  expect(screen.queryByTestId('paid-summary')).toBeNull();
  expect(screen.queryByTestId('paid-layout')).toBeNull();
  expect(screen.getByRole('button', { name: 'New sale' })).toBeTruthy();
  const footer = screen.getByTestId('paid-footer');
  expect(screen.getAllByRole('button', { name: 'Print receipt' })).toEqual([within(footer).getByTestId('paid-print')]);
  expect(screen.getAllByRole('button', { name: 'New sale' })).toEqual([within(footer).getByTestId('paid-new-sale')]);
  expect(screen.getByTestId('paid-close')).toBeTruthy();
}, 15000);

// The paid screen's Print receipt: Standard prints the window, a thermal template prints its own page through the queue.
async function paidCash() {
  await startSplit();
  tender('cash', '30.00');
  await complete();
}
async function chooseTemplate(id: 'standard' | 'thermal-80mm' | 'thermal-58mm') {
  await act(async () => { fireEvent.click(screen.getByTestId('receipt-template-select')); });
  await act(async () => { fireEvent.click(screen.getByTestId(`receipt-template-option-${id}`)); });
}
const printButton = () => screen.getByTestId('paid-print');

it('a template chosen on the paid screen is saved, and the next app load opens on it', async () => {
  vi.mocked(printSalePage).mockResolvedValue();
  await paidCash();
  await chooseTemplate('thermal-80mm');
  expect(loadReceiptTemplate(localStorage, useSession().session!.baseUrl)).toBe('thermal-80mm');
  cleanup();
  record.mockClear();
  await paidCash();
  const page = screen.getByTestId('receipt-thermal-frame').getAttribute('srcdoc');
  expect(page).toContain('width: 48ch');
  await act(async () => { fireEvent.click(printButton()); });
  expect(printSalePage).toHaveBeenCalledOnce();
  expect(printSalePage).toHaveBeenCalledWith(page);
}, 15000);

it('auto-prints a Standard sale through the window, once', async () => {
  savePrintingSettings(localStorage, useSession().session!.baseUrl, { autoPrintReceipt: true });
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  await paidCash();
  await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 120)));
  expect(print).toHaveBeenCalledTimes(1);
  expect(printSalePage).not.toHaveBeenCalled();
}, 15000);

it.each(['thermal-80mm', 'thermal-58mm'] as const)('auto-prints the next sale through the %s template the paid screen chose', async (template) => {
  savePrintingSettings(localStorage, useSession().session!.baseUrl, { autoPrintReceipt: true });
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  vi.mocked(printSalePage).mockResolvedValue();
  await paidCash();
  await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
  await chooseTemplate(template);
  const firstPage = screen.getByTestId('receipt-thermal-frame').getAttribute('srcdoc');
  print.mockClear();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New sale' })); });
  add();
  add();
  await act(async () => { fireEvent.click(screen.getByTestId('cart-checkout')); });
  tender('cash', '48.00');
  await act(async () => { fireEvent.click(screen.getByTestId('tender-complete')); });
  const secondPage = (await screen.findByTestId('receipt-thermal-frame')).getAttribute('srcdoc');
  expect(secondPage).toContain('Shirt');
  expect(secondPage).not.toBe(firstPage);
  await waitFor(() => expect(printSalePage).toHaveBeenCalledTimes(1));
  expect(printSalePage).toHaveBeenCalledWith(secondPage);
  expect(print).not.toHaveBeenCalled();
}, 15000);

it('holds Print during a thermal auto-print and clears its failure when the template changes', async () => {
  const { baseUrl } = useSession().session!;
  savePrintingSettings(localStorage, baseUrl, { autoPrintReceipt: true });
  saveReceiptTemplate(localStorage, baseUrl, 'thermal-80mm');
  let fail!: (error: Error) => void;
  vi.mocked(printSalePage).mockReturnValueOnce(new Promise<void>((_resolve, reject) => { fail = reject; }));
  await paidCash();
  await waitFor(() => expect(printButton().getAttribute('aria-disabled')).toBe('true'));
  await act(async () => { fail(new Error('no dialog')); });
  expect(screen.getByTestId('paid-print-status').textContent).toBe("Couldn't print. Try again.");
  expect(printButton().getAttribute('aria-disabled')).not.toBe('true');
  await chooseTemplate('thermal-58mm');
  expect(screen.queryByTestId('paid-print-status')).toBeNull();
  await chooseTemplate('thermal-80mm');
  expect(screen.queryByTestId('paid-print-status')).toBeNull();
}, 15000);

it('prints the window once from Print receipt on the Standard template', async () => {
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  await paidCash();
  print.mockClear();
  await act(async () => { fireEvent.click(printButton()); });
  expect(print).toHaveBeenCalledTimes(1);
  expect(printSalePage).not.toHaveBeenCalled();
}, 15000);

it('prints the 80mm page the frame shows through the print queue, not the window', async () => {
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  vi.mocked(printSalePage).mockResolvedValue();
  await paidCash();
  await chooseTemplate('thermal-80mm');
  const srcdoc = screen.getByTestId('receipt-thermal-frame').getAttribute('srcdoc');
  expect(srcdoc).toContain('Shirt');
  print.mockClear();
  await act(async () => { fireEvent.click(printButton()); });
  expect(printSalePage).toHaveBeenCalledTimes(1);
  expect(printSalePage).toHaveBeenCalledWith(srcdoc);
  expect(print).not.toHaveBeenCalled();
}, 15000);

it("clears a failed thermal print's message when the template changes", async () => {
  vi.spyOn(window, 'print').mockImplementation(() => {});
  vi.mocked(printSalePage).mockRejectedValue(new Error('no dialog'));
  await paidCash();
  await chooseTemplate('thermal-80mm');
  await act(async () => { fireEvent.click(printButton()); });
  expect(screen.getByTestId('paid-print-status').textContent).toBe("Couldn't print. Try again.");
  await chooseTemplate('standard');
  expect(screen.queryByTestId('paid-print-status')).toBeNull();
}, 15000);

it('does not hold Print on the new template while a thermal print is still pending', async () => {
  vi.spyOn(window, 'print').mockImplementation(() => {});
  vi.mocked(printSalePage).mockReturnValue(new Promise<void>(() => {}));
  await paidCash();
  await chooseTemplate('thermal-80mm');
  await act(async () => { fireEvent.click(printButton()); });
  expect(printButton().getAttribute('aria-disabled')).toBe('true');
  await chooseTemplate('thermal-58mm');
  expect(printButton().getAttribute('aria-disabled')).not.toBe('true');
  await chooseTemplate('standard');
  expect(printButton().getAttribute('aria-disabled')).not.toBe('true');
}, 15000);
