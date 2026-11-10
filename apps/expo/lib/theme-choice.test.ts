import { describe, expect, it, vi } from 'vitest';
import { chooseTheme, isThemeChoice, loadThemeChoice, saveThemeChoice, subscribeThemeChoice, THEME_CHOICES } from './theme-choice';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

describe('theme-choice', () => {
  it('gives light when nothing is stored, the storage is null, the storage throws, or the value is unknown', () => {
    expect(loadThemeChoice(fakeStorage())).toBe('light');
    expect(loadThemeChoice(null)).toBe('light');
    const throwing = { ...fakeStorage(), getItem: () => { throw new Error('denied'); } };
    expect(loadThemeChoice(throwing)).toBe('light');
    expect(loadThemeChoice(fakeStorage({ 'medusapos.theme': 'sepia' }))).toBe('light');
  });

  it('round-trips each choice under the one device-wide key medusapos.theme', () => {
    const storage = fakeStorage();
    for (const choice of THEME_CHOICES) {
      saveThemeChoice(storage, choice);
      expect(storage.store.get('medusapos.theme')).toBe(choice);
      expect(loadThemeChoice(storage)).toBe(choice);
      expect(storage.store.size).toBe(1);
    }
  });

  it('a save into a throwing storage does not throw', () => {
    const throwing = { ...fakeStorage(), setItem: () => { throw new Error('denied'); } };
    expect(() => saveThemeChoice(throwing, 'dark')).not.toThrow();
    expect(() => chooseTheme(throwing, 'dark')).not.toThrow();
  });

  it('chooseTheme tells every subscriber the new choice, even when nothing could be saved, and not after unsubscribe', () => {
    const first = vi.fn(), second = vi.fn();
    const unsubscribeFirst = subscribeThemeChoice(first), unsubscribeSecond = subscribeThemeChoice(second);
    try {
      chooseTheme(null, 'dark');
      expect(first).toHaveBeenCalledExactlyOnceWith('dark');
      expect(second).toHaveBeenCalledExactlyOnceWith('dark');
      unsubscribeFirst();
      const storage = fakeStorage();
      chooseTheme(storage, 'system');
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(2);
      expect(second).toHaveBeenLastCalledWith('system');
      expect(storage.store.get('medusapos.theme')).toBe('system');
    } finally { unsubscribeFirst(); unsubscribeSecond(); }
  });

  it('isThemeChoice accepts only system, light and dark', () => {
    for (const choice of ['system', 'light', 'dark']) expect(isThemeChoice(choice)).toBe(true);
    for (const value of ['', 'Dark', 'sepia', undefined, 1]) expect(isThemeChoice(value)).toBe(false);
  });
});
