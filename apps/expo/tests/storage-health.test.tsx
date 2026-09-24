// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Text } from 'react-native';
import type { StorageHealth as StorageHealthReading } from '@tallyui/database';
import { watchStorageHealth } from '../lib/storage-health';
import { StorageHealth } from '../components/storage-health';

function health(status: StorageHealthReading['status']): StorageHealthReading {
  return { status, stalledWrites: status === 'stalled' ? 1 : 0 };
}

afterEach(cleanup);

describe('StorageHealth', () => {
  it('shows the slow note and keeps the children while stalled', () => {
    const source = new BehaviorSubject<StorageHealthReading>(health('ok'));
    const unregister = watchStorageHealth(source);
    try {
      render(<StorageHealth><Text>children-rendered</Text></StorageHealth>);
      expect(screen.getByText('children-rendered')).toBeTruthy();
      expect(screen.queryByText('Saving is slow…')).toBeNull();

      act(() => { source.next(health('stalled')); });
      expect(screen.getByRole('alert').textContent).toBe('Saving is slow…');
      expect(screen.getByText('children-rendered')).toBeTruthy();
    } finally { unregister(); }
  });

  it('replaces the children with the reload prompt while dead, and Reload calls window.location.reload', () => {
    const source = new BehaviorSubject<StorageHealthReading>(health('ok'));
    const unregister = watchStorageHealth(source);
    const reload = vi.fn();
    // jsdom's `location.reload` is non-writable and non-configurable on its own object, so the
    // whole `window.location` property (which is configurable) is swapped out instead.
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, reload } });
    try {
      render(<StorageHealth><Text>children-rendered</Text></StorageHealth>);
      act(() => { source.next(health('dead')); });

      expect(screen.getByText('Storage stopped')).toBeTruthy();
      expect(screen.getByText(/MedusaPOS can.t save on this device right now\./)).toBeTruthy();
      expect(screen.queryByText('children-rendered')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
      unregister();
    }
  });
});
