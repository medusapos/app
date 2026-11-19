import { useCallback, useEffect, useRef } from 'react';
import { Platform, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native';
import { stripBoundary } from '@tallyui/pos';
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

export function stripScanAffixes(raw: string, settings: ScannerSettings): string {
  return stripBoundary(Array.from(raw), { threshold: settings.avgKeyMs, prefix: settings.prefix, suffix: settings.suffix });
}

// The stripped code when a buffer typed from `firstAt` to `lastAt` counts as a scan (settings.minChars+ characters
// after stripping, averaging settings.avgKeyMs/key or less), else null.
export function scanCode(raw: string, firstAt: number, lastAt: number, settings: ScannerSettings): string | null {
  const code = stripScanAffixes(raw, settings);
  return code.length >= settings.minChars && averageKeyMs(firstAt, lastAt, raw.length) <= settings.avgKeyMs ? code : null;
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
        const raw = buffer; buffer = '';
        const code = scanCode(raw, firstAt, lastAt, settingsRef.current);
        if (code !== null) {
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

// A scanner sends Shift before a capital; these keys never end or reset a buffer.
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock']);

// The same scan judgement on a focused text field: returns its onKeyPress handler, which calls `onScan` with the
// stripped code when Enter ends a buffer that counts as a scan. Any other named key (Backspace, arrows, Tab…)
// empties the buffer, so an edit can never leave a stale one behind.
export function useWedgeScanField(settings: ScannerSettings, onScan: (code: string) => void):
  (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => void {
  const onScanRef = useRef(onScan); onScanRef.current = onScan;
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const timing = useRef({ buffer: '', firstAt: 0, lastAt: 0 });
  return useCallback((event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const key = event.nativeEvent.key, now = Date.now(), t = timing.current;
    if (MODIFIER_KEYS.has(key)) return;
    if (key === 'Enter') {
      const code = scanCode(t.buffer, t.firstAt, t.lastAt, settingsRef.current);
      timing.current = { buffer: '', firstAt: 0, lastAt: 0 };
      if (code !== null) onScanRef.current(code);
      return;
    }
    if (key.length !== 1) { timing.current = { buffer: '', firstAt: 0, lastAt: 0 }; return; }
    if (!t.buffer || now - t.lastAt > WEDGE_STALE_GAP_MS) { t.buffer = ''; t.firstAt = now; }
    t.buffer += key; t.lastAt = now;
  }, []);
}
