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
  it.each([['#', '!'], ['📦', '🔎']])('round-trips prefix %s, suffix %s and sound', (prefix, suffix) => {
    const storage = fakeStorage();
    const settings = { ...DEFAULT_SCANNER_SETTINGS, prefix, suffix, playSound: true };
    saveScannerSettings(storage, 'https://a.test', settings);
    expect(loadScannerSettings(storage, 'https://a.test')).toEqual(settings);
  });

  it('keeps old thresholds and defaults the missing fields', () => {
    const storage = fakeStorage({ 'medusapos.scanner.https://a.test': JSON.stringify({ avgKeyMs: 60, minChars: 4 }) });
    expect(loadScannerSettings(storage, 'https://a.test')).toEqual({ ...DEFAULT_SCANNER_SETTINGS, avgKeyMs: 60, minChars: 4 });
  });

  it.each(['prefix', 'suffix'])('refuses a two-character %s', (field) => {
    expect(() => saveScannerSettings(fakeStorage(), 'https://a.test', { ...DEFAULT_SCANNER_SETTINGS, [field]: 'AB' }))
      .toThrow(/Prefix and suffix must be at most one character each/);
  });

  it('refuses a non-boolean playSound', () => {
    const settings = { ...DEFAULT_SCANNER_SETTINGS, playSound: 'true' } as unknown as ScannerSettings;
    expect(() => saveScannerSettings(fakeStorage(), 'https://a.test', settings)).toThrow();
  });

  it('round-trips a saved value', () => {
    const storage = fakeStorage();
    const settings: ScannerSettings = { ...DEFAULT_SCANNER_SETTINGS, avgKeyMs: 60, minChars: 4 };
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
    expect(() => saveScannerSettings(storage, 'https://a.test', { ...DEFAULT_SCANNER_SETTINGS, avgKeyMs: 501, minChars: 3 })).toThrow();
    expect(() => saveScannerSettings(storage, 'https://a.test', { ...DEFAULT_SCANNER_SETTINGS, avgKeyMs: 9, minChars: 3 })).toThrow();
  });

  it('refuses to save an out-of-range minChars', () => {
    const storage = fakeStorage();
    expect(() => saveScannerSettings(storage, 'https://a.test', { ...DEFAULT_SCANNER_SETTINGS, avgKeyMs: 100, minChars: 0 })).toThrow();
    expect(() => saveScannerSettings(storage, 'https://a.test', { ...DEFAULT_SCANNER_SETTINGS, avgKeyMs: 100, minChars: 65 })).toThrow();
  });

  it('refuses to save a non-integer value', () => {
    const storage = fakeStorage();
    expect(() => saveScannerSettings(storage, 'https://a.test', { ...DEFAULT_SCANNER_SETTINGS, avgKeyMs: 50.5, minChars: 3 })).toThrow();
  });

  it('keeps the keys separate per baseUrl', () => {
    const storage = fakeStorage();
    saveScannerSettings(storage, 'https://a.test', { ...DEFAULT_SCANNER_SETTINGS, avgKeyMs: 60, minChars: 4 });
    saveScannerSettings(storage, 'https://b.test', { ...DEFAULT_SCANNER_SETTINGS, avgKeyMs: 200, minChars: 8 });
    expect(loadScannerSettings(storage, 'https://a.test')).toEqual({ ...DEFAULT_SCANNER_SETTINGS, avgKeyMs: 60, minChars: 4 });
    expect(loadScannerSettings(storage, 'https://b.test')).toEqual({ ...DEFAULT_SCANNER_SETTINGS, avgKeyMs: 200, minChars: 8 });
  });

  it('defaults the camera off at TU\'s 176 px panel height', () => {
    expect(DEFAULT_SCANNER_SETTINGS).toMatchObject({ camera: false, cameraHeight: 176 });
  });

  it('loads a value saved before the camera fields existed with the camera off at 176', () => {
    const old = { avgKeyMs: 60, minChars: 4, prefix: '#', suffix: '', playSound: true };
    const storage = fakeStorage({ 'medusapos.scanner.https://a.test': JSON.stringify(old) });
    expect(loadScannerSettings(storage, 'https://a.test')).toEqual({ ...old, camera: false, cameraHeight: 176 });
  });

  it.each([[95, false], [96, true], [480, true], [481, false], [200.5, false]])('cameraHeight %d is accepted: %s', (cameraHeight, ok) => {
    const storage = fakeStorage(), settings = { ...DEFAULT_SCANNER_SETTINGS, camera: true, cameraHeight };
    const save = () => saveScannerSettings(storage, 'https://a.test', settings);
    if (!ok) { expect(save).toThrow(/camera scanner height/); return; }
    save();
    expect(loadScannerSettings(storage, 'https://a.test')).toEqual(settings);
  });

  it('an out-of-range stored cameraHeight makes the whole value fall back to the defaults', () => {
    const storage = fakeStorage({ 'medusapos.scanner.https://a.test': JSON.stringify({ minChars: 5, camera: true, cameraHeight: 481 }) });
    expect(loadScannerSettings(storage, 'https://a.test')).toEqual(DEFAULT_SCANNER_SETTINGS);
  });
});
