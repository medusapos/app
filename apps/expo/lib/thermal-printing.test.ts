// @vitest-environment jsdom
import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { addRxPlugin, createRxDatabase, randomToken, type RxCollection, type RxDatabase } from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import {
  addPrinterProfileCollection, escpos, openDrawerJob, type PosOrder, type PosOrderPayment, type PrinterProfile, type SaleStage,
} from '@tallyui/pos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoPrintReceipt } from './printing-settings';
import { BUILT_IN_PRINTER } from './printers';
import { drawerPrinter, isStoredOpensDrawer, openCashDrawer, printTestReceipt, printToNetwork, useCashDrawerOnSale } from './thermal-printing';

addRxPlugin(RxDBDevModePlugin);

const opened: RxDatabase[] = [];
async function ordersWith(...profiles: PrinterProfile[]) {
  const db = await createRxDatabase({ name: `thermal${randomToken(8)}`, storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }) });
  opened.push(db);
  const printers = await addPrinterProfileCollection(db);
  if (profiles.length > 0) await printers.bulkInsert(profiles);
  return { database: db } as unknown as RxCollection<PosOrder>;
}

const OK = '<response success="true" code="" status="0" battery="0"/>';
const fetchMock = vi.fn();
const answer = (body: string) => fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => body });
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchMock.mockReset();
  answer(OK);
  vi.stubGlobal('fetch', fetchMock);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllGlobals();
  warn.mockRestore();
  await Promise.all(opened.splice(0).map((db) => db.close()));
});

const epson: PrinterProfile = {
  id: 'counter', name: 'Counter', connectionType: 'network', vendor: 'epson', address: '10.0.0.5', port: 9100,
  language: 'esc-pos', autoOpenDrawer: true,
};
const star: PrinterProfile = { ...epson, id: 'star', name: 'Star', vendor: 'star' };
const EPOS_URL = 'http://10.0.0.5:8008/cgi-bin/epos/service.cgi?devid=local_printer&timeout=10000';
const hexOf = (body: unknown) => String(body).match(/<command>([0-9a-f]*)<\/command>/)?.[1];
const sentHex = () => fetchMock.mock.calls.map(([, init]) => hexOf((init as RequestInit).body));

// What a printer would be sent, recorded by a sink instead of a network request.
async function bytesSent(profile: PrinterProfile): Promise<number[]> {
  const writes: Uint8Array[] = [];
  await printToNetwork(profile, openDrawerJob(profile, `bytes-${profile.id}-${profile.drawerConnector ?? 'pin2'}`),
    { write: async (bytes) => { writes.push(bytes); } });
  return writes.flatMap((bytes) => [...bytes]);
}

describe('drawer pulse bytes', () => {
  it('Epson is DLE DC4 1 m 3, pin 2 then pin 5', async () => {
    expect(await bytesSent(epson)).toEqual([0x10, 0x14, 0x01, 0x00, 0x03]);
    expect(await bytesSent({ ...epson, drawerConnector: 'pin5' })).toEqual([0x10, 0x14, 0x01, 0x01, 0x03]);
  });

  it('Star is ESC p m 25 250, the ESC/POS builder pulse, pin 2 then pin 5', async () => {
    expect(await bytesSent(star)).toEqual([...escpos().pulse('pin2').bytes()]);
    expect(await bytesSent(star)).toEqual([0x1b, 0x70, 0x00, 25, 250]);
    expect(await bytesSent({ ...star, drawerConnector: 'pin5' })).toEqual([...escpos().pulse('pin5').bytes()]);
    expect(await bytesSent({ ...star, drawerConnector: 'pin5' })).toEqual([0x1b, 0x70, 0x01, 25, 250]);
  });
});

describe('openCashDrawer', () => {
  it('posts the Epson pulse to the printer over ePOS-Print', async () => {
    await openCashDrawer(await ordersWith(epson));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(EPOS_URL);
    expect((init as RequestInit).method).toBe('POST');
    expect(String((init as RequestInit).body)).toContain('<command>1014010003</command>');
    expect(warn).not.toHaveBeenCalled();
  });

  it('kicks the default drawer printer when two have the switch on, and only one', async () => {
    const back = { ...epson, id: 'back', name: 'Aisle', address: '10.0.0.9' };
    await openCashDrawer(await ordersWith(back, { ...epson, isDefault: true }));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([EPOS_URL]);
    expect(drawerPrinter([back, { ...epson, autoOpenDrawer: false }])).toBe(back);
  });

  it.each([
    ['no orders yet', null],
    ['no printers', []],
    ['only the built-in printer', [BUILT_IN_PRINTER]],
    ['the switch off', [{ ...epson, autoOpenDrawer: false }]],
    ['the switch unset', [{ ...epson, autoOpenDrawer: undefined }]],
    ['a system printer with the switch on', [{ ...BUILT_IN_PRINTER, id: 'dialog', isBuiltIn: false, autoOpenDrawer: true }]],
    ['a generic vendor', [{ ...epson, vendor: 'generic' as const }]],
    ['StarPRNT language', [{ ...star, language: 'star-prnt' as const }]],
    ['no address', [{ ...epson, address: undefined }]],
  ])('sends nothing and resolves with %s', async (_, profiles) => {
    const orders = profiles === null ? null : await ordersWith(...profiles);
    await expect(openCashDrawer(orders)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('only warns, once, when the printer is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(openCashDrawer(await ordersWith(epson))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('only warns, once, when the printer answers success="false"', async () => {
    answer('<response success="false" code="EPTR_COVER_OPEN" status="0" battery="0"/>');
    await expect(openCashDrawer(await ordersWith(epson))).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('printTestReceipt', () => {
  it('prints the sample sale to the printer and never pulses its drawer', async () => {
    await printTestReceipt(epson, { name: 'Shop', currency: 'EUR' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const hex = sentHex()[0]!;
    expect(hex.length).toBeGreaterThan(100);
    expect(hex).not.toContain('101401');
    expect(hex).not.toContain('1b7000');
  });

  it('refuses a printer a browser cannot reach, sending nothing', async () => {
    await expect(printTestReceipt({ ...epson, vendor: 'generic' }, { name: 'Shop', currency: 'EUR' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

let saleCount = 0;
const cash = (amountMinor: number, extra: Partial<PosOrderPayment> = {}): PosOrderPayment =>
  ({ id: `pay-${amountMinor}-${extra.method ?? 'cash'}`, method: 'cash', amountMinor, ...extra });
// A finished sale's receipt stage; each test's own sale id, since a sale's drawer is kept for the whole tab.
function receipt(payments: PosOrderPayment[], id = `sale-${++saleCount}-${randomToken(4)}`): SaleStage {
  return { kind: 'receipt', order: { id }, posOrder: { id, payments } } as unknown as SaleStage;
}
const CART: SaleStage = { kind: 'cart' };
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

describe('useCashDrawerOnSale', () => {
  it.each([
    ['a cash sale', 1, [cash(1000)]],
    ['a split with one cash leg', 1, [cash(400), cash(600, { method: 'external' as const })]],
    ['an external sale', 0, [cash(1000, { method: 'external' as const })]],
    ['a card sale', 0, [cash(1000, { method: 'card' as PosOrderPayment['method'] })]],
    ['a sale whose only cash leg is already on the store', 0, [cash(1000, { storePaymentId: 'pay_1' })]],
    ['a sale whose only cash leg is zero, the rest external', 0, [cash(0), cash(1000, { method: 'external' as const })]],
  ])('%s opens the drawer %i time(s)', async (_, times, payments) => {
    const orders = await ordersWith(epson);
    const { rerender } = renderHook(({ stage }: { stage: SaleStage }) => useCashDrawerOnSale(stage, orders), { initialProps: { stage: CART as SaleStage } });
    rerender({ stage: receipt(payments) });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(times);
    if (times) expect(sentHex()).toEqual(['1014010003']);
  });

  it('never opens it again for the same sale: re-render, remount, the same sale again, or a reprint', async () => {
    const orders = await ordersWith(epson);
    const sale = receipt([cash(1000)]);
    const first = renderHook(({ stage }: { stage: SaleStage }) => useCashDrawerOnSale(stage, orders), { initialProps: { stage: sale } });
    await settle();
    first.rerender({ stage: { ...sale } as SaleStage });
    first.rerender({ stage: CART });
    first.rerender({ stage: sale });
    first.unmount();
    renderHook(() => useCashDrawerOnSale(sale, orders)).unmount();
    await settle();
    expect(fetchMock).toHaveBeenCalledOnce();
    // The next cash sale still opens it.
    renderHook(() => useCashDrawerOnSale(receipt([cash(500)]), orders));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('opens it once when "show receipt" is off and the paid screen goes straight back to a new sale', async () => {
    const orders = await ordersWith(epson);
    const sale = receipt([cash(1000)]);
    const { result } = renderHook(() => {
      const [stage, setStage] = useState<SaleStage>(sale);
      useAutoPrintReceipt(stage.kind === 'receipt' ? stage.order.id : undefined, false, () => {}, () => setStage(CART));
      useCashDrawerOnSale(stage, orders);
      return stage;
    });
    await settle();
    expect(result.current).toEqual(CART);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('never opens it for a sale first seen without cash, when it renders again with a cash leg', async () => {
    const orders = await ordersWith(epson);
    const id = `sale-later-cash-${randomToken(4)}`;
    const { rerender } = renderHook(({ stage }: { stage: SaleStage }) => useCashDrawerOnSale(stage, orders),
      { initialProps: { stage: receipt([cash(1000, { method: 'external' as const })], id) } });
    await settle();
    rerender({ stage: receipt([cash(1000)], id) });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves the sale whatever the printer does', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const orders = await ordersWith(epson);
    renderHook(() => useCashDrawerOnSale(receipt([cash(1000)]), orders));
    await settle();
    expect(warn).toHaveBeenCalledOnce();
  });
});

// The #597 review: Continue after a failed or hung save the outbox has stored starts a new sale, never the receipt, so
// the outbox's yes opens the drawer instead, once per sale, with the receipt's own memory of the sales it has seen.
describe('isStoredOpensDrawer', () => {
  const posOrder = (payments: PosOrderPayment[], id = `stored-${++saleCount}-${randomToken(4)}`) =>
    ({ id, payments }) as unknown as PosOrder;

  it('opens the drawer on a yes for a cash sale, and its answer passes through', async () => {
    const orders = await ordersWith(epson);
    const isStored = vi.fn(async () => true);
    const order = posOrder([cash(1000)]);
    await expect(isStoredOpensDrawer(isStored, orders)(order)).resolves.toBe(true);
    await settle();
    expect(isStored).toHaveBeenCalledExactlyOnceWith(order);
    expect(sentHex()).toEqual(['1014010003']);
  });

  it('opens nothing on a no, passes a rejection on, and opens nothing for an external sale', async () => {
    const orders = await ordersWith(epson);
    await expect(isStoredOpensDrawer(async () => false, orders)(posOrder([cash(1000)]))).resolves.toBe(false);
    const refused = new Error('storage closed');
    await expect(isStoredOpensDrawer(async () => { throw refused; }, orders)(posOrder([cash(1000)]))).rejects.toBe(refused);
    await expect(isStoredOpensDrawer(async () => true, orders)(posOrder([cash(1000, { method: 'external' as const })]))).resolves.toBe(true);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a hung save confirmed stored and then shown on the receipt, or a yes twice, opens it once', async () => {
    const orders = await ordersWith(epson);
    const isStored = isStoredOpensDrawer(async () => true, orders);
    const order = posOrder([cash(1000)]);
    await isStored(order);
    await isStored(order);
    renderHook(() => useCashDrawerOnSale({ kind: 'receipt', order: { id: order.id }, posOrder: order } as unknown as SaleStage, orders));
    await settle();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('remembers every sale: A by isStored, B by its receipt, then a late yes for A opens it twice in all', async () => {
    const orders = await ordersWith(epson);
    const isStored = isStoredOpensDrawer(async () => true, orders);
    const a = posOrder([cash(1000)]);
    await isStored(a);
    renderHook(() => useCashDrawerOnSale(receipt([cash(500)]), orders));
    await settle();
    await isStored(a);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('answers yes at once when the printer never answers', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const orders = await ordersWith({ ...epson, id: 'silent', name: 'Silent' });
    const answered = isStoredOpensDrawer(async () => true, orders)(posOrder([cash(1000)]));
    const late = new Promise((resolve) => { setTimeout(() => resolve('waited on the printer'), 500); });
    await expect(Promise.race([answered, late])).resolves.toBe(true);
    await settle();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
