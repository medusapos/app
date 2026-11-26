// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRxDatabase, randomToken, type RxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortalHost } from '@tallyui/primitives';
import { formatMoney, type OrderRefundEnvelope, type ServerCapabilities, type StoreOrder } from '@tallyui/core';
import {
  createOrderBuilder, finalizeOrder, posRefundCollection, refundNeedsAdminLine, type PosOrder, type PosRefundCollection, type TransportOutcome,
} from '@tallyui/pos';
import { OrderDetailSheet } from '../components/order-detail-sheet';
import { useRegister } from '../lib/register-context';
import type { Session } from '../lib/session';
import { openRegisterFixture } from './register-fixture';

const { sessionState } = vi.hoisted(() => ({ sessionState: { session: null as Session | null } }));
vi.mock('../lib/session-context', () => ({ useSession: () => sessionState }));
vi.mock('../lib/register-context', async (original) => ({
  ...await original<typeof import('../lib/register-context')>(), useRegister: vi.fn(),
}));

const REFUND_ON = { orderRefund: 1, pluginContract: 5 } as ServerCapabilities;
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
const storeOrder: StoreOrder = {
  id: 'order_1', reference: '1001', clientOrderId: order.id, status: 'completed', placedAt: order.createdAt, currency: 'EUR',
  pricesIncludeTax: false, customer: null, fees: [], shipping: [], coupons: [], taxLines: [], discountMinor: 0, discountTaxMinor: 0,
  lines: [{ id: 'line_1', clientLineId: order.lines[0].id, name: 'Blue shirt', quantity: 1, subtotalMinor: 1200, subtotalTaxMinor: 0, totalMinor: 1200, taxMinor: 0 }],
  taxMinor: 0, totalMinor: 1200, payments: [{ id: 'pay_1', method: 'pp_system_default', amountMinor: 1200 }], refunds: [],
};
const applied = (batch: OrderRefundEnvelope[]): TransportOutcome => ({ kind: 'results', results: [{ id: batch[0].id, status: 'applied',
  refund: { totalMinor: 1200, byMethod: { cash: 1200 }, refunds: [{ id: 'ref_1', paymentId: 'pay_1', totalMinor: 1200, state: 'succeeded' }] } }] });
const rejected = (code: string) => (batch: OrderRefundEnvelope[]): TransportOutcome => ({ kind: 'results',
  results: [{ id: batch[0].id, status: 'rejected', error: { code, message: `The store refused: ${code}` } }] });
const parked = (reason: string, message: string) => async (batch: OrderRefundEnvelope[]): Promise<TransportOutcome> => ({
  kind: 'retry', reason: `needs_admin:${reason}`, needsAdmin: { id: batch[0].id, reason, message },
});
const sheet = (open = true) => <><OrderDetailSheet order={open ? order : null} onClose={vi.fn()} formatDate={(iso) => iso.slice(0, 10)}
  onRetry={vi.fn()} onFlush={vi.fn()} storeOrder={storeOrder} refunds={refunds} /><PortalHost /></>;
const confirm = () => screen.getByTestId('order-refund-confirm');
const giveReason = async () => fireEvent.change(await screen.findByTestId('order-refund-reason'), { target: { value: ' Damaged ' } });
const twelve = formatMoney({ amount: 1200, currency: 'EUR' });

beforeEach(async () => {
  sessionState.session = { baseUrl: 'https://store.test', email: 'admin@store.test', token: 't', capabilities: REFUND_ON };
  vi.mocked(useRegister).mockReturnValue({ ...openRegisterFixture(), commandTransport: () => ({ send }) });
  send.mockReset();
  db = await createRxDatabase({ name: `refunds${randomToken(8)}`, storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }) });
  ({ pos_refunds: refunds } = await db.addCollections({ pos_refunds: posRefundCollection() }));
});
afterEach(async () => { cleanup(); await db.remove(); vi.clearAllMocks(); });

describe('Refund all (ADR 0026)', () => {
  it('capability off', async () => {
    for (const capabilities of [{}, { orderRefund: 1, pluginContract: 4 }, { orderRefund: 0, pluginContract: 5 }] as ServerCapabilities[]) {
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

  it('double submit', async () => {
    let answer!: () => void;
    send.mockImplementation((batch) => new Promise((resolve) => { answer = () => resolve(applied(batch)); }));
    render(sheet());
    fireEvent.click(await screen.findByTestId('order-detail-refund'));
    const dialog = within(await screen.findByTestId('order-refund-dialog'));
    expect(dialog.getByTestId('order-refund-total').textContent).toBe(`Refund ${twelve}`);
    expect(dialog.getByTestId('order-refund-destination').textContent).toBe('To Cash');
    expect(dialog.queryByTestId('order-refund-already')).toBeNull();
    // The plugin refuses a blank reason, so Confirm waits for one.
    expect(confirm().getAttribute('aria-disabled')).toBe('true');
    expect(dialog.getByTestId('order-refund-hold')).toBeTruthy();
    await giveReason();
    fireEvent.click(confirm());
    fireEvent.click(confirm());
    await waitFor(() => expect(confirm().getAttribute('aria-disabled')).toBe('true'));
    fireEvent.click(confirm());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await act(async () => answer());
    expect((await screen.findByTestId('order-detail-refunded')).textContent).toBe(`Refunded ${twelve}`);
    expect(screen.queryByTestId('order-refund-dialog')).toBeNull();
    expect(screen.queryByTestId('order-detail-refund')).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0][0][0];
    expect(sent).toMatchObject({ type: 'order.refund', version: 1, attempt: 1, payload: { orderId: 'order_1', clientOrderId: order.id,
      lines: [{ orderLineId: 'line_1', quantity: 1, restock: true }], shippingMinor: 0, adjustmentMinor: 0, totalMinor: 1200,
      destination: 'cash', reason: 'Damaged', registerId: 'register-1', sessionId: 'session-1' } });
  });

  it('retry reuses', async () => {
    send.mockResolvedValueOnce({ kind: 'retry', reason: 'network' }).mockResolvedValueOnce({ kind: 'refused', status: 503, reason: 'status_503' })
      .mockImplementationOnce(async (batch) => applied(batch));
    const view = render(sheet());
    fireEvent.click(await screen.findByTestId('order-detail-refund'));
    await giveReason();
    fireEvent.click(await screen.findByTestId('order-refund-confirm'));
    expect((await screen.findByTestId('order-refund-error')).textContent).toContain('did not answer');
    fireEvent.click(confirm());
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect((await screen.findByTestId('order-refund-error')).textContent).toContain('status_503');
    // Closing the sale and opening it again opens the dialog on the unsent refund's own envelope.
    view.rerender(sheet(false));
    view.rerender(sheet());
    await waitFor(() => expect(confirm().getAttribute('aria-disabled')).not.toBe('true'));
    fireEvent.click(confirm());
    await screen.findByTestId('order-detail-refunded');
    const [first, second, third] = send.mock.calls.map(([batch]) => batch[0]);
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(third.payload.clientRefundId).toBe(first.payload.clientRefundId);
    expect(await refunds.count().exec()).toBe(1);
  });

  it('refusals', async () => {
    for (const code of ['forbidden', 'no_open_session', 'amount_mismatch']) {
      send.mockReset().mockImplementation(async (batch) => rejected(code)(batch));
      const view = render(sheet());
      fireEvent.click(await screen.findByTestId('order-detail-refund'));
      await giveReason();
      fireEvent.click(await screen.findByTestId('order-refund-confirm'));
      expect((await screen.findByTestId('order-refund-error')).textContent).toBe(`The store refused: ${code}`);
      expect(screen.queryByTestId('order-detail-refunded')).toBeNull();
      expect(screen.getByTestId('order-refund-dialog')).toBeTruthy();
      view.unmount();
      await refunds.find().remove();
    }
  });

  it('a rejection then Confirm sends a new command for the same refund', async () => {
    send.mockImplementationOnce(async (batch) => rejected('amount_mismatch')(batch)).mockImplementationOnce(async (batch) => applied(batch));
    render(sheet());
    fireEvent.click(await screen.findByTestId('order-detail-refund'));
    await giveReason();
    fireEvent.click(await screen.findByTestId('order-refund-confirm'));
    expect((await screen.findByTestId('order-refund-error')).textContent).toBe('The store refused: amount_mismatch');
    await waitFor(() => expect(confirm().getAttribute('aria-disabled')).not.toBe('true'));
    fireEvent.click(confirm());
    await screen.findByTestId('order-detail-refunded');
    expect(send).toHaveBeenCalledTimes(2);
    const [first, second] = send.mock.calls.map(([batch]) => batch[0]);
    expect(second.id).not.toBe(first.id);
    expect(second.payload.clientRefundId).toBe(first.payload.clientRefundId);
    const records = (await refunds.find().exec()).map((doc) => doc.toJSON());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: first.payload.clientRefundId, commandId: second.id, status: 'applied' });
  });

  it('a reason over 500 characters sends nothing', async () => {
    send.mockImplementation(async (batch) => applied(batch));
    render(sheet());
    fireEvent.click(await screen.findByTestId('order-detail-refund'));
    const reasonField = await screen.findByTestId('order-refund-reason');
    expect(reasonField.getAttribute('maxlength')).toBe('500');
    fireEvent.change(reasonField, { target: { value: 'x'.repeat(501) } });
    await act(async () => { fireEvent.click(confirm()); });
    expect(send).not.toHaveBeenCalled();
    expect(await refunds.count().exec()).toBe(0);
    // 500 is the plugin's limit and goes out.
    fireEvent.change(reasonField, { target: { value: 'x'.repeat(500) } });
    fireEvent.click(confirm());
    await screen.findByTestId('order-detail-refunded');
    expect(send.mock.calls[0][0][0].payload.reason).toHaveLength(500);
  });

  it('receipt after refund', async () => {
    send.mockImplementation(async (batch) => applied(batch));
    const view = render(sheet());
    fireEvent.click(await screen.findByTestId('order-detail-refund'));
    await giveReason();
    fireEvent.click(await screen.findByTestId('order-refund-confirm'));
    await screen.findByTestId('order-detail-refunded');
    fireEvent.click(screen.getByTestId('order-detail-receipt'));
    expect(within(await screen.findByTestId('order-detail-receipt-view')).getByText('Blue shirt')).toBeTruthy();
    // Opened again, the sale reads Refunded from this till's record and offers no second refund.
    view.rerender(sheet(false));
    view.rerender(sheet());
    expect((await screen.findByTestId('order-detail-refunded')).textContent).toBe(`Refunded ${twelve}`);
    expect(screen.queryByTestId('order-detail-refund')).toBeNull();
  });

  it('the dialog shows Already refunded when the order has refunds', async () => {
    // Paid 1200, an earlier 200 refunded: the offer is min(1200, 1200 − 200) = 1000.
    const refundedOrder: StoreOrder = { ...storeOrder, refunds: [{ id: 'r1', amountMinor: 200 }] };
    render(<><OrderDetailSheet order={order} onClose={vi.fn()} formatDate={(iso) => iso.slice(0, 10)} onRetry={vi.fn()} onFlush={vi.fn()}
      storeOrder={refundedOrder} refunds={refunds} /><PortalHost /></>);
    fireEvent.click(await screen.findByTestId('order-detail-refund'));
    const dialog = within(await screen.findByTestId('order-refund-dialog'));
    expect(dialog.getByTestId('order-refund-already').textContent).toBe(`Already refunded ${formatMoney({ amount: 200, currency: 'EUR' })}`);
    expect(dialog.getByTestId('order-refund-total').textContent).toBe(`Refund ${formatMoney({ amount: 1000, currency: 'EUR' })}`);
  });
});

describe('needs_admin (#545)', () => {
  it.each(['session_closed', 'money_unconfirmed'])('shows the store message and the notice for %s instead of Confirm', async (reason) => {
    const message = `Store response: ${reason}`;
    send.mockImplementationOnce(parked(reason, message));
    render(sheet());
    fireEvent.click(await screen.findByTestId('order-detail-refund'));
    await giveReason();
    fireEvent.click(confirm());
    expect((await screen.findByTestId('refund-needs-admin-line')).textContent).toBe(refundNeedsAdminLine(reason));
    expect(screen.getByTestId('refund-needs-admin-message').textContent).toBe(message);
    expect(screen.queryByTestId('order-refund-error')).toBeNull();
    expect(screen.queryByTestId('order-refund-confirm')).toBeNull();
  });

  it('Check again applies the same envelope and closes the dialog', async () => {
    send.mockImplementationOnce(parked('session_closed', 'Store response')).mockImplementationOnce(async (batch) => applied(batch));
    render(sheet());
    fireEvent.click(await screen.findByTestId('order-detail-refund'));
    await giveReason();
    fireEvent.click(confirm());
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
    const view = render(sheet());
    fireEvent.click(await screen.findByTestId('order-detail-refund'));
    await giveReason();
    fireEvent.click(confirm());
    await screen.findByTestId('refund-needs-admin-line');
    const record = await refunds.findOne().exec();
    view.rerender(sheet(false));
    view.rerender(sheet());
    expect((await screen.findByTestId('refund-needs-admin-line')).textContent).toBe(refundNeedsAdminLine('session_closed'));
    expect(screen.getByTestId('refund-needs-admin-message').textContent).toBe('Stored response');
    expect(send).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('refund-needs-admin-check-again'));
    await screen.findByTestId('order-detail-refunded');
    expect(send.mock.calls[1][0][0].id).toBe(record?.envelope.id);
  });

  it('keeps the notice alongside the error after an unreachable store', async () => {
    send.mockImplementationOnce(parked('money_unconfirmed', 'Store response')).mockResolvedValueOnce({ kind: 'retry', reason: 'network' });
    render(sheet());
    fireEvent.click(await screen.findByTestId('order-detail-refund'));
    await giveReason();
    fireEvent.click(confirm());
    fireEvent.click(await screen.findByTestId('refund-needs-admin-check-again'));
    expect((await screen.findByTestId('order-refund-error')).textContent).toBe('The store did not answer. Try again.');
    expect(screen.getByTestId('refund-needs-admin-line').textContent).toBe(refundNeedsAdminLine('money_unconfirmed'));
    expect(screen.getByTestId('refund-needs-admin-message').textContent).toBe('Store response');
    expect(screen.queryByTestId('order-refund-confirm')).toBeNull();
  });

  it('clears the notice after rejection and Confirm sends a new command', async () => {
    send.mockImplementationOnce(parked('money_unconfirmed', 'Store response'))
      .mockImplementationOnce(async (batch) => rejected('amount_mismatch')(batch)).mockImplementationOnce(async (batch) => applied(batch));
    render(sheet());
    fireEvent.click(await screen.findByTestId('order-detail-refund'));
    await giveReason();
    fireEvent.click(confirm());
    fireEvent.click(await screen.findByTestId('refund-needs-admin-check-again'));
    expect((await screen.findByTestId('order-refund-error')).textContent).toBe('The store refused: amount_mismatch');
    expect(screen.queryByTestId('refund-needs-admin-line')).toBeNull();
    expect(screen.queryByTestId('refund-needs-admin-check-again')).toBeNull();
    fireEvent.click(confirm());
    await screen.findByTestId('order-detail-refunded');
    const [first, second, third] = send.mock.calls.map(([batch]) => batch[0]);
    expect(second.id).toBe(first.id);
    expect(third.id).not.toBe(second.id);
    expect(third.payload.clientRefundId).toBe(first.payload.clientRefundId);
  });
});
