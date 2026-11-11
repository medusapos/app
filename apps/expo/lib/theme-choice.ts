import { useCallback, useEffect, useState } from 'react';
import type { SessionStorage } from './session';

export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];
// The POS has shipped light only, so a till that never chose keeps light; WCPOS defaults to system.
export const DEFAULT_THEME_CHOICE: ThemeChoice = 'light';

const KEY = 'medusapos.theme';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** This device's choice, or the default when the stored value is missing or unusable. */
export function loadThemeChoice(storage: SessionStorage | null): ThemeChoice {
  try {
    const value = storage?.getItem(KEY);
    return isThemeChoice(value) ? value : DEFAULT_THEME_CHOICE;
  } catch { return DEFAULT_THEME_CHOICE; }
}

export function saveThemeChoice(storage: SessionStorage | null, choice: ThemeChoice): void {
  try { storage?.setItem(KEY, choice); }
  catch { /* The choice still applies for this run. */ }
}

// A choice notifies every mounted reader and the app's theme subscription.
const listeners = new Set<(choice: ThemeChoice) => void>();

export function subscribeThemeChoice(listener: (choice: ThemeChoice) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function chooseTheme(storage: SessionStorage | null, choice: ThemeChoice): void {
  saveThemeChoice(storage, choice);
  listeners.forEach((listener) => listener(choice));
}

/** The applied choice, live, even when storage could not save it. */
export function useThemeChoice(storage: SessionStorage | null): { choice: ThemeChoice; save: (choice: ThemeChoice) => void } {
  const [choice, setChoice] = useState(() => loadThemeChoice(storage));
  useEffect(() => subscribeThemeChoice((next) => setChoice(next)), [storage]);
  const save = useCallback((next: ThemeChoice) => chooseTheme(storage, next), [storage]);
  return { choice, save };
}
