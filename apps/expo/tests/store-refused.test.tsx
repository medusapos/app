// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { COMMANDS_PATH } from '@tallyui/core';
import { createOrderBuilder, finalizeOrder } from '@tallyui/pos';
import { OutboxProvider, useOutboxContext } from '../lib/outbox-context';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { OutboxStrip } from '../components/store-refused';

let outbox: ReturnType<typeof useOutboxContext>;
let sequence = 0;
const fetchStub = vi.fn<typeof fetch>();
function Harness() { outbox = useOutboxContext(); return null; }
function sale() {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
  builder.addPayment({ method: 'cash', amountMinor: 1200 });
  return finalizeOrder(builder.getSnapshot(), { registerId: 'register-1' });
}
function mount(signedIn = true) {
  if (signedIn) saveSession(localStorage, { baseUrl: `https://refused-${++sequence}.test`, email: 'cashier@test.com',
    token: `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 }))}.signature` });
  render(<SessionProvider><OutboxProvider><OutboxStrip><Harness /></OutboxStrip></OutboxProvider></SessionProvider>);
}
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  fetchStub.mockReset().mockResolvedValue(new Response(JSON.stringify({ code: 'unsupported_protocol' }), { status: 400 }));
  vi.stubGlobal('fetch', fetchStub);
});
afterEach(async () => {
  const db = outbox.orders?.database;
  cleanup();
  if (db) await waitFor(() => expect(db.closed).toBe(true));
  vi.unstubAllGlobals();
});

it('keeps refused sales pending, explains the refusal, and sends them when Try again succeeds', async () => {
  mount();
  await waitFor(() => expect(outbox.orders).not.toBeNull());
  expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
  const order = sale();
  await act(async () => { await outbox.record(order); });
  await waitFor(() => expect(outbox.state.refused).toEqual({ status: 400, reason: 'unsupported_protocol' }));
  expect(fetchStub).toHaveBeenCalledTimes(1);
  expect(String(fetchStub.mock.calls[0][0])).toMatch(COMMANDS_PATH);
  expect((await outbox.orders!.findOne(order.id).exec())!.toMutableJSON()).toEqual(order);
  const strip = screen.getByText('1 sale not accepted ·').parentElement!.parentElement!;
  expect(getComputedStyle(strip).position).toBe('absolute');
  expect(getComputedStyle(strip).top).toBe('0px');
  expect(strip.getAttribute('data-print')).toBe('hide');
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByRole('heading', { name: 'Not accepted by the store' })).toBeTruthy();
  expect(screen.getByText('1 sale is kept on this register and has not been sent. The store said: unsupported_protocol (HTTP 400).')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  let respond!: (response: Response) => void;
  fetchStub.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button', { name: 'Try again' }).getAttribute('aria-disabled')).toBe('true');
  await act(async () => { respond(new Response(JSON.stringify({ results: [{ id: order.commandId, status: 'applied',
    serverRefs: { orderId: 'server-1', totalMinor: 1200 } }] }))); });
  await waitFor(() => expect(outbox.recent[0].syncStatus).toBe('applied'));
  expect(outbox.state.refused).toBeUndefined();
  expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

it('uses plural sales copy for a refused batch', async () => {
  mount();
  await waitFor(() => expect(outbox.orders).not.toBeNull());
  await act(async () => { await outbox.orders!.bulkInsert([sale(), sale()]); await outbox.flush(); });
  expect(screen.getByText('2 sales not accepted ·')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByText('2 sales are kept on this register and have not been sent. The store said: unsupported_protocol (HTTP 400).')).toBeTruthy();
  expect(outbox.recent.every((order) => order.syncStatus === 'pending')).toBe(true);
});

it('requeues through the current real outbox', async () => {
  mount();
  await waitFor(() => expect(outbox.orders).not.toBeNull());
  const order = sale();
  fetchStub.mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ id: order.commandId, status: 'rejected',
    error: { code: 'invalid', message: 'Unknown variant' } }] })));
  await act(async () => { await outbox.record(order); });
  await waitFor(() => expect(outbox.recent[0].syncStatus).toBe('rejected'));
  await act(async () => { expect(await outbox.requeue([order.id])).toBe(1); });
  await waitFor(() => expect(outbox.state.refused).toBeTruthy());
  expect(outbox.recent[0].syncStatus).toBe('pending');
  expect(outbox.recent[0].commandId).not.toBe(order.commandId);
});

it('returns zero from requeue when no outbox is open', async () => {
  mount(false);
  expect(await outbox.requeue(['missing'])).toBe(0);
  expect(await outbox.requeue()).toBe(0);
  expect(fetchStub).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
});
