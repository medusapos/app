// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRxDatabase, randomToken, type RxDatabase } from 'rxdb';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortalHost } from '@tallyui/primitives';
import { formatMoney, type OrderRefundEnvelope, type ServerCapabilities, type StoreOrder } from '@tallyui/core';
import {
  createOrderBuilder, finalizeOrder, posRefundCollection, type PosOrder, type PosRefundCollection, type TransportOutcome,
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
});
