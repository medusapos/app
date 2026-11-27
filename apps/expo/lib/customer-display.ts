import type { DisplayRecord } from '@tallyui/core';
import type { DisplayConfig, DisplayTokenStore, SaleDisplayInput, SentOrder, TillDeviceKeyStore } from '@tallyui/pos';
import { normalizeBaseUrl, type SessionStorage } from './session';
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

export const DISPLAY_STORE_KEY = 'medusapos.display-store';
export function loadDisplayStore(storage: SessionStorage | null): string | null {
  try {
    const stored = storage?.getItem(DISPLAY_STORE_KEY);
    return stored == null ? null : normalizeBaseUrl(stored);
  } catch { return null; }
}
export function saveDisplayStore(storage: SessionStorage | null, baseUrl: string): void {
  try { storage?.setItem(DISPLAY_STORE_KEY, baseUrl); } catch {}
}
export function clearDisplayStore(storage: SessionStorage | null): void {
  try { storage?.removeItem(DISPLAY_STORE_KEY); } catch {}
}
export function displayTokenStore(storage: SessionStorage | null, baseUrl: string): DisplayTokenStore {
  const key = `medusapos.display.${baseUrl}`;
  return {
    load: async () => { try { return storage?.getItem(key) ?? null; } catch { return null; } },
    save: async (token) => { try { storage?.setItem(key, token); } catch {} },
    clear: async () => { try { storage?.removeItem(key); } catch {} },
  };
}

export function customerSafeSale({ order, stage }: SaleDisplayInput): SaleDisplayInput {
  const strip = (source: SentOrder) => ({ ...source, customer: null, note: '',
    lineItems: source.lineItems.map((line) => ({ ...line, sku: '' })),
    // These are the words of paymentLabel in order-detail.ts.
    payments: source.payments.map(({ reference: _reference, methodId: _methodId, ...payment }) =>
      ({ ...payment, method: payment.method === 'cash' ? 'Cash' : 'Card terminal' })) });
  return { order: strip(order), stage: stage.kind === 'receipt' ? { ...stage, order: strip(stage.order) } : stage };
}

// TallyUI has no default, so the idle delay is the app's choice.
const DISPLAY_IDLE_AFTER_COMPLETE_MS = 10_000;
export function displayConfigFor(display: Pick<DisplayRecord, 'displayId' | 'name'>, settings: StoreSettings | null, locale: string): DisplayConfig {
  return { contract: '1.0', display: { id: display.displayId, name: display.name },
    // The stock location id is internal, and the display never uses it.
    store: { id: '', name: settings?.storeName ?? '', currency: settings?.currency ?? '', locale },
    presentation_hints: {}, i18n: {}, idle: { afterCompleteMs: DISPLAY_IDLE_AFTER_COMPLETE_MS } };
}
