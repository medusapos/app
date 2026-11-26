import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { escapeBlocked } from './use-escape-back';

// WCPOS v2's hotkeys extension (packages/core/src/extensions/hotkeys/bindings.ts l.9-16): Alt+F, Alt+P, Alt+N and
// Alt+/, matched on `event.code` because Option on a Mac changes `key` (Option+F types "ƒ"). Web only.
export type ShortcutId = 'search.focus' | 'sale.new' | 'checkout.open' | 'orders.open' | 'help.open';

export const SHORTCUTS: readonly { id: ShortcutId; label: string; code: string }[] = [
  { id: 'search.focus', label: 'Search products', code: 'KeyF' },
  { id: 'sale.new', label: 'New sale', code: 'KeyN' },
  { id: 'checkout.open', label: 'Checkout', code: 'KeyP' },
  // Not in v2, which has no chord for an area: added for the Orders area (ready item 21).
  { id: 'orders.open', label: 'Open Orders', code: 'KeyO' },
  { id: 'help.open', label: 'Keyboard shortcuts', code: 'Slash' },
];

/** The shortcut a keydown is, or null. `?` (v2 has only Alt+/) counts with no modifier and outside a text field. In a
 * field, where a Mac's Option types (⌥N ñ, ⌥P π), only Alt+F, Alt+/ or an Alt that typed nothing (Windows) maps. */
export function shortcutFor(event: { code: string; key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; editable: boolean }): ShortcutId | null {
  if (event.ctrlKey || event.metaKey) return null;
  if (!event.altKey) return event.key === '?' && !event.editable ? 'help.open' : null;
  const id = SHORTCUTS.find((shortcut) => shortcut.code === event.code)?.id ?? null;
  if (!id || !event.editable || id === 'search.focus' || id === 'help.open') return id;
  return event.key.toLowerCase() === event.code.slice(3).toLowerCase() ? id : null;
}

/** The key caps: Option (⌥) on a Mac, Alt elsewhere. */
export function chordLabel(id: ShortcutId, mac: boolean): string[] {
  const code = SHORTCUTS.find((shortcut) => shortcut.id === id)!.code;
  return [mac ? '⌥' : 'Alt', code === 'Slash' ? '/' : code.slice(3)];
}

// One handler per id, from whichever screen offers it now; listeners re-read the available set.
const handlers = new Map<ShortcutId, { current: () => void }>();
const listeners = new Set<() => void>();
let available: ReadonlySet<ShortcutId> = new Set();
const changed = () => { available = new Set(handlers.keys()); listeners.forEach((listener) => listener()); };

/** Offers `id` while mounted; `null` makes it unavailable. The latest `run` is read through a ref. */
export function useShortcut(id: ShortcutId, run: (() => void) | null): void {
  const ref = useRef(run ?? (() => {}));
  if (run) ref.current = run;
  const on = run !== null;
  useEffect(() => {
    if (!on) return;
    const entry = { current: () => ref.current() };
    handlers.set(id, entry); changed();
    return () => { if (handlers.get(id) === entry) { handlers.delete(id); changed(); } };
  }, [id, on]);
}

/** Runs `id`'s handler; false when nothing offers it now. */
export function runShortcut(id: ShortcutId): boolean {
  const handler = handlers.get(id);
  handler?.current();
  return handler !== undefined;
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useAvailableShortcuts(): ReadonlySet<ShortcutId> {
  return useSyncExternalStore(subscribe, () => available, () => available);
}

// escapeBlocked's selector. The sheet is its root testID; its scrim (parent of TallyUI's aria-modal overlay) precedes it.
const OVERLAY = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]';
/** An open dialog, menu or listbox other than the shortcuts sheet and its own scrim. */
export function otherOverlayOpen(): boolean {
  if (typeof document === 'undefined') return false;
  const sheet = document.querySelector('[data-testid="shortcuts-sheet"]');
  const scrim = sheet?.previousElementSibling;
  return Array.from(document.querySelectorAll(OVERLAY)).some((el) => !sheet?.contains(el) && el.parentElement !== scrim);
}

const isEditable = (t: EventTarget | null) => t instanceof HTMLElement
  && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);

// The one keydown listener, on <body> in the capture phase: react-native-web's TextInput stops a keydown's propagation,
// so a bubble listener never hears a chord typed in the search box, while body's capture runs after the wedge
// scanner's `document` capture listener, which so still sees every key first.
// An open dialog, menu or listbox (not this sheet) lets through only the help chord, and an alert dialog not even
// that, so no chord can open payment under the Void confirm. Over the sheet (v2's hotkeys.web.tsx l.56-64), a chord
// closes it, then runs on the next tick, once the sheet has gone; with another dialog beneath the sheet it only closes it.
export function useShortcutKeys(enabled: boolean, onHelp: () => void, helpOpen: boolean, closeHelp: () => void): void {
  const latest = useRef({ onHelp, helpOpen, closeHelp });
  latest.current = { onHelp, helpOpen, closeHelp };
  useEffect(() => {
    if (Platform.OS !== 'web' || !enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const id = shortcutFor({ code: event.code, key: event.key, altKey: event.altKey, ctrlKey: event.ctrlKey,
        metaKey: event.metaKey, editable: isEditable(event.target) || isEditable(document.activeElement) });
      if (!id) return;
      const { onHelp, helpOpen, closeHelp } = latest.current;
      if (!helpOpen && escapeBlocked() && (id !== 'help.open' || document.querySelector('[role="alertdialog"]'))) return;
      event.preventDefault();
      if (id === 'help.open') { if (helpOpen) closeHelp(); else onHelp(); return; }
      if (!helpOpen) { runShortcut(id); return; }
      const blocked = otherOverlayOpen();
      closeHelp();
      if (!blocked) setTimeout(() => runShortcut(id), 0);
    };
    const body = document.body;
    body.addEventListener('keydown', onKeyDown, true);
    return () => body.removeEventListener('keydown', onKeyDown, true);
  }, [enabled]);
}
