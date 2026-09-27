import { describe, expect, it } from 'vitest';
import { DEFAULT_SCANNER_SETTINGS, loadScannerSettings, saveScannerSettings, type ScannerSettings } from './scanner-settings';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

describe('scanner-settings', () => {
  it('round-trips a saved value', () => {
    const storage = fakeStorage();
    const settings: ScannerSettings = { avgKeyMs: 60, minChars: 4 };
    saveScannerSettings(storage, 'https://a.test', settings);
    expect(loadScannerSettings(storage, 'https://a.test')).toEqual(settings);
  });

  it('falls back to the defaults when nothing is stored', () => {
    expect(loadScannerSettings(fakeStorage(), 'https://a.test')).toEqual(DEFAULT_SCANNER_SETTINGS);
  });

  it('falls back to the defaults on a corrupt value', () => {
    const storage = fakeStorage({ 'medusapos.scanner.https://a.test': 'not json' });
    expect(loadScannerSettings(storage, 'https://a.test')).toEqual(DEFAULT_SCANNER_SETTINGS);
  });

  it('falls back to the defaults on an out-of-range stored value', () => {
    const storage = fakeStorage({ 'medusapos.scanner.https://a.test': JSON.stringify({ avgKeyMs: 9999, minChars: 3 }) });
    expect(loadScannerSettings(storage, 'https://a.test')).toEqual(DEFAULT_SCANNER_SETTINGS);
  });

  it('refuses to save an out-of-range avgKeyMs', () => {
    const storage = fakeStorage();
    expect(() => saveScannerSettings(storage, 'https://a.test', { avgKeyMs: 501, minChars: 3 })).toThrow();
    expect(() => saveScannerSettings(storage, 'https://a.test', { avgKeyMs: 9, minChars: 3 })).toThrow();
  });

  it('refuses to save an out-of-range minChars', () => {
    const storage = fakeStorage();
    expect(() => saveScannerSettings(storage, 'https://a.test', { avgKeyMs: 100, minChars: 0 })).toThrow();
    expect(() => saveScannerSettings(storage, 'https://a.test', { avgKeyMs: 100, minChars: 65 })).toThrow();
  });

  it('refuses to save a non-integer value', () => {
    const storage = fakeStorage();
    expect(() => saveScannerSettings(storage, 'https://a.test', { avgKeyMs: 50.5, minChars: 3 })).toThrow();
  });

  it('keeps the keys separate per baseUrl', () => {
    const storage = fakeStorage();
    saveScannerSettings(storage, 'https://a.test', { avgKeyMs: 60, minChars: 4 });
    saveScannerSettings(storage, 'https://b.test', { avgKeyMs: 200, minChars: 8 });
    expect(loadScannerSettings(storage, 'https://a.test')).toEqual({ avgKeyMs: 60, minChars: 4 });
    expect(loadScannerSettings(storage, 'https://b.test')).toEqual({ avgKeyMs: 200, minChars: 8 });
  });
});
