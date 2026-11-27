import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionStorage } from './session';

export type PrintingSettings = { autoPrintReceipt: boolean };

// v2's "Automatically print receipt after checkout": off by default and per device. Medusa has no store setting
// for it, so it is kept per till per store.
export const DEFAULT_PRINTING_SETTINGS: PrintingSettings = { autoPrintReceipt: false };

const PREFIX = 'medusapos.printing.';
// Lets the receipt lay out before the print dialog opens, as PRINT_SETTLE_MS in closure-print.ts does.
const AUTO_PRINT_SETTLE_MS = 50;

/** Tolerates a missing or corrupt value, falling back to the defaults. */
export function loadPrintingSettings(storage: SessionStorage | null, baseUrl: string): PrintingSettings {
  try {
    const value: unknown = JSON.parse(storage?.getItem(PREFIX + baseUrl) ?? 'null');
    return typeof value === 'object' && value !== null && typeof (value as PrintingSettings).autoPrintReceipt === 'boolean'
      ? { autoPrintReceipt: (value as PrintingSettings).autoPrintReceipt } : DEFAULT_PRINTING_SETTINGS;
  } catch { return DEFAULT_PRINTING_SETTINGS; }
}

export function savePrintingSettings(storage: SessionStorage | null, baseUrl: string, settings: PrintingSettings): void {
  storage?.setItem(PREFIX + baseUrl, JSON.stringify(settings));
}

// Shared by every reader in this tab (one till, one instance); a save notifies every mounted reader.
const listeners = new Set<() => void>();

/** The current till's printing settings, live: a `save` from any mounted caller updates every other one. */
export function usePrintingSettings(storage: SessionStorage | null, baseUrl: string): {
  settings: PrintingSettings; save: (next: PrintingSettings) => void;
} {
  const [settings, setSettings] = useState(() => loadPrintingSettings(storage, baseUrl));
  useEffect(() => {
    const reload = () => setSettings(loadPrintingSettings(storage, baseUrl));
    reload(); listeners.add(reload);
    return () => { listeners.delete(reload); };
  }, [storage, baseUrl]);
  const save = useCallback((next: PrintingSettings) => {
    savePrintingSettings(storage, baseUrl, next); listeners.forEach((listener) => listener());
  }, [storage, baseUrl]);
  return { settings, save };
}

// The same guarded call as TallyUI Receipt's "Print receipt" button.
export function printWindow() {
  if (typeof window !== 'undefined' && typeof window.print === 'function') window.print();
}

// The last sale this tab has seen on the paid screen (one till, one tab). Module-level, so a re-render, a remount
// or a later toggle of the switch never prints that sale again.
let seenSaleId: string | undefined;

/**
 * Prints a newly finished sale once when `enabled`; a sale first seen with `enabled` false is never printed. `after`
 * runs once per sale, after the print (or at once when not printing): the next sale after an unshown receipt.
 */
export function useAutoPrintReceipt(
  saleId: string | undefined, enabled: boolean, print: () => void | Promise<void> = printWindow, after?: () => void, destination?: string,
) {
  // Returns the original print promise for this sale and destination, or null when there is none.
  const owner = useMemo(() => ({ saleId, destination }), [saleId, destination]);
  const [job, setJob] = useState<{ owner: typeof owner; promise: Promise<void> }>();
  // The latest `after`, so the call never uses one from an earlier render.
  const afterRef = useRef(after);
  afterRef.current = after;
  useEffect(() => {
    if (!saleId || saleId === seenSaleId) return;
    seenSaleId = saleId;
    // Not cleared on cleanup: StrictMode's second effect run is then a no-op, not a cancelled print.
    if (enabled) setTimeout(() => {
      const promise = print();
      if (promise) { promise.catch(() => {}); setJob({ owner, promise }); }
      afterRef.current?.();
    }, AUTO_PRINT_SETTLE_MS);
    else afterRef.current?.();
  }, [saleId, enabled, print, owner]);
  return job?.owner === owner ? job.promise : null;
}
