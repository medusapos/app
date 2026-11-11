import { ORDER_NOTE_MAX } from '@tallyui/core';

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** The sale's note cut to ORDER_NOTE_MAX UTF-16 units without splitting a surrogate pair. A lone surrogate already in the
 * text is kept as it is; the plugin refuses it. */
export function clampNote(text: string): string {
  if (text.length <= ORDER_NOTE_MAX) return text;
  const splitsPair = isHigh(text.charCodeAt(ORDER_NOTE_MAX - 1)) && isLow(text.charCodeAt(ORDER_NOTE_MAX));
  return text.slice(0, splitsPair ? ORDER_NOTE_MAX - 1 : ORDER_NOTE_MAX);
}
