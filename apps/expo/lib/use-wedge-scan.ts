import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import type { ScannerSettings } from './scanner-settings';

// A gap this long between two keys starts a new buffer: a scanner never pauses mid-code.
export const WEDGE_STALE_GAP_MS = 500;

const isEditable = (t: EventTarget | null) => t instanceof HTMLElement
  && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);

// The average ms/key between a buffered code's first and last key (one character always qualifies). Shared by
// the wedge listener and the Settings screen's test-scan field, so both judge a scan's speed the same way.
export function averageKeyMs(firstAt: number, lastAt: number, length: number): number {
  return length > 1 ? (lastAt - firstAt) / (length - 1) : 0;
}

// A keyboard-wedge barcode scan on `document`, active only while `active`: fires `onScan` with the buffered code
// on Enter, at settings.minChars+ characters averaging settings.avgKeyMs/key or less; a gap over WEDGE_STALE_GAP_MS
// resets the buffer. Ignores an editable target. Web only; native is a no-op (a hardware scanner there is out of scope).
export function useWedgeScan(active: boolean, settings: ScannerSettings, onScan: (code: string) => void): void {
  const onScanRef = useRef(onScan); onScanRef.current = onScan;
  const settingsRef = useRef(settings); settingsRef.current = settings;
  useEffect(() => {
    if (Platform.OS !== 'web' || !active) return;
    let buffer = '', firstAt = 0, lastAt = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditable(event.target)) return;
      const now = Date.now();
      if (event.key === 'Enter') {
        const code = buffer; buffer = '';
        if (code.length >= settingsRef.current.minChars && averageKeyMs(firstAt, lastAt, code.length) <= settingsRef.current.avgKeyMs) {
          // A tapped Pressable (role=button) keeps focus and activates on Enter; stop this Enter here, in the
          // capture phase (before the target's own handler runs), so a scan can never also press it.
          event.preventDefault();
          event.stopPropagation();
          onScanRef.current(code);
        }
        return;
      }
      if (event.key.length !== 1) return;
      if (!buffer || now - lastAt > WEDGE_STALE_GAP_MS) { buffer = ''; firstAt = now; }
      buffer += event.key; lastAt = now;
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [active]);
}
