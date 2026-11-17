import { describe, expect, it, vi } from 'vitest';
import { chooseScale, DEFAULT_SCALE_CHOICE, isScaleChoice, loadScaleChoice, saveScaleChoice, subscribeScaleChoice, SCALE_CHOICES } from './scale-choice';

function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
}

describe('scale-choice', () => {
  it('offers four choices in v2 order and defaults to Regular', () => {
    expect(SCALE_CHOICES).toEqual(['auto', 'compact', 'regular', 'spacious']);
    expect(DEFAULT_SCALE_CHOICE).toBe('regular');
  });

  it('gives Regular for missing, null, throwing or unknown storage', () => {
    expect(loadScaleChoice(fakeStorage())).toBe('regular');
    expect(loadScaleChoice(null)).toBe('regular');
    const throwing = { ...fakeStorage(), getItem: () => { throw new Error('denied'); } };
    expect(loadScaleChoice(throwing)).toBe('regular');
    for (const value of ['Compact', '', 'huge']) {
      expect(loadScaleChoice(fakeStorage({ 'medusapos.scale': value }))).toBe('regular');
      expect(isScaleChoice(value)).toBe(false);
    }
  });

  it('round-trips every choice under medusapos.scale', () => {
    const storage = fakeStorage();
    for (const choice of SCALE_CHOICES) {
      saveScaleChoice(storage, choice);
      expect(storage.store.get('medusapos.scale')).toBe(choice);
      expect(loadScaleChoice(storage)).toBe(choice);
      expect(isScaleChoice(choice)).toBe(true);
      expect(storage.store.size).toBe(1);
    }
  });

  it('a save into a throwing storage does not throw', () => {
    const throwing = { ...fakeStorage(), setItem: () => { throw new Error('denied'); } };
    expect(() => saveScaleChoice(throwing, 'regular')).not.toThrow();
    expect(() => chooseScale(throwing, 'regular')).not.toThrow();
  });

  it('chooseScale saves before notifying once, and stops notifying after unsubscribe', () => {
    const storage = fakeStorage();
    const listener = vi.fn(() => { expect(storage.store.get('medusapos.scale')).toBe('regular'); });
    const unsubscribe = subscribeScaleChoice(listener);
    try {
      chooseScale(storage, 'regular');
      expect(listener).toHaveBeenCalledExactlyOnceWith('regular');
      unsubscribe();
      chooseScale(storage, 'spacious');
      expect(listener).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });
});
