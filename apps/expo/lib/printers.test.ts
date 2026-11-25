// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { addRxPlugin, createRxDatabase, randomToken, type RxCollection, type RxDatabase } from 'rxdb';
import { RxDBDevModePlugin } from 'rxdb/plugins/dev-mode';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import type { PrinterFormDraft } from '@tallyui/components';
import { addPrinterProfileCollection, PrintError, type PosOrder, type PrinterProfile, type PrinterProfileCollection, type PrintTransport } from '@tallyui/pos';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_PRINTER, deletePrinter, ensureBuiltInPrinter, PRINTER_REFUSALS, printerTestPage, printTestPage, savePrinter, usePrinterProfiles,
} from './printers';

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

  it('usePrinterProfiles shows the built-in alone while the live collection is empty, then the live list', async () => {
    const { db, printers } = await database();
    const orders = { database: db } as unknown as RxCollection<PosOrder>;
    const { result, unmount } = renderHook(() => usePrinterProfiles(orders));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current).toEqual([BUILT_IN_PRINTER]);
    await printers.insert(counter);
    await waitFor(() => expect(result.current).toEqual([counter]));
    unmount();
  });
});

describe('savePrinter and deletePrinter', () => {
  const draft = (extra: Partial<PrinterFormDraft> = {}): PrinterFormDraft => ({
    name: 'Counter', connectionType: 'network', vendor: 'epson', address: '10.0.0.5', port: 9100, language: 'esc-pos', ...extra,
  });
  const all = async (printers: PrinterProfileCollection) =>
    (await printers.find().exec()).map((doc) => doc.toJSON() as PrinterProfile).sort((a, b) => a.name.localeCompare(b.name));

  it.each([
    ['a system printer', { connectionType: 'system' as const }, PRINTER_REFUSALS.system],
    ['a generic vendor', { vendor: 'generic' as const }, PRINTER_REFUSALS.vendor],
    ['no vendor', { vendor: undefined }, PRINTER_REFUSALS.vendor],
    ['StarPRNT', { vendor: 'star' as const, language: 'star-prnt' as const }, PRINTER_REFUSALS.language],
    ['Star Line', { vendor: 'star' as const, language: 'star-line' as const }, PRINTER_REFUSALS.language],
    ['the built-in flag', { isBuiltIn: true }, PRINTER_REFUSALS.builtIn],
  ])('refuses %s and writes nothing', async (_, extra, refusal) => {
    const { printers } = await database();
    expect(await savePrinter(printers, draft(extra))).toBe(refusal);
    expect(await printers.count().exec()).toBe(0);
  });

  it('adds a printer with a fresh id and its name trimmed', async () => {
    const { printers } = await database();
    expect(await savePrinter(printers, draft({ name: '  Counter  ', autoOpenDrawer: true, drawerConnector: 'pin5' }))).toBeNull();
    const [saved] = await all(printers);
    expect(saved).toEqual({ ...draft({ autoOpenDrawer: true, drawerConnector: 'pin5' }), id: saved!.id });
    expect(saved!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a name another printer has, trimmed and in any case, but not the printer itself', async () => {
    const { printers } = await database();
    await printers.insert({ ...draft(), id: 'counter' });
    expect(await savePrinter(printers, draft({ name: ' counter ' }))).toBe(PRINTER_REFUSALS.name);
    expect(await printers.count().exec()).toBe(1);
    expect(await savePrinter(printers, draft({ name: 'COUNTER', address: '10.0.0.6' }), 'counter')).toBeNull();
    expect(await all(printers)).toEqual([{ ...draft({ name: 'COUNTER', address: '10.0.0.6' }), id: 'counter' }]);
  });

  it('replaces a printer whole, so a key the form dropped leaves no stale value', async () => {
    const { printers } = await database();
    await printers.insert({ ...draft({ autoOpenDrawer: true, drawerConnector: 'pin5', isDefault: true }), id: 'counter' });
    expect(await savePrinter(printers, draft(), 'counter')).toBeNull();
    expect(await all(printers)).toEqual([{ ...draft(), id: 'counter' }]);
  });

  it('set as default clears it on the other printers, never on the built-in', async () => {
    const { printers } = await database();
    await printers.bulkInsert([{ ...BUILT_IN_PRINTER, isDefault: true }, { ...draft({ name: 'Aisle', isDefault: true }), id: 'aisle' }]);
    expect(await savePrinter(printers, draft({ isDefault: true }), 'counter')).toBeNull();
    expect(await all(printers)).toEqual([
      { ...draft({ name: 'Aisle', isDefault: false }), id: 'aisle' },
      { ...draft({ isDefault: true }), id: 'counter' },
      { ...BUILT_IN_PRINTER, isDefault: true },
    ]);
  });

  it('never edits the built-in printer', async () => {
    const { printers } = await database();
    await printers.insert(BUILT_IN_PRINTER);
    expect(await savePrinter(printers, draft(), BUILT_IN_PRINTER.id)).toBe(PRINTER_REFUSALS.builtIn);
    expect(await all(printers)).toEqual([BUILT_IN_PRINTER]);
  });

  it('reports a failed write as the form\'s refusal', async () => {
    const { printers } = await database();
    vi.spyOn(printers, 'bulkUpsert').mockRejectedValueOnce(new Error('disk full'));
    expect(await savePrinter(printers, draft())).toBe(PRINTER_REFUSALS.failed);
    vi.spyOn(printers, 'bulkUpsert').mockResolvedValueOnce({ success: [], error: [{} as never] });
    expect(await savePrinter(printers, draft())).toBe(PRINTER_REFUSALS.failed);
    expect(await printers.count().exec()).toBe(0);
  });

  it('deletes a printer, never the built-in one, and ignores an unknown id', async () => {
    const { printers } = await database();
    await printers.bulkInsert([BUILT_IN_PRINTER, { ...draft(), id: 'counter' }]);
    await deletePrinter(printers, 'counter');
    await deletePrinter(printers, BUILT_IN_PRINTER.id);
    await deletePrinter(printers, 'gone');
    expect(await all(printers)).toEqual([BUILT_IN_PRINTER]);
  });
});
