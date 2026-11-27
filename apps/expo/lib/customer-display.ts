import type { DisplayRecord } from '@tallyui/core';
import type { DisplayConfig, SaleDisplayInput, SentOrder, TillDeviceKeyStore } from '@tallyui/pos';
import type { SessionStorage } from './session';
import type { StoreSettings } from './store-settings';

const deviceKey = (baseUrl: string) => `medusapos.display-device-key.${baseUrl}`;
function readKey(storage: SessionStorage | null, baseUrl: string) {
  try { return storage?.getItem(deviceKey(baseUrl)) ?? null; } catch { return null; }
}
export function displayKeyStore(storage: SessionStorage | null, baseUrl: string): TillDeviceKeyStore {
  return {
    load: async () => readKey(storage, baseUrl),
    save: async (key) => { try { storage?.setItem(deviceKey(baseUrl), key); } catch {} },
    clear: async () => { try { storage?.removeItem(deviceKey(baseUrl)); } catch {} },
  };
}
export function hasDisplayDeviceKey(storage: SessionStorage | null, baseUrl: string): boolean {
  return !!readKey(storage, baseUrl);
}

// Desk condition 3: neither the live cart nor its receipt may publish the customer, staff note or payment references.
export function customerSafeSale({ order, stage }: SaleDisplayInput): SaleDisplayInput {
  const strip = (source: SentOrder) => ({ ...source, customer: null, note: '',
    payments: source.payments.map(({ reference: _reference, ...payment }) => payment) });
  return { order: strip(order), stage: stage.kind === 'receipt' ? { ...stage, order: strip(stage.order) } : stage };
}

// TallyUI has no default, so the idle delay is the app's choice.
const DISPLAY_IDLE_AFTER_COMPLETE_MS = 10_000;
export function displayConfigFor(display: Pick<DisplayRecord, 'displayId' | 'name'>, settings: StoreSettings | null, locale: string): DisplayConfig {
  return { contract: '1.0', display: { id: display.displayId, name: display.name },
    store: { id: settings?.location.id ?? '', name: settings?.storeName ?? '', currency: settings?.currency ?? '', locale },
    presentation_hints: {}, i18n: {}, idle: { afterCompleteMs: DISPLAY_IDLE_AFTER_COMPLETE_MS } };
}
