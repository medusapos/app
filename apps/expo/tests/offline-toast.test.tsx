// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_HELP_URL, OFFLINE_TOAST_DELAY_MS, OfflineToast, useOfflineToast } from '../components/offline-toast';
import type { SyncState } from '../lib/use-replicated-products';

vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));

const DESCRIPTION = 'Keep working — sync resumes when the store is reachable.';
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

function mountHook(networkOnline: boolean, pullState: SyncState = 'synced') {
  return renderHook(({ online, pull }) => useOfflineToast(online, pull), { initialProps: { online: networkOnline, pull: pullState } });
}

describe('useOfflineToast', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows nothing while the till is online and the pull is up to date', () => {
    const { result } = mountHook(true, 'synced');
    advance(OFFLINE_TOAST_DELAY_MS * 4);
    expect(result.current.kind).toBeNull();
  });

  it('shows device once the network has been gone for 5 s, not before', () => {
    const { result } = mountHook(false);
    advance(4_999);
    expect(result.current.kind).toBeNull();
    advance(1);
    expect(result.current.kind).toBe('device');
  });

  it('shows store when the network is up but the pull says offline', () => {
    const { result } = mountHook(true, 'offline');
    advance(5_000);
    expect(result.current.kind).toBe('store');
  });

  it('a 3 s blip shows nothing', () => {
    const { result, rerender } = mountHook(true);
    rerender({ online: false, pull: 'synced' });
    advance(3_000);
    rerender({ online: true, pull: 'synced' });
    advance(3_000);
    expect(result.current.kind).toBeNull();
    advance(OFFLINE_TOAST_DELAY_MS);
    expect(result.current.kind).toBeNull();
  });

  it('close hides it for the rest of the outage; the next outage shows it again after a fresh 5 s', () => {
    const { result, rerender } = mountHook(false);
    advance(5_000);
    expect(result.current.kind).toBe('device');
    act(() => { result.current.close(); });
    expect(result.current.kind).toBeNull();
    advance(OFFLINE_TOAST_DELAY_MS * 2);
    expect(result.current.kind).toBeNull();
    rerender({ online: true, pull: 'synced' });
    rerender({ online: false, pull: 'synced' });
    advance(4_999);
    expect(result.current.kind).toBeNull();
    advance(1);
    expect(result.current.kind).toBe('device');
  });

  it('device turning into store inside one outage keeps the toast, retitled; the pull catching up hides it at once', () => {
    const { result, rerender } = mountHook(false, 'offline');
    advance(5_000);
    expect(result.current.kind).toBe('device');
    rerender({ online: true, pull: 'offline' });
    expect(result.current.kind).toBe('store');
    rerender({ online: true, pull: 'synced' });
    expect(result.current.kind).toBeNull();
  });
});

describe('OfflineToast', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('device reads Device went offline with v2 description, as an alert', () => {
    render(<OfflineToast kind="device" onClose={() => {}} />);
    expect(screen.getByRole('alert')).toBe(screen.getByTestId('offline-toast'));
    expect(screen.getByText('Device went offline')).toBeTruthy();
    expect(screen.getByText(DESCRIPTION)).toBeTruthy();
  });

  it('store reads Website is unreachable', () => {
    render(<OfflineToast kind="store" onClose={() => {}} />);
    expect(screen.getByText('Website is unreachable')).toBeTruthy();
    expect(screen.queryByText('Device went offline')).toBeNull();
  });

  it('Close calls onClose and Help opens the offline docs in a new tab', () => {
    const onClose = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<OfflineToast kind="device" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('offline-toast-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('offline-toast-close').getAttribute('aria-label')).toBe('Close');
    fireEvent.click(screen.getByTestId('offline-toast-help'));
    expect(open).toHaveBeenCalledWith(OFFLINE_HELP_URL, '_blank', 'noopener,noreferrer');
  });
});
