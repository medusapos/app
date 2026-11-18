// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { addRxPlugin, createRxDatabase, randomToken, type RxCollection, type RxDatabase } from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { addPrinterProfileCollection, PrintError, type PosOrder, type PrinterProfile, type PrintTransport } from '@tallyui/pos';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_PRINTER, ensureBuiltInPrinter, printerTestPage, printTestPage, usePrinterProfiles } from './printers';

addRxPlugin(RxDBDevModePlugin);

const opened: RxDatabase[] = [];
async function database() {
  const db = await createRxDatabase({ name: `printers${randomToken(8)}`, storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }) });
  opened.push(db);
  return { db, printers: await addPrinterProfileCollection(db) };
}
afterEach(async () => { await Promise.all(opened.splice(0).map((db) => db.close())); });

const counter: PrinterProfile = { id: 'counter', name: 'Counter', connectionType: 'network', address: '10.0.0.5', port: 9100 };
const fakeTransport = (): PrintTransport & { print: ReturnType<typeof vi.fn> } => ({ name: 'fake', print: vi.fn().mockResolvedValue(undefined) });

describe('printers', () => {
  it('ensureBuiltInPrinter inserts exactly the built-in printer, and a second call leaves one doc', async () => {
    const { printers } = await database();
    await ensureBuiltInPrinter(printers);
    expect((await printers.find().exec()).map((doc) => doc.toJSON())).toEqual([BUILT_IN_PRINTER]);
    await ensureBuiltInPrinter(printers);
    expect(await printers.count().exec()).toBe(1);
  });

  it('never overwrites a built-in printer already there, even renamed', async () => {
    const { printers } = await database();
    await printers.insert({ ...BUILT_IN_PRINTER, name: 'Counter dialog' });
    await ensureBuiltInPrinter(printers);
    expect((await printers.find().exec()).map((doc) => doc.toJSON())).toEqual([{ ...BUILT_IN_PRINTER, name: 'Counter dialog' }]);
  });

  it('printerTestPage names the printer and store, escaped, with no script', () => {
    const page = printerTestPage({ printerName: 'Print dialog', storeName: '<b>A & B</b>', now: new Date(2026, 10, 19, 9, 30) });
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).toContain('<title>Test print</title>');
    expect(page).toContain('<h1>Test print</h1>');
    expect(page).toContain('Print dialog');
    expect(page).toContain('&lt;b&gt;A &amp; B&lt;/b&gt;');
    expect(page).not.toContain('<b>');
    expect(page).toContain('If you can read this, the printer works.');
    expect(page).not.toContain('<script');
    expect(printerTestPage({ printerName: `"Q" & 'A'`, storeName: 'S' })).toContain('&quot;Q&quot; &amp; &#39;A&#39;');
  });

  it('printTestPage sends a test job to the system printer, and refuses a printer with no transport', async () => {
    const transport = fakeTransport();
    await printTestPage(BUILT_IN_PRINTER, '<p>hi</p>', transport);
    expect(transport.print).toHaveBeenCalledOnce();
    expect(transport.print.mock.calls[0]![0]).toMatchObject({ kind: 'test', html: '<p>hi</p>' });
    const other = fakeTransport();
    const refused = await printTestPage(counter, '<p>hi</p>', other).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PrintError);
    expect((refused as PrintError).code).toBe('unsupported');
    expect(other.print).not.toHaveBeenCalled();
  });

  it('usePrinterProfiles is the built-in alone with no orders, else the live collection, built-in first', async () => {
    expect(renderHook(() => usePrinterProfiles(null)).result.current).toEqual([BUILT_IN_PRINTER]);
    const bare = await createRxDatabase({ name: `printers${randomToken(8)}`, storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }) });
    opened.push(bare);
    expect(renderHook(() => usePrinterProfiles({ database: bare } as unknown as RxCollection<PosOrder>)).result.current).toEqual([BUILT_IN_PRINTER]);

    const { db, printers } = await database();
    await printers.bulkInsert([{ ...counter, name: 'Aisle' }, BUILT_IN_PRINTER]);
    const orders = { database: db } as unknown as RxCollection<PosOrder>;
    const { result, unmount } = renderHook(() => usePrinterProfiles(orders));
    await waitFor(() => expect(result.current).toEqual([BUILT_IN_PRINTER, { ...counter, name: 'Aisle' }]));
    await (await printers.findOne('counter').exec())!.incrementalPatch({ name: 'Back office' });
    await waitFor(() => expect(result.current).toEqual([BUILT_IN_PRINTER, { ...counter, name: 'Back office' }]));
    unmount();
    expect(await printers.count().exec()).toBe(2);
  });
});
