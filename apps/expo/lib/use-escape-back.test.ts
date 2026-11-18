// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEscapeBack } from './use-escape-back';

function keydown(key: string, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('useEscapeBack', () => {
  it('calls onBack once on an Escape on the body', () => {
    const onBack = vi.fn();
    renderHook(() => useEscapeBack(true, onBack));
    keydown('Escape');
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('does nothing while inactive, and a rerender to inactive removes the listener', () => {
    const onBack = vi.fn();
    renderHook(() => useEscapeBack(false, onBack));
    keydown('Escape');
    expect(onBack).not.toHaveBeenCalled();
    const { rerender } = renderHook(({ active }) => useEscapeBack(active, onBack), { initialProps: { active: true } });
    rerender({ active: false });
    keydown('Escape');
    expect(onBack).not.toHaveBeenCalled();
  });

  it('ignores other keys', () => {
    const onBack = vi.fn();
    renderHook(() => useEscapeBack(true, onBack));
    keydown('Enter');
    keydown('a');
    expect(onBack).not.toHaveBeenCalled();
  });

  it.each([
    ['input', () => document.createElement('input')],
    ['textarea', () => document.createElement('textarea')],
    ['contentEditable div', () => {
      const div = document.createElement('div');
      div.contentEditable = 'true';
      // jsdom does not implement isContentEditable; a browser reports it for this div.
      Object.defineProperty(div, 'isContentEditable', { value: true });
      div.tabIndex = 0;
      return div;
    }],
  ])('ignores an Escape typed in a focused %s', (_name, make) => {
    const onBack = vi.fn();
    renderHook(() => useEscapeBack(true, onBack));
    const field = make();
    document.body.appendChild(field);
    field.focus();
    expect(document.activeElement).toBe(field);
    keydown('Escape', field);
    expect(onBack).not.toHaveBeenCalled();
  });

  it.each([
    ['role', 'dialog'],
    ['role', 'alertdialog'],
    ['aria-modal', 'true'],
    ['role', 'menu'],
    ['role', 'listbox'],
  ])('ignores an Escape while an overlay with %s="%s" is open, and goes back once it is gone', (attribute, value) => {
    const onBack = vi.fn();
    renderHook(() => useEscapeBack(true, onBack));
    const overlay = document.createElement('div');
    overlay.setAttribute(attribute, value);
    document.body.appendChild(overlay);
    keydown('Escape');
    expect(onBack).not.toHaveBeenCalled();
    overlay.remove();
    keydown('Escape');
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('ignores an Escape whose default was already prevented', () => {
    const onBack = vi.fn();
    const prevent = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener('keydown', prevent, true);
    try {
      renderHook(() => useEscapeBack(true, onBack));
      expect(keydown('Escape').defaultPrevented).toBe(true);
      expect(onBack).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', prevent, true);
    }
  });

  it('removes the listener on unmount', () => {
    const onBack = vi.fn();
    const { unmount } = renderHook(() => useEscapeBack(true, onBack));
    unmount();
    keydown('Escape');
    expect(onBack).not.toHaveBeenCalled();
  });
});
