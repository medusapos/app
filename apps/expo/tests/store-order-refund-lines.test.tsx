// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerCapabilities, StoreOrder, SyncContext } from '@tallyui/core';
import type { Session } from '../lib/session';
import { useStoreOrderWithRefundLines } from '../lib/store-orders';

const { getOrders } = vi.hoisted(() => ({ getOrders: vi.fn<(context: SyncContext, ids: readonly string[]) => Promise<StoreOrder[]>>() }));
vi.mock('../lib/pos-connector', () => ({
  createPosConnector: () => ({ id: 'medusa', getOrders }),
  authHeaders: () => ({ Authorization: 'Bearer t' }),
  storeOrderFilters: () => [],
}));

const makeSession = (pluginContract: number): Session => ({ baseUrl: 'https://store.test', email: 'ada@store.test', token: 't',
  capabilities: { pluginContract } as unknown as ServerCapabilities });
// One object per contract, as the session context hands the screen: a new capabilities object would read again.
const SESSION_6 = makeSession(6);
const SESSION_5 = makeSession(5);
const line = { id: 'line_1', name: 'Blue shirt', quantity: 2, subtotalMinor: 1200, subtotalTaxMinor: 0, totalMinor: 1200, taxMinor: 0 };
function storeOrder(refunds: StoreOrder['refunds'] = [{ id: 'refund_01', amountMinor: 600 }]): StoreOrder {
  return {
    id: 'order_1', reference: '1001', status: 'completed', placedAt: '2026-11-26T09:00:00.000Z', currency: 'EUR', customer: null,
    pricesIncludeTax: false, lines: [line], fees: [], shipping: [], coupons: [], taxLines: [], discountMinor: 0,
    discountTaxMinor: 0, taxMinor: 0, totalMinor: 1200, payments: [{ id: 'pay_1', method: 'cash', amountMinor: 1200 }],
    refunds,
  };
}
const withLines = (quantity = 1): StoreOrder => storeOrder([{ id: 'refund_01', amountMinor: 600,
  lines: [{ orderLineId: 'line_1', quantity, netMinor: 600 * quantity, taxMinor: 0 }] }]);
function deferred() {
  let resolve!: (orders: StoreOrder[]) => void;
  const promise = new Promise<StoreOrder[]>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { cleanup(); getOrders.mockReset(); });

describe('useStoreOrderWithRefundLines', () => {
  it('L1: at contract 6 reads the open order once through getOrders with the capabilities, and returns its refund lines', async () => {
    const read = withLines();
    getOrders.mockResolvedValue([read]);
    const listed = storeOrder();
    const { result } = renderHook(() => useStoreOrderWithRefundLines(SESSION_6, listed, 0));
    expect(result.current).toBe(listed);
    await waitFor(() => expect(result.current).toBe(read));
    expect(getOrders).toHaveBeenCalledTimes(1);
    const [context, ids] = getOrders.mock.calls[0]!;
    expect(ids).toEqual(['order_1']);
    expect(context).toMatchObject({ connectorId: 'medusa', baseUrl: 'https://store.test',
      headers: { Authorization: 'Bearer t' }, capabilities: { pluginContract: 6 } });
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(result.current?.refunds[0]?.lines).toEqual([{ orderLineId: 'line_1', quantity: 1, netMinor: 600, taxMinor: 0 }]);
  });

  it('L2: at contract 5 never calls getOrders and returns the list order', async () => {
    const listed = storeOrder();
    const { result } = renderHook(() => useStoreOrderWithRefundLines(SESSION_5, listed, 0));
    await act(async () => {});
    expect(getOrders).not.toHaveBeenCalled();
    expect(result.current).toBe(listed);
  });

  it('L3: an order with no refunds, or no order, never calls getOrders', async () => {
    const listed = storeOrder([]);
    const { result } = renderHook(() => useStoreOrderWithRefundLines(SESSION_6, listed, 0));
    const none = renderHook(() => useStoreOrderWithRefundLines(SESSION_6, null, 0));
    await act(async () => {});
    expect(getOrders).not.toHaveBeenCalled();
    expect(result.current).toBe(listed);
    expect(none.result.current).toBeNull();
  });

  it('L4: a failed read returns the list order and throws nothing', async () => {
    getOrders.mockRejectedValue(new Error('offline'));
    const listed = storeOrder();
    const { result } = renderHook(() => useStoreOrderWithRefundLines(SESSION_6, listed, 0));
    await act(async () => {});
    expect(getOrders).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(listed);
  });

  it('L5: a change of applied count reads again, and an older answer arriving last never replaces the newer one', async () => {
    const first = deferred();
    const second = deferred();
    getOrders.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const listed = storeOrder();
    const { result, rerender } = renderHook(({ applied }) => useStoreOrderWithRefundLines(SESSION_6, listed, applied),
      { initialProps: { applied: 0 } });
    rerender({ applied: 1 });
    expect(getOrders).toHaveBeenCalledTimes(2);
    expect(getOrders.mock.calls[0]![0].signal?.aborted).toBe(true);
    const newer = withLines(2);
    await act(async () => { second.resolve([newer]); });
    expect(result.current).toBe(newer);
    await act(async () => { first.resolve([withLines(1)]); });
    expect(result.current).toBe(newer);
  });

  it('L6: switching orders returns the new listed order until its own read resolves', async () => {
    const firstRead = withLines();
    const second = deferred();
    getOrders.mockResolvedValueOnce([firstRead]).mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(({ listed }) => useStoreOrderWithRefundLines(SESSION_6, listed, 0),
      { initialProps: { listed: storeOrder() } });
    await waitFor(() => expect(result.current).toBe(firstRead));

    const refund = { id: 'refund_02', amountMinor: 1200 };
    const secondListed = { ...storeOrder([refund]), id: 'order_2' };
    rerender({ listed: secondListed });
    expect(getOrders).toHaveBeenNthCalledWith(2, expect.anything(), ['order_2']);
    expect(result.current).toBe(secondListed);
    expect(result.current?.id).toBe('order_2');

    const secondRead = { ...secondListed, refunds: [{ ...refund,
      lines: [{ orderLineId: 'line_1', quantity: 2, netMinor: 1200, taxMinor: 0 }] }] };
    await act(async () => { second.resolve([secondRead]); });
    expect(result.current).toBe(secondRead);
  });
});
