import { useCallback, useEffect, useState } from 'react';
import type { SessionStorage } from './session';

export type ScannerSettings = { avgKeyMs: number; minChars: number };

// 100 ms average: Bluetooth HID scanners can send 60-100 ms per key. In the cart view nothing is focused, so a fast human typing a code and Enter wants the same result.
// WCPOS's default is 24 ms, a per-store setting there (barcode_scanning_avg_time_input_threshold).
// Medusa SKUs such as "E2E-2" are shorter than WCPOS's default minimum of 8.
export const DEFAULT_SCANNER_SETTINGS: ScannerSettings = { avgKeyMs: 100, minChars: 3 };

const PREFIX = 'medusapos.scanner.';
const AVG_KEY_MS_RANGE = [10, 500] as const;
const MIN_CHARS_RANGE = [1, 64] as const;
const inRange = (v: unknown, [min, max]: readonly [number, number]): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isValidSettings = (v: unknown): v is ScannerSettings => typeof v === 'object' && v !== null
  && inRange((v as ScannerSettings).avgKeyMs, AVG_KEY_MS_RANGE) && inRange((v as ScannerSettings).minChars, MIN_CHARS_RANGE);

/** Tolerates a missing or corrupt value, falling back to the defaults (same style as store-settings.ts). */
export function loadScannerSettings(storage: SessionStorage | null, baseUrl: string): ScannerSettings {
  try {
    const value: unknown = JSON.parse(storage?.getItem(PREFIX + baseUrl) ?? 'null');
    return isValidSettings(value) ? value : DEFAULT_SCANNER_SETTINGS;
  } catch { return DEFAULT_SCANNER_SETTINGS; }
}

/** Throws when `settings` is out of range, so a caller can show a validation message. */
export function saveScannerSettings(storage: SessionStorage | null, baseUrl: string, settings: ScannerSettings): void {
  if (!isValidSettings(settings)) throw new Error(`Average time per key must be a whole number from ${AVG_KEY_MS_RANGE[0]} `
    + `to ${AVG_KEY_MS_RANGE[1]}, and minimum characters a whole number from ${MIN_CHARS_RANGE[0]} to ${MIN_CHARS_RANGE[1]}.`);
  storage?.setItem(PREFIX + baseUrl, JSON.stringify(settings));
}

// One settings object per baseUrl, shared by every reader in this tab (D3: one till, one instance); a save
// notifies every mounted reader, so the wedge listener picks up a change without remounting.
const listeners = new Set<() => void>();

/** The current till's scanner settings, live: a `save` from any mounted caller updates every other one. */
export function useScannerSettings(storage: SessionStorage | null, baseUrl: string): {
  settings: ScannerSettings; save: (next: ScannerSettings) => void; reset: () => void;
} {
  const [settings, setSettings] = useState(() => loadScannerSettings(storage, baseUrl));
  useEffect(() => {
    const reload = () => setSettings(loadScannerSettings(storage, baseUrl));
    reload(); listeners.add(reload);
    return () => { listeners.delete(reload); };
  }, [storage, baseUrl]);
  const save = useCallback((next: ScannerSettings) => {
    saveScannerSettings(storage, baseUrl, next); listeners.forEach((listener) => listener());
  }, [storage, baseUrl]);
  return { settings, save, reset: useCallback(() => save(DEFAULT_SCANNER_SETTINGS), [save]) };
}
