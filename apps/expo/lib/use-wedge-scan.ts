import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

// 100 ms average: Bluetooth HID scanners can send 60-100 ms per key. In the cart view nothing is focused, so a fast human typing a code and Enter wants the same result.
// WCPOS's default is 24 ms, a per-store setting there (barcode_scanning_avg_time_input_threshold).
export const WEDGE_AVG_KEY_MS = 100;
// A gap this long between two keys starts a new buffer: a scanner never pauses mid-code.
export const WEDGE_STALE_GAP_MS = 500;
// Medusa SKUs such as "E2E-2" are shorter than WCPOS's default minimum of 8.
export const WEDGE_MIN_CHARS = 3;

const isEditable = (t: EventTarget | null) => t instanceof HTMLElement
  && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);

// A keyboard-wedge barcode scan on `document`, active only while `active`: fires `onScan` with the buffered code on Enter, at WEDGE_MIN_CHARS+ characters averaging WEDGE_AVG_KEY_MS/key or less; a gap over WEDGE_STALE_GAP_MS resets the buffer.
// Ignores an editable target. Web only; native is a no-op (a hardware scanner there is out of scope).
export function useWedgeScan(active: boolean, onScan: (code: string) => void): void {
  const onScanRef = useRef(onScan); onScanRef.current = onScan;
  useEffect(() => {
    if (Platform.OS !== 'web' || !active) return;
    let buffer = '', firstAt = 0, lastAt = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditable(event.target)) return;
      const now = Date.now();
      if (event.key === 'Enter') {
        const code = buffer; buffer = '';
        if (code.length >= WEDGE_MIN_CHARS && (lastAt - firstAt) / (code.length - 1) <= WEDGE_AVG_KEY_MS) {
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
