// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { Platform } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chordLabel, runShortcut, SHORTCUTS, shortcutFor, useAvailableShortcuts, useShortcut, useShortcutKeys } from './shortcuts';

const press = (over: Partial<Parameters<typeof shortcutFor>[0]>) => shortcutFor({
  code: '', key: '', altKey: false, ctrlKey: false, metaKey: false, editable: false, ...over,
});
const fire = (init: KeyboardEventInit) => act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });

afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.useRealTimers(); });

describe('shortcutFor', () => {
  it('maps each chord to its id', () => {
    expect(SHORTCUTS.map(({ code }) => press({ code, altKey: true }))).toEqual(['search.focus', 'sale.new', 'checkout.open', 'orders.open', 'help.open']);
  });
  it('maps Ctrl+Alt and Meta+Alt to null', () => {
    expect(press({ code: 'KeyP', altKey: true, ctrlKey: true })).toBeNull();
    expect(press({ code: 'KeyP', altKey: true, metaKey: true })).toBeNull();
    expect(press({ code: 'KeyP' })).toBeNull();
  });
  it('maps ? while editable to null', () => {
    expect(press({ code: 'Slash', key: '?', editable: true })).toBeNull();
  });
  it('maps ? while not editable to help.open', () => {
    expect(press({ code: 'Slash', key: '?' })).toBe('help.open');
    expect(press({ code: 'Slash', key: '?', ctrlKey: true })).toBeNull();
  });
  it('maps Alt+F while editable to search.focus', () => {
    expect(press({ code: 'KeyF', key: 'f', altKey: true, editable: true })).toBe('search.focus');
  });
  it('still matches a key of ƒ with code KeyF', () => {
    expect(press({ code: 'KeyF', key: 'ƒ', altKey: true })).toBe('search.focus');
  });
});

describe('chordLabel', () => {
  it('shows ⌥ on a Mac and Alt elsewhere', () => {
    expect(chordLabel('search.focus', true)).toEqual(['⌥', 'F']);
    expect(chordLabel('search.focus', false)).toEqual(['Alt', 'F']);
    expect(chordLabel('help.open', false)).toEqual(['Alt', '/']);
    expect(chordLabel('orders.open', true)).toEqual(['⌥', 'O']);
  });
});

describe('the registry', () => {
  it('runShortcut is false with no handler and true with one', () => {
    expect(runShortcut('sale.new')).toBe(false);
    const run = vi.fn();
    renderHook(() => useShortcut('sale.new', run));
    expect(runShortcut('sale.new')).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('an unmounted useShortcut unregisters', () => {
    const { unmount } = renderHook(() => useShortcut('orders.open', () => {}));
    const available = renderHook(() => useAvailableShortcuts());
    expect(available.result.current.has('orders.open')).toBe(true);
    unmount();
    expect(available.result.current.has('orders.open')).toBe(false);
    expect(runShortcut('orders.open')).toBe(false);
  });
  it('null makes the id unavailable, and the latest run is the one that runs', () => {
    const first = vi.fn(), second = vi.fn();
    const hook = renderHook(({ run }: { run: (() => void) | null }) => useShortcut('checkout.open', run), { initialProps: { run: null } as { run: (() => void) | null } });
    const available = renderHook(() => useAvailableShortcuts());
    expect(available.result.current.has('checkout.open')).toBe(false);
    expect(runShortcut('checkout.open')).toBe(false);
    hook.rerender({ run: first });
    expect(available.result.current.has('checkout.open')).toBe(true);
    hook.rerender({ run: second });
    runShortcut('checkout.open');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    hook.rerender({ run: null });
    expect(available.result.current.has('checkout.open')).toBe(false);
  });
});

describe('useShortcutKeys on web', () => {
  const keys = (helpOpen = false) => {
    const onHelp = vi.fn(), closeHelp = vi.fn(), checkout = vi.fn();
    renderHook(() => { useShortcut('checkout.open', checkout); useShortcutKeys(true, onHelp, helpOpen, closeHelp); });
    return { onHelp, closeHelp, checkout };
  };

  it('Alt+P runs checkout, and with an open [role="alertdialog"] does not', () => {
    const { checkout, onHelp } = keys();
    fire({ code: 'KeyP', key: 'π', altKey: true });
    expect(checkout).toHaveBeenCalledTimes(1);
    document.body.innerHTML = '<div role="alertdialog"></div>';
    fire({ code: 'KeyP', key: 'π', altKey: true });
    fire({ code: 'Slash', key: '?' });
    expect(checkout).toHaveBeenCalledTimes(1);
    expect(onHelp).not.toHaveBeenCalled();
  });

  it('an open dialog lets through only the help chord', () => {
    const { checkout, onHelp } = keys();
    document.body.innerHTML = '<div role="dialog"></div>';
    fire({ code: 'KeyP', altKey: true });
    expect(checkout).not.toHaveBeenCalled();
    fire({ code: 'Slash', altKey: true });
    expect(onHelp).toHaveBeenCalledTimes(1);
  });

  it('a chord while the help sheet is open calls closeHelp, then runs', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div role="dialog" data-testid="shortcuts-sheet"></div>';
    const { checkout, closeHelp } = keys(true);
    fire({ code: 'KeyP', altKey: true });
    expect(closeHelp).toHaveBeenCalledTimes(1);
    expect(checkout).not.toHaveBeenCalled();
    act(() => { vi.runAllTimers(); });
    expect(checkout).toHaveBeenCalledTimes(1);
    fire({ code: 'Slash', altKey: true });
    expect(closeHelp).toHaveBeenCalledTimes(2);
  });

  it('? opens the help, but not from inside a text field; a chord in a field that stops the key still runs', () => {
    const { onHelp, checkout } = keys();
    const input = document.createElement('input');
    // As react-native-web's TextInput does.
    input.addEventListener('keydown', (event) => event.stopPropagation());
    document.body.appendChild(input);
    input.focus();
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: '?', code: 'Slash', bubbles: true })); });
    expect(onHelp).not.toHaveBeenCalled();
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'π', code: 'KeyP', altKey: true, bubbles: true })); });
    expect(checkout).toHaveBeenCalledTimes(1);
    input.blur();
    fire({ key: '?', code: 'Slash' });
    expect(onHelp).toHaveBeenCalledTimes(1);
  });

  it('a keydown already claimed by a document capture listener (the wedge scanner) does not run', () => {
    const { checkout } = keys();
    const claim = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener('keydown', claim, true);
    try {
      fire({ code: 'KeyP', key: 'π', altKey: true });
      expect(checkout).not.toHaveBeenCalled();
    } finally { document.removeEventListener('keydown', claim, true); }
    fire({ code: 'KeyP', key: 'π', altKey: true });
    expect(checkout).toHaveBeenCalledTimes(1);
  });

  it('native adds no listener', () => {
    const original = Platform.OS;
    Platform.OS = 'ios';
    const add = vi.spyOn(document.body, 'addEventListener');
    try {
      keys();
      expect(add.mock.calls.filter(([type]) => type === 'keydown')).toEqual([]);
    } finally { Platform.OS = original; add.mockRestore(); }
  });
});
