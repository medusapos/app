// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNetworkOnline } from '../lib/use-network-online';

function setOnLine(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
}

afterEach(() => {
  // jsdom's own getter is on Navigator.prototype; dropping the instance override restores it.
  delete (window.navigator as { onLine?: boolean }).onLine;
  vi.restoreAllMocks();
});

describe('useNetworkOnline', () => {
  it.each([true, false])('starts from navigator.onLine (%s)', (value) => {
    setOnLine(value);
    const { result } = renderHook(() => useNetworkOnline());
    expect(result.current).toBe(value);
  });

  it('follows the window offline and online events', () => {
    setOnLine(true);
    const { result } = renderHook(() => useNetworkOnline());
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(result.current).toBe(false);
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(result.current).toBe(true);
  });

  it('removes both listeners on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useNetworkOnline());
    unmount();
    for (const type of ['online', 'offline']) {
      const added = add.mock.calls.find(([name]) => name === type)?.[1];
      expect(added).toBeTypeOf('function');
      expect(remove).toHaveBeenCalledWith(type, added);
    }
  });
});
