import { useEffect } from 'react';
import type { RxCollection } from 'rxdb';
import {
  canOpenDrawer, createEscPosTransport, createPrintQueue, networkSinkFor, openDrawerJob, PrintError,
  type EscPosSink, type PosOrder, type PrinterProfile, type PrintJob, type PrintTransport, type useSale,
} from '@tallyui/pos';
import { printerProfilesOf } from './printers';
import { sampleReceipt } from './receipt-templates';

// One queue per printer id, as v2 keeps one per profile, so a printer that does not answer holds up only its own jobs.
// Each job brings its own transport (its profile and sink), looked up by job id as receipt-templates' jobTransports are.
const jobTransports = new Map<string, PrintTransport>();
const queue = createPrintQueue({
  transportFor: () => ({
    name: 'thermal-printing',
    print: (job) => jobTransports.get(job.id)?.print(job) ?? Promise.reject(new PrintError('failed', `No transport for ${job.id}`)),
  }),
});
let jobCount = 0;

/** Sends `job` to a network Epson or Star printer, over ePOS-Print or WebPRNT unless a test passes its own `sink`. */
export function printToNetwork(profile: PrinterProfile, job: PrintJob, sink?: EscPosSink | null): Promise<void> {
  const target = sink ?? networkSinkFor(profile);
  if (!target) return Promise.reject(new PrintError('unsupported', `${profile.name} is not an Epson or Star network printer`));
  jobTransports.set(job.id, createEscPosTransport({ sink: target, profile }));
  return queue.print(profile.id, job).finally(() => jobTransports.delete(job.id));
}

/** The printer that kicks the drawer: switch on, ESC/POS and reachable from a browser; the default one first. */
export function drawerPrinter(profiles: readonly PrinterProfile[]): PrinterProfile | undefined {
  const able = profiles.filter((profile) => profile.autoOpenDrawer === true && canOpenDrawer(profile) && networkSinkFor(profile) !== null);
  return able.find((profile) => profile.isDefault) ?? able[0];
}

/**
 * Kicks the drawer of this till's drawer printer, read from storage at call time. Without one it sends nothing. A
 * printer that does not answer only warns: a drawer must never block or fail a sale or a No sale, so this never throws.
 */
export function openCashDrawer(orders: RxCollection<PosOrder> | null): Promise<void> {
  return (async () => {
    const collection = orders ? printerProfilesOf(orders) : undefined;
    if (!collection) return;
    const profiles = (await collection.find().exec()).map((doc) => doc.toJSON() as PrinterProfile)
      .sort((a, b) => a.name.localeCompare(b.name));
    const profile = drawerPrinter(profiles);
    if (profile) await printToNetwork(profile, openDrawerJob(profile, `drawer-${++jobCount}`));
  })().catch((error: unknown) => { console.warn('Could not open the cash drawer:', error); });
}

/**
 * Settings' Test print to a network printer: the sample sale as an ESC/POS receipt. Its drawer pulse is left off, so a
 * test print never opens the drawer.
 */
export function printTestReceipt(profile: PrinterProfile, store: { name: string; address?: string; currency: string }): Promise<void> {
  return printToNetwork({ ...profile, autoOpenDrawer: false }, { id: `test-${++jobCount}`, kind: 'test', receipt: sampleReceipt(store) });
}

type SaleStage = ReturnType<typeof useSale>['stage'];

// Cash this till took into its drawer; a leg already on the store (storePaymentId) never reached it.
const tookCash = (order: PosOrder) => order.payments.some((payment) =>
  payment.method === 'cash' && payment.storePaymentId === undefined && payment.amountMinor > 0);

// Every finished sale this tab has looked at (one till, one tab). Module-level, as printing-settings' seenSaleId,
// so StrictMode's second effect run, a re-render, a remount or a late isStored never kicks the drawer for that sale again.
const seenSaleIds = new Set<string>();

/** Opens the drawer once per finished sale (`posOrder.id`) that took cash into this till's drawer. Never waits or throws. */
export function openCashDrawerForSale(posOrder: PosOrder, orders: RxCollection<PosOrder> | null): void {
  if (seenSaleIds.has(posOrder.id)) return;
  seenSaleIds.add(posOrder.id);
  if (tookCash(posOrder)) void openCashDrawer(orders);
}

/** The outbox's `isStored`, answering as it does; a yes also opens the drawer, as Continue never reaches the receipt. */
export function isStoredOpensDrawer(isStored: (posOrder: PosOrder) => Promise<boolean>, orders: RxCollection<PosOrder> | null) {
  return async (posOrder: PosOrder): Promise<boolean> => {
    const stored = await isStored(posOrder);
    if (stored === true) openCashDrawerForSale(posOrder, orders);
    return stored;
  };
}

/** Opens the drawer once for each finished sale that took cash into this till's drawer. */
export function useCashDrawerOnSale(stage: SaleStage, orders: RxCollection<PosOrder> | null): void {
  const posOrder = stage.kind === 'receipt' ? stage.posOrder : undefined;
  useEffect(() => {
    if (posOrder) openCashDrawerForSale(posOrder, orders);
  }, [posOrder, orders]);
}
