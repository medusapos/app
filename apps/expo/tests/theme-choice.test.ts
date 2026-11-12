import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME_CHOICE, isThemeChoice, loadThemeChoice, saveThemeChoice, THEME_CHOICES } from '../lib/theme-choice';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

describe('theme-choice with the seven v2 themes', () => {
  it('offers ten choices in v2 order', () => {
    expect(THEME_CHOICES).toEqual(['system', 'light', 'dark', 'ocean', 'sunset', 'monochrome', 'paper', 'warm', 'bold', 'market']);
  });

  it('round-trips each of the ten under medusapos.theme', () => {
    for (const choice of THEME_CHOICES) {
      const storage = fakeStorage();
      saveThemeChoice(storage, choice);
      expect(storage.store.get('medusapos.theme')).toBe(choice);
      expect(loadThemeChoice(storage)).toBe(choice);
      expect(isThemeChoice(choice)).toBe(true);
    }
  });

  it('reads an unknown stored value as light', () => {
    expect(DEFAULT_THEME_CHOICE).toBe('light');
    for (const value of ['sepia', 'Ocean', 'system ', '', 'neon']) {
      expect(loadThemeChoice(fakeStorage({ 'medusapos.theme': value }))).toBe('light');
    }
  });
});
