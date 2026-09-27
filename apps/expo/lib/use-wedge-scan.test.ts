// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCANNER_SETTINGS, type ScannerSettings } from './scanner-settings';
import { useWedgeScan, WEDGE_STALE_GAP_MS } from './use-wedge-scan';

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
    const settings: ScannerSettings = { avgKeyMs: 30, minChars: 3 };
    renderHook(() => useWedgeScan(true, settings, onScan));
    const t = type(['A', 'B', 'C', 'D'], 50, 1_000);
    vi.setSystemTime(t);
    keydown('Enter');
    expect(onScan).not.toHaveBeenCalled();
  });

  it('takes minChars from settings: 3 characters do not fire at minChars 6', () => {
    const onScan = vi.fn();
    const settings: ScannerSettings = { avgKeyMs: 100, minChars: 6 };
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
