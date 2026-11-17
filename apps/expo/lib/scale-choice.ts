import { useCallback, useEffect, useState } from 'react';
import { UI_SCALES, type UiScale } from '@tallyui/pos';
import type { SessionStorage } from './session';

export type ScaleChoice = UiScale;
export const SCALE_CHOICES: readonly ScaleChoice[] = UI_SCALES;
// The POS has shipped at Regular, so a till that never chose keeps Regular; WCPOS defaults to Auto.
export const DEFAULT_SCALE_CHOICE: ScaleChoice = 'regular';

const KEY = 'medusapos.scale';

export function isScaleChoice(value: unknown): value is ScaleChoice {
  return typeof value === 'string' && (SCALE_CHOICES as readonly string[]).includes(value);
}

/** This device's choice, or the default when the stored value is missing or unusable. */
export function loadScaleChoice(storage: SessionStorage | null): ScaleChoice {
  try {
    const value = storage?.getItem(KEY);
    return isScaleChoice(value) ? value : DEFAULT_SCALE_CHOICE;
  } catch { return DEFAULT_SCALE_CHOICE; }
}

export function saveScaleChoice(storage: SessionStorage | null, choice: ScaleChoice): void {
  try { storage?.setItem(KEY, choice); }
  catch { /* The choice still applies for this run. */ }
}

// A choice notifies every mounted reader and the app's scale subscription.
const listeners = new Set<(choice: ScaleChoice) => void>();

export function subscribeScaleChoice(listener: (choice: ScaleChoice) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function chooseScale(storage: SessionStorage | null, choice: ScaleChoice): void {
  saveScaleChoice(storage, choice);
  listeners.forEach((listener) => listener(choice));
}

/** The applied choice, live, even when storage could not save it. */
export function useScaleChoice(storage: SessionStorage | null): { choice: ScaleChoice; save: (choice: ScaleChoice) => void } {
  const [choice, setChoice] = useState(() => loadScaleChoice(storage));
  useEffect(() => subscribeScaleChoice((next) => setChoice(next)), [storage]);
  const save = useCallback((next: ScaleChoice) => chooseScale(storage, next), [storage]);
  return { choice, save };
}
