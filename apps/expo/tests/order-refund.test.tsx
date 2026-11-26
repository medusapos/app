// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRxDatabase, randomToken, type RxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortalHost } from '@tallyui/primitives';
import {
  formatMoney, type OrderRefundEnvelope, type ServerCapabilities, type StoreOrder, type StoreOrderLine, type StoreOrderRefund, type SyncContext,
} from '@tallyui/core';
import {
  createOrderBuilder, finalizeOrder, posRefundCollection, refundNeedsAdminLine, type PosOrder, type PosRefundCollection, type TransportOutcome,
} from '@tallyui/pos';
import { OrderDetailSheet } from '../components/order-detail-sheet';
import { useRegister } from '../lib/register-context';
import type { Session } from '../lib/session';
import { useStoreOrderWithRefundLines } from '../lib/store-orders';
import { openRegisterFixture } from './register-fixture';

const { sessionState } = vi.hoisted(() => ({ sessionState: { session: null as Session | null } }));
const { getOrders } = vi.hoisted(() => ({ getOrders: vi.fn<(context: SyncContext, ids: readonly string[]) => Promise<StoreOrder[]>>() }));
vi.mock('../lib/pos-connector', async (original) => ({
  ...await original<typeof import('../lib/pos-connector')>(), createPosConnector: () => ({ id: 'medusa', getOrders }),
}));
vi.mock('../lib/session-context', () => ({ useSession: () => sessionState }));
vi.mock('../lib/register-context', async (original) => ({
  ...await original<typeof import('../lib/register-context')>(), useRegister: vi.fn(),
}));

const REFUND_ON = { orderRefund: 1, pluginContract: 7 } as ServerCapabilities;
const send = vi.fn<(batch: OrderRefundEnvelope[]) => Promise<TransportOutcome>>();
let db: RxDatabase;
let refunds: PosRefundCollection;

function sale(): PosOrder {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
  builder.addPayment({ method: 'cash', amountMinor: 1200 });
  return { ...finalizeOrder(builder.getSnapshot()), syncStatus: 'applied' };
}
const order = sale();
const cardSale: PosOrder = { ...order, payments: [{ ...order.payments[0], method: 'external', methodId: 'pp_card' }] };
const storeOrder: StoreOrder = {
  id: 'order_1', reference: '1001', clientOrderId: order.id, status: 'completed', placedAt: order.createdAt, currency: 'EUR',
  pricesIncludeTax: false, customer: null, fees: [], shipping: [], coupons: [], taxLines: [], discountMinor: 0, discountTaxMinor: 0,
  lines: [{ id: 'line_1', clientLineId: order.lines[0].id, name: 'Blue shirt', quantity: 1, subtotalMinor: 1200, subtotalTaxMinor: 0,
    totalMinor: 1200, taxMinor: 0, soldTotalMinor: 1200, soldTaxMinor: 0 }],
  taxMinor: 0, totalMinor: 1200, payments: [{ id: 'pay_1', method: 'pp_system_default', amountMinor: 1200 }], refunds: [],
};
// Two units of one line, paid 24.00.
const twoUnits: StoreOrder = { ...storeOrder, totalMinor: 2400, payments: [{ id: 'pay_1', method: 'pp_system_default', amountMinor: 2400 }],
  lines: [{ ...storeOrder.lines[0], quantity: 2, subtotalMinor: 2400, totalMinor: 2400, soldTotalMinor: 2400 }] };
// 3 × 0.99 ex 19%, each 1.18 gross, paid 3.53: the order's tax rounds down a cent, so refunding every line takes −0.01.
const centLine = (id: string): StoreOrderLine => ({ id, clientLineId: `client-${id}`, name: `Item ${id}`, quantity: 1, subtotalMinor: 99,
  subtotalTaxMinor: 19, totalMinor: 99, taxMinor: 19, soldTotalMinor: 99, soldTaxMinor: 19 });
const threeCents: StoreOrder = { ...storeOrder, totalMinor: 353, taxMinor: 56, payments: [{ id: 'pay_1', method: 'pp_system_default', amountMinor: 353 }],
  lines: [centLine('a'), centLine('b'), centLine('c')] };
// Two units of one line at 6.00, paid 12.00.
const twoHalves: StoreOrder = { ...storeOrder, lines: [{ ...storeOrder.lines[0], quantity: 2 }] };
// The real id schemes: a store refund carries Medusa's refund id, an applied result the plugin's own `<tally refund id>:<n>`.
const unitRefund = (id: string, amountMinor = 1200, quantity = 1): StoreOrderRefund => ({ id, amountMinor,
  lines: [{ orderLineId: 'line_1', quantity, netMinor: amountMinor, taxMinor: 0 }] });
// An applied record of this till, written straight into pos_refunds.
const record = async (id: string, totalMinor: number, lines: OrderRefundEnvelope['payload']['lines'], createdAt = '2026-11-26T10:00:00.000Z') => {
  const payload = { clientRefundId: id, orderId: 'order_1', lines, shippingMinor: 0, adjustmentMinor: lines.length ? 0 : totalMinor, totalMinor,
    destination: 'cash', reason: 'Damaged', registerId: 'register-1', sessionId: 'session-1', createdAt } as OrderRefundEnvelope['payload'];
  await refunds.insert({ id, commandId: `cmd-${id}`, orderId: 'order_1', sessionId: 'session-1', registerId: 'register-1',
    envelope: { id: `cmd-${id}`, type: 'order.refund', version: 1, attempt: 1, deviceId: 'device-1', createdAt, payload } as OrderRefundEnvelope,
    status: 'applied', result: { totalMinor, byMethod: { cash: totalMinor }, refunds: [{ id: `tref_${id}:0`, paymentId: 'pay_1', totalMinor, state: 'succeeded' }] },
    createdAt, updatedAt: createdAt });
};
const applied = (batch: OrderRefundEnvelope[], refundId = 'tref_1:0'): TransportOutcome => {
  const totalMinor = batch[0].payload.totalMinor;
  return { kind: 'results', results: [{ id: batch[0].id, status: 'applied',
    refund: { totalMinor, byMethod: { cash: totalMinor }, refunds: [{ id: refundId, paymentId: 'pay_1', totalMinor, state: 'succeeded' }] } }] };
};
const rejected = (code: string) => (batch: OrderRefundEnvelope[]): TransportOutcome => ({ kind: 'results',
  results: [{ id: batch[0].id, status: 'rejected', error: { code, message: `The store refused: ${code}` } }] });
const sheet = ({ open = true, store = storeOrder, local = order }: { open?: boolean; store?: StoreOrder; local?: PosOrder } = {}) => <>
  <OrderDetailSheet order={open ? local : null} onClose={vi.fn()} formatDate={(iso) => iso.slice(0, 10)}
    onRetry={vi.fn()} onFlush={vi.fn()} storeOrder={store} refunds={refunds} /><PortalHost /></>;
function RereadSheet({ listed, appliedCount = 0 }: { listed: StoreOrder; appliedCount?: number }) {
  const store = useStoreOrderWithRefundLines(sessionState.session!, listed, appliedCount);
  return store && sheet({ store });
}
const money = (amount: number) => formatMoney({ amount, currency: 'EUR' });
const sent = (call = 0) => send.mock.calls[call][0][0];

// Drives the form by test id: a stepper's "+" is its second Pressable, which shows "+".
const modal = async () => within(await screen.findByTestId('refund-modal'));
const openModal = async () => { fireEvent.click(await screen.findByTestId('order-detail-refund')); return modal(); };
const plus = (form: Awaited<ReturnType<typeof modal>>, lineId: string, times = 1) => {
  for (let press = 0; press < times; press++) fireEvent.click(within(form.getByTestId(`refund-qty-${lineId}`)).getByText('+'));
};
const reason = (form: Awaited<ReturnType<typeof modal>>, value = ' Damaged ') => fireEvent.change(form.getByTestId('refund-reason'), { target: { value } });
const submit = async (form: Awaited<ReturnType<typeof modal>>) => {
  await waitFor(() => expect(form.getByTestId('refund-submit').getAttribute('aria-disabled')).not.toBe('true'));
  fireEvent.click(form.getByTestId('refund-submit'));
  fireEvent.click(await form.findByTestId('refund-confirm'));
};
const parked = (reason: string, message: string) => async (batch: OrderRefundEnvelope[]): Promise<TransportOutcome> => ({
  kind: 'retry', reason: `needs_admin:${reason}`, needsAdmin: { id: batch[0].id, reason, message },
});

beforeEach(async () => {
  sessionState.session = { baseUrl: 'https://store.test', email: 'admin@store.test', token: 't', capabilities: REFUND_ON };
  vi.mocked(useRegister).mockReturnValue({ ...openRegisterFixture(), commandTransport: () => ({ send }) });
  send.mockReset();
  db = await createRxDatabase({ name: `refunds${randomToken(8)}`, storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }) });
  ({ pos_refunds: refunds } = await db.addCollections({ pos_refunds: posRefundCollection() }));
});
afterEach(async () => { cleanup(); await db.remove(); vi.clearAllMocks(); });

describe('Refund in the Orders sheet (#569)', () => {
  it('C1: Refund requires orderRefund and contract 7', async () => {
    for (const capabilities of [{}, { orderRefund: 1, pluginContract: 5 }, { orderRefund: 1, pluginContract: 6 }, { ...REFUND_ON, orderRefund: 0 }] as ServerCapabilities[]) {
      sessionState.session = { ...sessionState.session!, capabilities };
      const view = render(sheet());
      await screen.findByTestId('order-detail');
      expect(screen.queryByTestId('order-detail-refund')).toBeNull();
      view.unmount();
    }
    sessionState.session = { ...sessionState.session!, capabilities: REFUND_ON };
    render(sheet());
    expect(await screen.findByTestId('order-detail-refund')).toBeTruthy();
  });

  it('C2: one unit of a two-unit line sends quantity 1 at its price, to cash, with the trimmed reason, and closes on applied', async () => {
    send.mockImplementation(async (batch) => applied(batch));
    render(sheet({ store: twoUnits }));
    const form = await openModal();
    expect(form.getByTestId('refund-remaining-line_1').textContent).toBe('2');
    expect(form.queryByTestId('refund-destination-original_method')).toBeNull();
    plus(form, 'line_1');
    reason(form);
    expect(form.getByTestId('refund-total').textContent).toBe(money(1200));
    await submit(form);
    await waitFor(() => expect(screen.queryByTestId('refund-modal')).toBeNull());
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent()).toMatchObject({ type: 'order.refund', version: 1, attempt: 1, payload: { orderId: 'order_1', clientOrderId: order.id,
      lines: [{ orderLineId: 'line_1', quantity: 1, restock: true }], shippingMinor: 0, adjustmentMinor: 0, totalMinor: 1200,
      destination: 'cash', reason: 'Damaged', registerId: 'register-1', sessionId: 'session-1' } });
    expect(sent().id).not.toBe(sent().payload.clientRefundId);
    expect((await refunds.findOne(sent().payload.clientRefundId).exec())?.status).toBe('applied');
  });

  it('C3: 3 × 0.99 ex 19% paid 3.53, every line refunded: Rounding −0.01, total 3.53; the envelope sends 353 with adjustment 0', async () => {
    send.mockImplementation(async (batch) => applied(batch));
    render(sheet({ store: threeCents }));
    const form = await openModal();
    for (const id of ['a', 'b', 'c']) plus(form, id);
    reason(form);
    expect(form.getByTestId('refund-rounding').textContent).toBe(money(-1));
    expect(form.getByTestId('refund-total').textContent).toBe(money(353));
    await submit(form);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(sent().payload).toMatchObject({ totalMinor: 353, adjustmentMinor: 0, shippingMinor: 0, destination: 'cash',
      lines: ['a', 'b', 'c'].map((orderLineId) => ({ orderLineId, quantity: 1, restock: true })) });
  });

  it('C4: a double press of Process Refund sends one envelope', async () => {
    let answer!: () => void;
    send.mockImplementation((batch) => new Promise((resolve) => { answer = () => resolve(applied(batch)); }));
    render(sheet());
    const form = await openModal();
    plus(form, 'line_1');
    reason(form);
    await submit(form);
    fireEvent.click(form.getByTestId('refund-confirm'));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    fireEvent.click(form.getByTestId('refund-confirm'));
    await act(async () => answer());
    await waitFor(() => expect(screen.queryByTestId('refund-modal')).toBeNull());
    expect((await screen.findByTestId('order-detail-refunded')).textContent).toBe(`Refunded ${money(1200)}`);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('C5: no final answer closes the form and opens the resume dialog on the same envelope, whose Confirm resends it', async () => {
    send.mockResolvedValueOnce({ kind: 'retry', reason: 'network' }).mockImplementationOnce(async (batch) => applied(batch));
    render(sheet({ store: twoUnits }));
    const form = await openModal();
    plus(form, 'line_1');
    reason(form);
    await submit(form);
    const dialog = within(await screen.findByTestId('order-refund-dialog'));
    expect(screen.queryByTestId('refund-modal')).toBeNull();
    expect(dialog.getByTestId('order-refund-error').textContent).toContain('did not answer');
    expect(dialog.getByTestId('order-refund-total').textContent).toBe(`Refund ${money(1200)}`);
    await waitFor(() => expect(dialog.getByTestId('order-refund-confirm').getAttribute('aria-disabled')).not.toBe('true'));
    fireEvent.click(dialog.getByTestId('order-refund-confirm'));
    await waitFor(() => expect(screen.queryByTestId('order-refund-dialog')).toBeNull());
    expect(send).toHaveBeenCalledTimes(2);
    expect(sent(1).id).toBe(sent(0).id);
    expect(sent(1)).toEqual(sent(0));
    expect(await refunds.count().exec()).toBe(1);
  });

  it('C5b: a rejected resume shows the store message without another Confirm', async () => {
    send.mockResolvedValueOnce({ kind: 'retry', reason: 'network' }).mockImplementationOnce(async (batch) => rejected('amount_mismatch')(batch));
    render(sheet({ store: twoUnits }));
    const form = await openModal();
    plus(form, 'line_1');
    reason(form);
    await submit(form);
    fireEvent.click(await screen.findByTestId('order-refund-confirm'));
    await waitFor(() => expect(screen.getByTestId('order-refund-error').textContent).toBe('The store refused: amount_mismatch'));
    expect(screen.queryByTestId('order-refund-confirm')).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
    expect(sent(1)).toEqual(sent(0));
  });

  it("C6: a rejection shows the store's message; the next confirm sends a new command id, the same refund id and the form's values", async () => {
    send.mockImplementationOnce(async (batch) => rejected('amount_mismatch')(batch)).mockImplementationOnce(async (batch) => applied(batch));
    render(sheet({ store: twoUnits }));
    const form = await openModal();
    plus(form, 'line_1');
    reason(form);
    await submit(form);
    expect((await form.findByTestId('refund-error')).textContent).toBe('The store refused: amount_mismatch');
    expect(screen.getByTestId('refund-modal')).toBeTruthy();
    plus(form, 'line_1');
    reason(form, 'Both damaged');
    await submit(form);
    await waitFor(() => expect(screen.queryByTestId('refund-modal')).toBeNull());
    expect(send).toHaveBeenCalledTimes(2);
    expect(sent(1).id).not.toBe(sent(0).id);
    expect(sent(1).payload.clientRefundId).toBe(sent(0).payload.clientRefundId);
    expect(sent(1).payload).toMatchObject({ lines: [{ orderLineId: 'line_1', quantity: 2, restock: true }], totalMinor: 2400,
      adjustmentMinor: 0, shippingMinor: 0, destination: 'cash', reason: 'Both damaged' });
    const records = (await refunds.find().exec()).map((doc) => doc.toJSON());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: sent(0).payload.clientRefundId, commandId: sent(1).id, status: 'applied' });
  });

  it('C7: an earlier refund with lines on the store copy shows the remaining quantity and Previously Refunded', async () => {
    send.mockImplementation(async (batch) => applied(batch, 'tref_2:0'));
    render(sheet({ store: { ...twoUnits, refunds: [unitRefund('refund_01')] } }));
    expect((await screen.findByTestId('order-detail-refunded')).textContent).toBe(`Refunded ${money(1200)}`);
    const form = await openModal();
    expect(form.getByTestId('refund-remaining-line_1').textContent).toBe('1');
    expect(form.getByTestId('refund-previously-refunded').textContent).toBe(money(-1200));
    plus(form, 'line_1', 2);
    reason(form);
    expect(form.getByTestId('refund-total').textContent).toBe(money(1200));
    await submit(form);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(sent().payload).toMatchObject({ lines: [{ orderLineId: 'line_1', quantity: 1, restock: true }], totalMinor: 1200, adjustmentMinor: 0 });
  });

  it('C8: a local applied refund not yet on the store copy withholds Refund and counts in Refunded until the copy carries its lines', async () => {
    send.mockImplementation(async (batch) => applied(batch, 'tref_1:0'));
    const view = render(sheet({ store: twoHalves }));
    const form = await openModal();
    plus(form, 'line_1');
    reason(form);
    expect(form.getByTestId('refund-total').textContent).toBe(money(600));
    await submit(form);
    await waitFor(() => expect(screen.queryByTestId('refund-modal')).toBeNull());
    expect((await screen.findByTestId('order-detail-refunded')).textContent).toBe(`Refunded ${money(600)}`);
    expect(screen.queryByTestId('order-detail-refund')).toBeNull();
    // A store refund that is not this one leaves the record unlanded: Refunded adds both.
    view.rerender(sheet({ store: { ...twoHalves, refunds: [{ id: 'refund_00', amountMinor: 100, lines: [] }] } }));
    await waitFor(() => expect(screen.getByTestId('order-detail-refunded').textContent).toBe(`Refunded ${money(700)}`));
    expect(screen.queryByTestId('order-detail-refund')).toBeNull();
    // The store's refund id is not the result's; its lines match, so the record has landed and is not counted twice.
    view.rerender(sheet({ store: { ...twoHalves, refunds: [unitRefund('refund_01', 600)] } }));
    expect(await screen.findByTestId('order-detail-refund')).toBeTruthy();
    expect(screen.getByTestId('order-detail-refunded').textContent).toBe(`Refunded ${money(600)}`);
  });

  it('C8b: a store refund with different lines does not land the record', async () => {
    // The store copy leaves a unit refundable, so only the unlanded record withholds Refund.
    await record('r1', 1200, [{ orderLineId: 'line_1', quantity: 2, restock: true }]);
    render(sheet({ store: { ...twoHalves, refunds: [unitRefund('refund_01', 600)] } }));
    await waitFor(() => expect(screen.getByTestId('order-detail-refunded').textContent).toBe(`Refunded ${money(1800)}`));
    expect(screen.queryByTestId('order-detail-refund')).toBeNull();
  });

  it('C8c: two identical applied records need two store refunds; one lands one record', async () => {
    await record('r1', 600, [{ orderLineId: 'line_1', quantity: 1, restock: true }], '2026-11-26T10:00:00.000Z');
    await record('r2', 600, [{ orderLineId: 'line_1', quantity: 1, restock: false }], '2026-11-26T10:05:00.000Z');
    const view = render(sheet({ store: { ...twoHalves, refunds: [unitRefund('refund_01', 600)] } }));
    await waitFor(() => expect(screen.getByTestId('order-detail-refunded').textContent).toBe(`Refunded ${money(1200)}`));
    expect(screen.queryByTestId('order-detail-refund')).toBeNull();
    view.rerender(sheet({ store: { ...twoHalves, refunds: [unitRefund('refund_01', 600), unitRefund('refund_02', 600)] } }));
    await waitFor(() => expect(screen.getByTestId('order-detail-refunded').textContent).toBe(`Refunded ${money(1200)}`));
    // Both landed; nothing is left to refund, so the form is not offered.
    expect(screen.queryByTestId('order-detail-refund')).toBeNull();
  });

  it('C8d: a record without lines lands on a store refund without lines of the same amount only', async () => {
    await record('r1', 300, []);
    const view = render(sheet({ store: { ...storeOrder, refunds: [{ id: 'refund_01', amountMinor: 400, lines: [] }] } }));
    await waitFor(() => expect(screen.getByTestId('order-detail-refunded').textContent).toBe(`Refunded ${money(700)}`));
    expect(screen.queryByTestId('order-detail-refund')).toBeNull();
    view.rerender(sheet({ store: { ...storeOrder, refunds: [{ id: 'refund_01', amountMinor: 300 }] } }));
    await waitFor(() => expect(screen.getByTestId('order-detail-refunded').textContent).toBe(`Refunded ${money(300)}`));
    // lines absent leaves the form unable to price (C9); lines [] is known goodwill, so Refund is offered.
    expect(screen.queryByTestId('order-detail-refund')).toBeNull();
    view.rerender(sheet({ store: { ...storeOrder, refunds: [{ id: 'refund_01', amountMinor: 300, lines: [] }] } }));
    expect(await screen.findByTestId('order-detail-refund')).toBeTruthy();
    expect(screen.getByTestId('order-detail-refunded').textContent).toBe(`Refunded ${money(300)}`);
  });

  it('C9: an earlier store refund whose lines are unknown offers no Refund', async () => {
    render(sheet({ store: { ...storeOrder, refunds: [{ id: 'r1', amountMinor: 200 }] } }));
    expect((await screen.findByTestId('order-detail-refunded')).textContent).toBe(`Refunded ${money(200)}`);
    expect(screen.queryByTestId('order-detail-refund')).toBeNull();
  });

  it('C10: earlier goodwill of 2.00 caps the whole line at 10.00; adjustment −2.00 sends 1000 with adjustment −200', async () => {
    send.mockImplementation(async (batch) => applied(batch));
    render(sheet({ store: { ...storeOrder, refunds: [{ id: 'r1', amountMinor: 200, lines: [] }] } }));
    const form = await openModal();
    plus(form, 'line_1');
    reason(form);
    expect(form.getByTestId('refund-invalid').textContent).toBe(`You can refund at most ${money(1000)}.`);
    expect(form.getByTestId('refund-submit').getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(form.getByTestId('refund-adjustment'), { target: { value: '-2.00' } });
    expect(form.getByTestId('refund-total').textContent).toBe(money(1000));
    await submit(form);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(sent().payload).toMatchObject({ lines: [{ orderLineId: 'line_1', quantity: 1, restock: true }], totalMinor: 1000,
      adjustmentMinor: -200, shippingMinor: 0 });
  });

  it('C11: a card sale refunds to the original method by default; picking cash sends cash', async () => {
    send.mockImplementationOnce(async (batch) => rejected('order_state')(batch)).mockImplementationOnce(async (batch) => applied(batch));
    render(sheet({ local: cardSale }));
    const form = await openModal();
    expect(form.getByTestId('refund-destination-original_method').textContent).toBe('Refund to Card terminal');
    plus(form, 'line_1');
    reason(form);
    await submit(form);
    await form.findByTestId('refund-error');
    expect(sent(0).payload.destination).toBe('original_method');
    fireEvent.click(form.getByTestId('refund-destination-cash'));
    await submit(form);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(sent(1).payload.destination).toBe('cash');
  });

  it('C12: the receipt still reprints after a refund', async () => {
    send.mockImplementation(async (batch) => applied(batch));
    const view = render(sheet());
    const form = await openModal();
    plus(form, 'line_1');
    reason(form);
    await submit(form);
    await screen.findByTestId('order-detail-refunded');
    fireEvent.click(screen.getByTestId('order-detail-receipt'));
    expect(within(await screen.findByTestId('order-detail-receipt-view')).getByText('Blue shirt')).toBeTruthy();
    // Opened again before the store copy carries it, the sale reads Refunded from this till's record and offers no refund.
    view.rerender(sheet({ open: false }));
    view.rerender(sheet());
    expect((await screen.findByTestId('order-detail-refunded')).textContent).toBe(`Refunded ${money(1200)}`);
    expect(screen.queryByTestId('order-detail-refund')).toBeNull();
    // The store copy carries it under Medusa's refund id, not the result's `tref_1:0`: counted once.
    view.rerender(sheet({ store: { ...storeOrder, refunds: [unitRefund('refund_01')] } }));
    await waitFor(() => expect(screen.getByTestId('order-detail-refunded').textContent).toBe(`Refunded ${money(1200)}`));
    expect(screen.queryByTestId('order-detail-refund')).toBeNull();
  });

  it('C13: a reason over 500 characters sends nothing', async () => {
    send.mockImplementation(async (batch) => applied(batch));
    render(sheet());
    const form = await openModal();
    expect(form.getByTestId('refund-reason').getAttribute('maxlength')).toBe('500');
    plus(form, 'line_1');
    reason(form, 'x'.repeat(501));
    await submit(form);
    expect(await form.findByTestId('refund-error')).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(await refunds.count().exec()).toBe(0);
    // 500 is the plugin's limit and goes out.
    reason(form, 'x'.repeat(500));
    await submit(form);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(sent().payload.reason).toHaveLength(500);
  });

  it('C14: with the register not open the form says so and sends nothing', async () => {
    const fixture = openRegisterFixture();
    vi.mocked(useRegister).mockReturnValue({ ...fixture, register: { ...fixture.register, session: null }, commandTransport: () => ({ send }) });
    render(sheet());
    const form = await openModal();
    expect(form.getByTestId('refund-error').textContent).toBe('Open the register to refund');
    plus(form, 'line_1');
    reason(form);
    await submit(form);
    await waitFor(() => expect(form.getByTestId('refund-submit')).toBeTruthy());
    expect(form.getByTestId('refund-error').textContent).toBe('Open the register to refund');
    expect(send).not.toHaveBeenCalled();
    expect(await refunds.count().exec()).toBe(0);
  });
});

describe('Contract 7 refunds in the Orders sheet (#636)', () => {
  const listed: StoreOrder = { ...storeOrder, totalMinor: 80, taxMinor: 13, payments: [{ ...storeOrder.payments[0], amountMinor: 119 }],
    lines: [{ id: 'a', clientLineId: order.lines[0].id, name: 'Blue shirt', quantity: 3, subtotalMinor: 67, subtotalTaxMinor: 13,
      totalMinor: 67, taxMinor: 13 }] };

  it('C15: rereads a sale without till refunds and sends only the two units left after an admin return', async () => {
    getOrders.mockResolvedValueOnce([{ ...listed, lines: [{ ...listed.lines[0], soldTotalMinor: 100, soldTaxMinor: 19, returnedQuantity: 1 }] }]);
    send.mockImplementation(async (batch) => applied(batch));
    render(<RereadSheet listed={listed} />);
    const form = await openModal();
    expect(getOrders).toHaveBeenCalledWith(expect.objectContaining({ capabilities: REFUND_ON }), [listed.id]);
    expect(form.getByTestId('refund-remaining-a').textContent).toBe('2');
    plus(form, 'a', 2);
    reason(form);
    await submit(form);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(sent().payload).toMatchObject({ lines: [{ orderLineId: 'a', quantity: 2 }], totalMinor: 80, adjustmentMinor: 0 });
  });

  it('C16: resuming a card sale refunded to cash shows the sent destination and partial total', async () => {
    send.mockResolvedValueOnce({ kind: 'retry', reason: 'network' });
    render(sheet({ store: twoHalves, local: cardSale }));
    const form = await openModal();
    plus(form, 'line_1');
    fireEvent.click(form.getByTestId('refund-destination-cash'));
    reason(form);
    await submit(form);
    const dialog = within(await screen.findByTestId('order-refund-dialog'));
    expect(sent().payload).toMatchObject({ totalMinor: 600, destination: 'cash' });
    expect(dialog.getByTestId('order-refund-destination').textContent).toBe('To Cash');
    expect(dialog.getByTestId('order-refund-total').textContent).toBe(`Refund ${money(sent().payload.totalMinor)}`);
  });

  it('C17: a failed reread with no till refunds leaves Refund unavailable without sold figures', async () => {
    getOrders.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { render(<RereadSheet listed={{ ...storeOrder, lines: [{ ...storeOrder.lines[0], soldTotalMinor: undefined, soldTaxMinor: undefined }] }} />); });
    expect(getOrders).toHaveBeenCalledWith(expect.objectContaining({ capabilities: REFUND_ON }), [storeOrder.id]);
    expect(screen.getByTestId('order-detail')).toBeTruthy();
    expect(screen.queryByTestId('order-detail-refund')).toBeNull();
  });

  it('C18: cancelling an unanswered refund closes the resume dialog without offering another refund', async () => {
    send.mockResolvedValueOnce({ kind: 'retry', reason: 'network' });
    render(sheet({ store: twoUnits }));
    const form = await openModal();
    plus(form, 'line_1');
    reason(form);
    await submit(form);
    const dialog = within(await screen.findByTestId('order-refund-dialog'));
    fireEvent.click(dialog.getByTestId('order-refund-cancel'));
    await waitFor(() => expect(screen.queryByTestId('order-refund-dialog')).toBeNull());
    expect(screen.getByTestId('order-detail')).toBeTruthy();
    expect(screen.queryByTestId('order-detail-refund')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('Refund form across a reread (#636)', () => {
  const listed: StoreOrder = { ...storeOrder, taxMinor: 60, totalMinor: 360, payments: [{ ...storeOrder.payments[0], amountMinor: 360 }],
    lines: [{ ...storeOrder.lines[0], quantity: 3, subtotalMinor: 300, subtotalTaxMinor: 60, totalMinor: 300, taxMinor: 60,
      soldTotalMinor: undefined, soldTaxMinor: undefined }] };
  const read = { ...listed, lines: [{ ...listed.lines[0], soldTotalMinor: 300, soldTaxMinor: 60 }] };

  async function openAcrossRead() {
    let answer!: (orders: StoreOrder[]) => void;
    let fail!: (error: Error) => void;
    getOrders.mockResolvedValueOnce([read]).mockImplementationOnce(() => new Promise((resolve, reject) => { answer = resolve; fail = reject; }));
    const view = render(<RereadSheet listed={listed} />);
    const form = await openModal();
    plus(form, 'line_1');
    reason(form, 'Damaged');
    return { form, reread: (count: number) => view.rerender(<RereadSheet listed={listed} appliedCount={count} />),
      answer: () => act(async () => answer([read])), fail: () => act(async () => fail(new Error('offline'))) };
  }

  it('R1: keeps the unit and reason during and after the reread', async () => {
    const view = await openAcrossRead();
    const expectEntries = () => {
      expect(screen.queryByTestId('refund-modal')).not.toBeNull();
      expect(within(screen.getByTestId('refund-qty-line_1')).getByText('1')).toBeTruthy();
      expect((screen.getByTestId('refund-reason') as HTMLInputElement).value).toBe('Damaged');
    };
    view.reread(1);
    expect(getOrders).toHaveBeenCalledTimes(2);
    expectEntries();
    await view.answer();
    expectEntries();
  });

  it('R2: confirming after the reread cannot pay the pending refund twice', async () => {
    let applyFirst!: () => void;
    send.mockImplementationOnce((batch) => new Promise((resolve) => { applyFirst = () => resolve(applied(batch)); }))
      .mockImplementation(async (batch) => applied(batch));
    const view = await openAcrossRead();
    await submit(view.form);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    view.reread(1);
    await view.answer();
    const current = await modal();
    const confirm = current.queryByTestId('refund-confirm');
    if (confirm) fireEvent.click(confirm);
    else {
      plus(current, 'line_1');
      reason(current, 'Damaged');
      await submit(current);
      await waitFor(() => expect(screen.queryByTestId('refund-modal')).toBeNull());
    }
    const count = await refunds.count().exec();
    await act(async () => applyFirst());
    expect(count).toBe(1);
    expect(send.mock.calls.flatMap(([batch]) => batch.map(({ payload }) => payload.clientRefundId))).toEqual([sent().payload.clientRefundId]);
    expect((await screen.findByTestId('order-detail-refunded')).textContent).toBe(`Refunded ${money(120)}`);
  });

  it('R2b: a remounted form resumes the pending refund without a second send', async () => {
    let answerFirst!: (outcome: TransportOutcome) => void;
    send.mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve; }))
      .mockImplementation(async (batch) => applied(batch));
    const view = await openAcrossRead();
    await submit(view.form);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    view.reread(1);
    await view.fail();
    expect(screen.queryByTestId('refund-modal')).toBeNull();
    getOrders.mockResolvedValueOnce([read]);
    view.reread(2);
    const remounted = await modal();
    plus(remounted, 'line_1');
    reason(remounted, 'Damaged');
    await submit(remounted);

    await waitFor(() => expect(screen.queryByTestId('refund-modal')).toBeNull());
    expect(send).toHaveBeenCalledTimes(1);
    expect(await refunds.count().exec()).toBe(1);
    expect(await screen.findByTestId('order-refund-dialog')).toBeTruthy();
    await act(async () => answerFirst(applied([sent()])));
    expect((await screen.findByTestId('order-detail-refunded')).textContent).toBe(`Refunded ${money(120)}`);
  });

  it('R3: a failed reread cannot give the same opening another refund id', async () => {
    send.mockImplementationOnce(async (batch) => rejected('amount_mismatch')(batch)).mockImplementationOnce(async (batch) => applied(batch));
    const view = await openAcrossRead();
    await submit(view.form);
    await view.form.findByTestId('refund-error');
    view.reread(1);
    await view.fail();
    if (!screen.queryByTestId('refund-modal')) {
      expect(send).toHaveBeenCalledTimes(1);
      getOrders.mockResolvedValueOnce([read]);
      view.reread(2);
    }
    const current = await modal();
    if (!within(current.getByTestId('refund-qty-line_1')).queryByText('1')) plus(current, 'line_1');
    reason(current, 'Damaged');
    await submit(current);
    await screen.findByTestId('order-detail-refunded');
    expect(sent(1).payload.clientRefundId).toBe(sent().payload.clientRefundId);
  });
});

describe('needs_admin (#545)', () => {
  it.each(['session_closed', 'money_unconfirmed'])('shows the store message and the notice for %s instead of Confirm', async (adminReason) => {
    const message = `Store response: ${adminReason}`;
    send.mockImplementationOnce(parked(adminReason, message));
    render(sheet({ store: twoUnits }));
    const form = await openModal();
    plus(form, 'line_1');
    reason(form);
    await submit(form);
    expect((await screen.findByTestId('refund-needs-admin-line')).textContent).toBe(refundNeedsAdminLine(adminReason));
    expect(screen.queryByTestId('refund-modal')).toBeNull();
    expect(screen.getByTestId('order-refund-total').textContent).toBe(`Refund ${money(1200)}`);
    expect(screen.getByTestId('refund-needs-admin-message').textContent).toBe(message);
    expect(screen.queryByTestId('order-refund-error')).toBeNull();
    expect(screen.queryByTestId('order-refund-confirm')).toBeNull();
  });

  it('Check again applies the same envelope and closes the dialog', async () => {
    send.mockImplementationOnce(parked('session_closed', 'Store response')).mockImplementationOnce(async (batch) => applied(batch));
    render(sheet({ store: twoUnits }));
    const form = await openModal();
    plus(form, 'line_1');
    reason(form);
    await submit(form);
    fireEvent.click(await screen.findByTestId('refund-needs-admin-check-again'));
    await screen.findByTestId('order-detail-refunded');
    expect(screen.queryByTestId('order-refund-dialog')).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
    const [first, second] = send.mock.calls.map(([batch]) => batch[0]);
    expect(second.id).toBe(first.id);
    expect(await refunds.count().exec()).toBe(1);
  });

  it('reopens on the stored notice without sending until Check again', async () => {
    send.mockImplementationOnce(parked('session_closed', 'Stored response')).mockImplementationOnce(async (batch) => applied(batch));
    const view = render(sheet({ store: twoUnits }));
    const form = await openModal();
    plus(form, 'line_1');
    reason(form);
    await submit(form);
    await screen.findByTestId('refund-needs-admin-line');
    const record = await refunds.findOne().exec();
    view.rerender(sheet({ open: false, store: twoUnits }));
    view.rerender(sheet({ store: twoUnits }));
    expect((await screen.findByTestId('refund-needs-admin-line')).textContent).toBe(refundNeedsAdminLine('session_closed'));
    expect(screen.getByTestId('refund-needs-admin-message').textContent).toBe('Stored response');
    expect(send).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('refund-needs-admin-check-again'));
    await screen.findByTestId('order-detail-refunded');
    expect(send.mock.calls[1][0][0].id).toBe(record?.envelope.id);
  });

  it('keeps the notice alongside the error after an unreachable store', async () => {
    send.mockImplementationOnce(parked('money_unconfirmed', 'Store response')).mockResolvedValueOnce({ kind: 'retry', reason: 'network' });
    render(sheet({ store: twoUnits }));
    const form = await openModal();
    plus(form, 'line_1');
    reason(form);
    await submit(form);
    fireEvent.click(await screen.findByTestId('refund-needs-admin-check-again'));
    expect((await screen.findByTestId('order-refund-error')).textContent).toBe('The store did not answer. Try again.');
    expect(screen.getByTestId('refund-needs-admin-line').textContent).toBe(refundNeedsAdminLine('money_unconfirmed'));
    expect(screen.getByTestId('refund-needs-admin-message').textContent).toBe('Store response');
    expect(screen.queryByTestId('order-refund-confirm')).toBeNull();
  });

  it('clears the notice after rejection and only offers a new refund through the form', async () => {
    send.mockImplementationOnce(parked('money_unconfirmed', 'Store response'))
      .mockImplementationOnce(async (batch) => rejected('amount_mismatch')(batch));
    render(sheet({ store: twoUnits }));
    const form = await openModal();
    plus(form, 'line_1');
    reason(form);
    await submit(form);
    fireEvent.click(await screen.findByTestId('refund-needs-admin-check-again'));
    expect((await screen.findByTestId('order-refund-error')).textContent).toBe('The store refused: amount_mismatch');
    expect(screen.queryByTestId('refund-needs-admin-line')).toBeNull();
    expect(screen.queryByTestId('refund-needs-admin-check-again')).toBeNull();
    expect(screen.queryByTestId('order-refund-confirm')).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
    expect(sent(1).id).toBe(sent(0).id);
    expect(sent(1).payload.clientRefundId).toBe(sent(0).payload.clientRefundId);
    fireEvent.click(screen.getByTestId('order-refund-cancel'));
    await openModal();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
