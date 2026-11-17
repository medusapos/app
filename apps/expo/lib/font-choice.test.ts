import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseFont, DEFAULT_FONT_CHOICE, FONT_CHOICES, FONT_LABELS, isFontChoice, loadFontChoice, subscribeFontChoice } from './font-choice';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('font-choice', () => {
  it('offers the five choices and labels in v2 order', () => {
    expect(FONT_CHOICES).toEqual(['system', 'instrument', 'grotesk', 'fraunces', 'manrope']);
    expect(FONT_LABELS).toEqual({
      system: 'System', instrument: 'DM Sans · Instrument Serif', grotesk: 'Space Grotesk',
      fraunces: 'DM Sans · Fraunces', manrope: 'Manrope',
    });
    for (const choice of FONT_CHOICES) expect(isFontChoice(choice)).toBe(true);
  });

  it('defaults to system for missing, throwing or unknown storage and reads fraunces', () => {
    expect(DEFAULT_FONT_CHOICE).toBe('system');
    expect(loadFontChoice(fakeStorage())).toBe('system');
    expect(loadFontChoice(null)).toBe('system');
    expect(loadFontChoice({ ...fakeStorage(), getItem: () => { throw new Error('denied'); } })).toBe('system');
    for (const value of ['auto', 'Manrope', '', 'comic']) {
      expect(loadFontChoice(fakeStorage({ 'medusapos.font': value }))).toBe('system');
      expect(isFontChoice(value)).toBe(false);
    }
    expect(loadFontChoice(fakeStorage({ 'medusapos.font': 'fraunces' }))).toBe('fraunces');
  });

  it('saves then notifies subscribers once, even if saving throws, and supports unsubscribe', () => {
    const storage = fakeStorage();
    const listener = vi.fn(() => { expect(storage.store.get('medusapos.font')).toBe('manrope'); });
    const unsubscribe = subscribeFontChoice(listener);
    try {
      chooseFont(storage, 'manrope');
      expect(storage.store.size).toBe(1);
      expect(listener).toHaveBeenCalledExactlyOnceWith('manrope');
      listener.mockClear();
      expect(() => chooseFont({ ...storage, setItem: () => { throw new Error('denied'); } }, 'grotesk')).not.toThrow();
      expect(listener).toHaveBeenCalledExactlyOnceWith('grotesk');
    } finally { unsubscribe(); }
    listener.mockClear();
    chooseFont(storage, 'system');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('loadFontFaces', () => {
  it('loads and registers all six faces with their descriptors, then remembers the family', async () => {
    vi.resetModules();
    const { loadFontFaces } = await import('./font-choice');
    const constructed = vi.fn(), add = vi.fn();
    vi.stubGlobal('FontFace', class {
      constructor(...args: ConstructorParameters<typeof FontFace>) { constructed(...args); }
      async load() { return this; }
    });
    vi.stubGlobal('document', { fonts: { add } });
    await loadFontFaces(['DM Sans', 'Instrument Serif']);
    expect(constructed.mock.calls).toEqual([
      ['DM Sans', 'url(/fonts/DMSans-400.ttf)', { weight: '400', style: 'normal', display: 'swap' }],
      ['DM Sans', 'url(/fonts/DMSans-500.ttf)', { weight: '500', style: 'normal', display: 'swap' }],
      ['DM Sans', 'url(/fonts/DMSans-600.ttf)', { weight: '600', style: 'normal', display: 'swap' }],
      ['DM Sans', 'url(/fonts/DMSans-700.ttf)', { weight: '700', style: 'normal', display: 'swap' }],
      ['Instrument Serif', 'url(/fonts/InstrumentSerif-400.ttf)', { weight: '400', style: 'normal', display: 'swap' }],
      ['Instrument Serif', 'url(/fonts/InstrumentSerif-400Italic.ttf)', { weight: '400', style: 'italic', display: 'swap' }],
    ]);
    expect(add).toHaveBeenCalledTimes(6);
    expect(new Set(add.mock.calls.map(([face]) => face)).size).toBe(6);
    await loadFontFaces(['DM Sans']);
    expect(constructed).toHaveBeenCalledTimes(6);
    expect(add).toHaveBeenCalledTimes(6);
  });

  it('rejects a failed face and constructs that family again on a later call', async () => {
    vi.resetModules();
    const { loadFontFaces } = await import('./font-choice');
    const constructed = vi.fn(), add = vi.fn();
    let fail = true;
    vi.stubGlobal('FontFace', class {
      constructor(_family: string, readonly source: string) { constructed(source); }
      async load() {
        if (fail && this.source === 'url(/fonts/DMSans-400.ttf)') throw new Error('unavailable');
        return this;
      }
    });
    vi.stubGlobal('document', { fonts: { add } });
    await expect(loadFontFaces(['DM Sans'])).rejects.toThrow('unavailable');
    expect(constructed).toHaveBeenCalledTimes(4);
    fail = false;
    await loadFontFaces(['DM Sans']);
    expect(constructed).toHaveBeenCalledTimes(8);
    expect(add).toHaveBeenCalledTimes(7);
  });

  it('rejects when FontFace is unavailable', async () => {
    vi.resetModules();
    const { loadFontFaces } = await import('./font-choice');
    vi.stubGlobal('FontFace', undefined);
    await expect(loadFontFaces(['DM Sans'])).rejects.toThrow(Error);
  });
});
