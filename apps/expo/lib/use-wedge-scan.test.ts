// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeSyntheticEvent, TextInputKeyPressEventData } from 'react-native';
import { DEFAULT_SCANNER_SETTINGS, type ScannerSettings } from './scanner-settings';
import { scanCode, stripScanAffixes, useWedgeScan, useWedgeScanField, WEDGE_STALE_GAP_MS } from './use-wedge-scan';

function keydown(key: string, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

// Dispatches one keydown per char, `gapMs` apart, starting at `startAt`; returns the time after the last one.
function type(chars: string[], gapMs: number, startAt: number, target?: EventTarget): number {
  let t = startAt;
  for (const key of chars) { vi.setSystemTime(t); keydown(key, target); t += gapMs; }
  return t;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useWedgeScan', () => {
  it.each([
    ['#E2E-2!', 'E2E-2'],
    ['E2E-2', 'E2E-2'],
    ['A#B', 'A#B'],
  ])('strips only configured edge keys from %s', (raw, code) => {
    const onScan = vi.fn();
    renderHook(() => useWedgeScan(true, { ...DEFAULT_SCANNER_SETTINGS, prefix: '#', suffix: '!' }, onScan));
    type(Array.from(raw), 10, 1_000);
    keydown('Enter');
    expect(onScan).toHaveBeenCalledExactlyOnceWith(code);
  });

  it('checks minChars after stripping and leaves a short Enter alone', () => {
    const onScan = vi.fn();
    renderHook(() => useWedgeScan(true, { ...DEFAULT_SCANNER_SETTINGS, prefix: '#', suffix: '!', minChars: 3 }, onScan));
    type(Array.from('#AB!'), 10, 1_000);
    expect(keydown('Enter').defaultPrevented).toBe(false);
    expect(onScan).not.toHaveBeenCalled();
  });

  it('uses raw timing and the latest settings when Enter arrives', () => {
    const onScan = vi.fn();
    const { rerender } = renderHook(({ settings }) => useWedgeScan(true, settings, onScan), {
      initialProps: { settings: DEFAULT_SCANNER_SETTINGS },
    });
    type(Array.from('#ABC!'), 80, 1_000);
    rerender({ settings: { ...DEFAULT_SCANNER_SETTINGS, prefix: '#', suffix: '!' } });
    keydown('Enter');
    expect(onScan).toHaveBeenCalledExactlyOnceWith('ABC');
  });

  it('fires with the code on Enter when keys average avgKeyMs or less', () => {
    const onScan = vi.fn();
    renderHook(() => useWedgeScan(true, DEFAULT_SCANNER_SETTINGS, onScan));
    const t = type(['E', '2', 'E', '-', '2'], DEFAULT_SCANNER_SETTINGS.avgKeyMs - 10, 1_000);
    vi.setSystemTime(t);
    keydown('Enter');
    expect(onScan).toHaveBeenCalledWith('E2E-2');
  });

  it('does not fire when the average gap is clearly slow', () => {
    const onScan = vi.fn();
    renderHook(() => useWedgeScan(true, DEFAULT_SCANNER_SETTINGS, onScan));
    const t = type(['A', 'B', 'C', 'D'], 150, 1_000);
    vi.setSystemTime(t);
    keydown('Enter');
    expect(onScan).not.toHaveBeenCalled();
  });

  it('takes avgKeyMs from settings: a 50 ms average does not fire at avgKeyMs 30', () => {
    const onScan = vi.fn();
    const settings: ScannerSettings = { ...DEFAULT_SCANNER_SETTINGS, avgKeyMs: 30, minChars: 3 };
    renderHook(() => useWedgeScan(true, settings, onScan));
    const t = type(['A', 'B', 'C', 'D'], 50, 1_000);
    vi.setSystemTime(t);
    keydown('Enter');
    expect(onScan).not.toHaveBeenCalled();
  });

  it('takes minChars from settings: 3 characters do not fire at minChars 6', () => {
    const onScan = vi.fn();
    const settings: ScannerSettings = { ...DEFAULT_SCANNER_SETTINGS, avgKeyMs: 100, minChars: 6 };
    renderHook(() => useWedgeScan(true, settings, onScan));
    const t = type(['A', 'B', 'C'], 5, 1_000);
    vi.setSystemTime(t);
    keydown('Enter');
    expect(onScan).not.toHaveBeenCalled();
  });

  it('ignores keys targeting an editable element', () => {
    const onScan = vi.fn();
    renderHook(() => useWedgeScan(true, DEFAULT_SCANNER_SETTINGS, onScan));
    const input = document.createElement('input');
    document.body.appendChild(input);
    const t = type(['E', '2', 'E'], 5, 1_000, input);
    vi.setSystemTime(t);
    keydown('Enter', input);
    expect(onScan).not.toHaveBeenCalled();
    input.remove();
  });

  it('does not fire with fewer than 3 characters', () => {
    const onScan = vi.fn();
    renderHook(() => useWedgeScan(true, DEFAULT_SCANNER_SETTINGS, onScan));
    const t = type(['A', 'B'], 5, 1_000);
    vi.setSystemTime(t);
    keydown('Enter');
    expect(onScan).not.toHaveBeenCalled();
  });

  it('prevents default on a qualifying scan\'s Enter, so a focused button never also activates', () => {
    const onScan = vi.fn();
    renderHook(() => useWedgeScan(true, DEFAULT_SCANNER_SETTINGS, onScan));
    const t = type(['E', '2', 'E'], 5, 1_000);
    vi.setSystemTime(t);
    const event = keydown('Enter');
    expect(onScan).toHaveBeenCalledWith('E2E');
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a non-qualifying Enter alone', () => {
    const onScan = vi.fn();
    renderHook(() => useWedgeScan(true, DEFAULT_SCANNER_SETTINGS, onScan));
    const t = type(['A', 'B'], 5, 1_000);
    vi.setSystemTime(t);
    const event = keydown('Enter');
    expect(onScan).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('resets the buffer after a gap over WEDGE_STALE_GAP_MS', () => {
    const onScan = vi.fn();
    renderHook(() => useWedgeScan(true, DEFAULT_SCANNER_SETTINGS, onScan));
    const stale = type(['X', 'X'], 5, 1_000);
    const t = type(['E', '2', 'E'], 5, stale + WEDGE_STALE_GAP_MS + 100);
    vi.setSystemTime(t);
    keydown('Enter');
    expect(onScan).toHaveBeenCalledWith('E2E');
  });

  it('removes the listener when the hook becomes inactive', () => {
    const onScan = vi.fn();
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { rerender } = renderHook(({ active }) => useWedgeScan(active, DEFAULT_SCANNER_SETTINGS, onScan), { initialProps: { active: true } });
    rerender({ active: false });
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    const t = type(['E', '2', 'E'], 5, 1_000);
    vi.setSystemTime(t);
    keydown('Enter');
    expect(onScan).not.toHaveBeenCalled();
    removeSpy.mockRestore();
  });
});

describe('stripScanAffixes', () => {
  it.each([
    ['#ABC!', '#', '!', 'ABC'],
    ['ABC', '#', '!', 'ABC'],
    ['A#B!C', '#', '!', 'A#B!C'],
    ['#ABC!', '', '', '#ABC!'],
    ['##ABC!!', '#', '!', '#ABC!'],
    ['📦ABC🔎', '📦', '🔎', 'ABC'],
    ['', '#', '!', ''],
  ])('strips %s with prefix %s and suffix %s to %s', (raw, prefix, suffix, code) => {
    expect(stripScanAffixes(raw, { ...DEFAULT_SCANNER_SETTINGS, prefix, suffix })).toBe(code);
  });
});

describe('scanCode', () => {
  const settings: ScannerSettings = { ...DEFAULT_SCANNER_SETTINGS, prefix: '#', suffix: '!' };

  it('gives the stripped code for a fast buffer', () => {
    expect(scanCode('#E2E-2!', 1_000, 1_060, settings)).toBe('E2E-2');
  });

  it('gives null for a buffer slower than avgKeyMs', () => {
    expect(scanCode('#E2E-2!', 1_000, 1_000 + 6 * 200, settings)).toBeNull();
  });

  it('gives null for a code shorter than minChars after stripping', () => {
    expect(scanCode('#AB!', 1_000, 1_030, settings)).toBeNull();
  });
});

describe('useWedgeScanField', () => {
  const settings: ScannerSettings = { ...DEFAULT_SCANNER_SETTINGS, prefix: '#', suffix: '!' };
  const field = (onScan: (code: string) => void) => {
    const { result } = renderHook(() => useWedgeScanField(settings, onScan));
    return (key: string) => result.current({ nativeEvent: { key } } as NativeSyntheticEvent<TextInputKeyPressEventData>);
  };
  // Presses each key `gapMs` apart from `startAt`; returns the time after the last one.
  const press = (keyPress: (key: string) => void, keys: string[], gapMs: number, startAt: number) => {
    let t = startAt;
    for (const key of keys) { vi.setSystemTime(t); keyPress(key); t += gapMs; }
    return t;
  };

  it('calls onScan once with the stripped code for a fast buffer and Enter', () => {
    const onScan = vi.fn();
    const keyPress = field(onScan);
    press(keyPress, [...Array.from('#E2E-2!'), 'Enter'], 10, 1_000);
    expect(onScan).toHaveBeenCalledExactlyOnceWith('E2E-2');
  });

  it('does not call onScan for keys slower than avgKeyMs', () => {
    const onScan = vi.fn();
    const keyPress = field(onScan);
    press(keyPress, [...Array.from('#E2E-2!'), 'Enter'], 200, 1_000);
    expect(onScan).not.toHaveBeenCalled();
  });

  it('ignores Shift between the characters', () => {
    const onScan = vi.fn();
    const keyPress = field(onScan);
    press(keyPress, ['#', 'Shift', 'E', '2', 'Shift', 'E', '-', '2', '!', 'Enter'], 10, 1_000);
    expect(onScan).toHaveBeenCalledExactlyOnceWith('E2E-2');
  });

  it('empties the buffer on Backspace, so an edit never turns into a scan', () => {
    const onScan = vi.fn();
    const keyPress = field(onScan);
    press(keyPress, [...Array.from('shirx'), 'Backspace', 't', 'Enter'], 10, 1_000);
    expect(onScan).not.toHaveBeenCalled();
  });

  it('drops the keys before a gap over WEDGE_STALE_GAP_MS', () => {
    const onScan = vi.fn();
    const keyPress = field(onScan);
    const stale = press(keyPress, ['a', 'b'], 300, 1_000);
    press(keyPress, [...Array.from('E2E-2'), 'Enter'], 10, stale + WEDGE_STALE_GAP_MS + 100);
    expect(onScan).toHaveBeenCalledExactlyOnceWith('E2E-2');
  });
});
