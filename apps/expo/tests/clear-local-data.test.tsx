// @vitest-environment jsdom
// Settings › Danger zone › Clear all local data: the startup gate and the confirm dialog.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClearLocalDataGate, ClearLocalDataSection } from '../components/clear-local-data';
import { CLEAR_FLAG_KEY, clearAllLocalData, reloadPage, unsentWarning } from '../lib/clear-local-data';
import { useOutboxContext } from '../lib/outbox-context';

vi.mock('../lib/clear-local-data', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/clear-local-data')>(), reloadPage: vi.fn(), clearAllLocalData: vi.fn(),
}));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));

let stored: Map<string, string>;
let locationReload: ReturnType<typeof vi.fn>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
    removeItem: (key: string) => { stored.delete(key); },
  });
  // requestClearLocalData calls its own module's reloadPage, which the module mock cannot reach: location.reload is
  // what that real reloadPage calls.
  locationReload = vi.fn();
  vi.stubGlobal('location', { reload: locationReload });
  vi.mocked(clearAllLocalData).mockResolvedValue(undefined);
  vi.mocked(useOutboxContext).mockReturnValue({ state: { pending: 2, sending: false }, savesInFlight: 1 } as ReturnType<typeof useOutboxContext>);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const gate = () => render(<ClearLocalDataGate><span>app</span></ClearLocalDataGate>);

describe('ClearLocalDataGate', () => {
  it('renders the app when no clear is pending', () => {
    gate();
    expect(screen.getByText('app')).toBeTruthy();
    expect(clearAllLocalData).not.toHaveBeenCalled();
  });

  it('clears before the app renders, then reloads', async () => {
    stored.set(CLEAR_FLAG_KEY, '1');
    let finish!: () => void;
    vi.mocked(clearAllLocalData).mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    gate();
    expect(screen.queryByText('app')).toBeNull();
    expect(screen.getByTestId('clear-local-data-progress').textContent).toBe('Clearing local data…');
    expect(clearAllLocalData).toHaveBeenCalledTimes(1);
    expect(reloadPage).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('app')).toBeNull();
  });

  it('a failed clear offers Reload and retry', async () => {
    stored.set(CLEAR_FLAG_KEY, '1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(clearAllLocalData).mockRejectedValue(new Error('held'));
    await act(async () => { gate(); });
    expect(screen.getByTestId('clear-local-data-failed').textContent).toBe("Reset didn't finish");
    expect(reloadPage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('clear-local-data-retry'));
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('app')).toBeNull();
    expect(stored.get(CLEAR_FLAG_KEY)).toBe('1');
  });
});

describe('ClearLocalDataSection', () => {
  const section = async () => {
    await act(async () => { render(<><ClearLocalDataSection /><PortalHost /></>); });
    await act(async () => { fireEvent.click(screen.getByTestId('clear-local-data')); });
  };

  it('warns with the unsent count and confirms by flagging a reload', async () => {
    await section();
    expect(screen.getByTestId('clear-local-data-warning').textContent).toBe(unsentWarning(3));
    await act(async () => { fireEvent.click(screen.getByTestId('clear-local-data-confirm')); });
    expect(stored.get(CLEAR_FLAG_KEY)).toBe('1');
    expect(locationReload).toHaveBeenCalledTimes(1);
    expect(clearAllLocalData).not.toHaveBeenCalled();
    cleanup();

    stored.clear();
    locationReload.mockClear();
    await section();
    await act(async () => { fireEvent.click(screen.getByTestId('clear-local-data-cancel')); });
    expect(screen.queryByTestId('clear-local-data-warning')).toBeNull();
    expect(stored.has(CLEAR_FLAG_KEY)).toBe(false);
    expect(locationReload).not.toHaveBeenCalled();
  });
});
