import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

// WCPOS v2 (pos/checkout/payment-methods.mdx#close): "✕ goes back one step … In a browser, Esc does the same, unless
// you are typing in a field or a dialog is open." Web only; native is unchanged.

const isEditable = (t: EventTarget | null) => t instanceof HTMLElement
  && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);

// v2's "unless … a dialog is open": an open overlay's own Escape closes it, so that Escape must not also go back.
export function escapeBlocked(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]') !== null;
}

// Escape calls `onBack` while `active`. A window capture listener, so it runs before an overlay's own (bubble-phase)
// Escape handler closes it and still sees that overlay in the DOM.
export function useEscapeBack(active: boolean, onBack: () => void): void {
  const onBackRef = useRef(onBack); onBackRef.current = onBack;
  useEffect(() => {
    if (Platform.OS !== 'web' || !active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (isEditable(event.target) || isEditable(document.activeElement) || escapeBlocked()) return;
      onBackRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active]);
}
