import { useCallback, useEffect, useState } from 'react';
import { FONT_FACES, TYPE_SET_IDS, type ThemeFontFamily, type TypeSetId } from '@tallyui/theme';
import type { SessionStorage } from './session';

export type FontChoice = TypeSetId;
export const FONT_CHOICES: readonly FontChoice[] = TYPE_SET_IDS;
export const FONT_LABELS: Record<FontChoice, string> = {
  system: 'System',
  instrument: 'DM Sans · Instrument Serif',
  grotesk: 'Space Grotesk',
  fraunces: 'DM Sans · Fraunces',
  manrope: 'Manrope',
};
export const DEFAULT_FONT_CHOICE: FontChoice = 'system';

const KEY = 'medusapos.font';

export function isFontChoice(value: unknown): value is FontChoice {
  return typeof value === 'string' && (FONT_CHOICES as readonly string[]).includes(value);
}

/** This device's choice, or the default when the stored value is missing or unusable. */
export function loadFontChoice(storage: SessionStorage | null): FontChoice {
  try {
    const value = storage?.getItem(KEY);
    return isFontChoice(value) ? value : DEFAULT_FONT_CHOICE;
  } catch { return DEFAULT_FONT_CHOICE; }
}

export function saveFontChoice(storage: SessionStorage | null, choice: FontChoice): void {
  try { storage?.setItem(KEY, choice); }
  catch { /* The choice still applies for this run. */ }
}

const listeners = new Set<(choice: FontChoice) => void>();

export function subscribeFontChoice(listener: (choice: FontChoice) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function chooseFont(storage: SessionStorage | null, choice: FontChoice): void {
  saveFontChoice(storage, choice);
  listeners.forEach((listener) => listener(choice));
}

/** The applied choice, live, even when storage could not save it. */
export function useFontChoice(storage: SessionStorage | null): { choice: FontChoice; save: (choice: FontChoice) => void } {
  const [choice, setChoice] = useState(() => loadFontChoice(storage));
  useEffect(() => subscribeFontChoice((next) => setChoice(next)), [storage]);
  const save = useCallback((next: FontChoice) => chooseFont(storage, next), [storage]);
  return { choice, save };
}

// Expo web serves apps/expo/public at the root.
export const FONTS_PATH = '/fonts/';
const loadedFamilies = new Set<ThemeFontFamily>();

export async function loadFontFaces(families: readonly ThemeFontFamily[]): Promise<void> {
  if (!globalThis.FontFace || !globalThis.document?.fonts) {
    throw new Error('FontFace and document.fonts are required to load bundled fonts');
  }
  await Promise.all(families.map(async (family) => {
    if (loadedFamilies.has(family)) return;
    await Promise.all(FONT_FACES[family].map(async ({ file, weight, style }) => {
      const face = new FontFace(family, `url(${FONTS_PATH}${file})`, {
        weight: String(weight), style: style ?? 'normal', display: 'swap',
      });
      await face.load();
      // Expo's tsconfig has dom without dom.iterable, which declares add.
      (document.fonts as FontFaceSet & { add(font: FontFace): FontFaceSet }).add(face);
    }));
    loadedFamilies.add(family);
  }));
}
