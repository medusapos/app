import { useEffect, useState } from 'react';
import type { RxCollection } from 'rxdb';
import type { PrinterFormDraft } from '@tallyui/components';
import {
  mintUuid, PRINTER_PROFILES_COLLECTION, PrintError, SYSTEM_PRINTER_ID,
  type PosOrder, type PrinterProfile, type PrinterProfileCollection, type PrintTransport,
} from '@tallyui/pos';
import { printReceiptPage } from './receipt-templates';

// v2's built-in system printer, the print dialog; its id is the print queue's id.
export const BUILT_IN_PRINTER: PrinterProfile = {
  id: SYSTEM_PRINTER_ID, name: 'Print dialog', connectionType: 'system', isBuiltIn: true, isDefault: true,
};

/** Adds the built-in printer when absent. A doc already there (even renamed) is kept as it is: a conflict is no error. */
export async function ensureBuiltInPrinter(collection: PrinterProfileCollection): Promise<void> {
  const { error } = await collection.bulkInsert([BUILT_IN_PRINTER]);
  const failed = error.find((e) => e.status !== 409);
  if (failed) throw new Error(`ensureBuiltInPrinter: the built-in printer was not written (${failed.status})`);
}

/** The `printer_profiles` collection of the database `orders` belongs to, as `openOrderStore` adds it. */
export function printerProfilesOf(orders: RxCollection<PosOrder>): PrinterProfileCollection | undefined {
  return (orders.database?.collections as unknown as Record<string, PrinterProfileCollection> | undefined)?.[PRINTER_PROFILES_COLLECTION];
}

const byShelf = (a: PrinterProfile, b: PrinterProfile) =>
  Number(!!b.isBuiltIn) - Number(!!a.isBuiltIn) || a.name.localeCompare(b.name);

/** This till's printers, live: built-in first, then by name. Without a collection, just the built-in. Never writes. */
export function usePrinterProfiles(orders: RxCollection<PosOrder> | null): PrinterProfile[] {
  const collection = orders ? printerProfilesOf(orders) : undefined;
  const [seen, setSeen] = useState<{ collection: PrinterProfileCollection; profiles: PrinterProfile[] } | null>(null);
  useEffect(() => {
    if (!collection) return;
    const subscription = collection.find().$.subscribe((docs) => {
      setSeen({ collection, profiles: docs.map((doc) => doc.toJSON() as PrinterProfile).sort(byShelf) });
    });
    return () => subscription.unsubscribe();
  }, [collection]);
  // An empty live list (the built-in insert failed on open) shows the built-in alone, as no collection does.
  return collection && seen?.collection === collection && seen.profiles.length > 0 ? seen.profiles : [BUILT_IN_PRINTER];
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ENTITIES[c]!);

/** A short, plain test page for a printer: no scripts, no external resources. */
export function printerTestPage({ printerName, storeName, now = new Date() }: { printerName: string; storeName: string; now?: Date }): string {
  return '<!doctype html><html><head><meta charset="utf-8"><title>Test print</title>'
    + '<style>body { margin: 16px; font: 14px sans-serif; color: #000; background: #fff }</style></head><body>'
    + `<h1>Test print</h1><p>${escapeHtml(printerName)}</p><p>${escapeHtml(storeName)}</p>`
    + `<p>${escapeHtml(now.toLocaleString())}</p><p>If you can read this, the printer works.</p></body></html>`;
}

/** The system printer's test page, through the print dialog's queue. A network printer's goes through thermal-printing's printTestReceipt. */
export function printTestPage(profile: PrinterProfile, html: string, transport?: PrintTransport): Promise<void> {
  if (profile.connectionType === 'system') return printReceiptPage(html, transport);
  return Promise.reject(new PrintError('unsupported', `No transport for ${profile.connectionType} printers yet`));
}

// v2's printer form, kept to what a browser till can reach: an Epson or Star network printer speaking ESC/POS.
export const PRINTER_REFUSALS = {
  system: 'The built-in Print dialog already prints through this browser. Choose Network.',
  vendor: 'A browser can reach Epson and Star printers only. Choose Epson or Star.',
  language: 'This till prints ESC/POS. Choose ESC/POS as the printer language.',
  name: 'Another printer has this name.',
  builtIn: 'The built-in printer cannot be changed.',
  failed: 'The printer was not saved. Try again.',
} as const;

const isBuiltInId = (id: string | undefined, docs: PrinterProfile[]) =>
  id === SYSTEM_PRINTER_ID || docs.some((doc) => doc.id === id && doc.isBuiltIn);

/**
 * Adds a printer, or replaces printer `id` whole (a key the form dropped leaves no stale value). Returns the refusal
 * the form shows, or null once saved. Set as default clears it on the others; the built-in keeps its own flag.
 */
export async function savePrinter(collection: PrinterProfileCollection, draft: PrinterFormDraft, id?: string): Promise<string | null> {
  if (draft.connectionType === 'system') return PRINTER_REFUSALS.system;
  if (draft.vendor !== 'epson' && draft.vendor !== 'star') return PRINTER_REFUSALS.vendor;
  if ((draft.language ?? 'esc-pos') !== 'esc-pos') return PRINTER_REFUSALS.language;
  try {
    const docs = (await collection.find().exec()).map((doc) => doc.toJSON() as PrinterProfile);
    if (draft.isBuiltIn || isBuiltInId(id, docs)) return PRINTER_REFUSALS.builtIn;
    const name = draft.name.trim();
    if (docs.some((doc) => doc.id !== id && doc.name.trim().toLowerCase() === name.toLowerCase())) return PRINTER_REFUSALS.name;
    const profile: PrinterProfile = { ...draft, name, id: id ?? mintUuid() };
    const cleared = profile.isDefault
      ? docs.filter((doc) => doc.id !== profile.id && !doc.isBuiltIn && doc.isDefault).map((doc) => ({ ...doc, isDefault: false }))
      : [];
    // One write for the printer and the defaults it clears.
    const { error } = await collection.bulkUpsert([profile, ...cleared]);
    return error.length > 0 ? PRINTER_REFUSALS.failed : null;
  } catch {
    return PRINTER_REFUSALS.failed;
  }
}

/** Removes printer `id`; the built-in printer is never removed. */
export async function deletePrinter(collection: PrinterProfileCollection, id: string): Promise<void> {
  const doc = await collection.findOne(id).exec();
  if (!doc || doc.isBuiltIn || id === SYSTEM_PRINTER_ID) return;
  await doc.remove();
}
