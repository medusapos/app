// @vitest-environment jsdom
// Settings › Danger zone › Clear all local data: the startup gate and the confirm dialog.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClearLocalDataGate, ClearLocalDataSection } from '../components/clear-local-data';
import { CLEAR_FLAG_KEY, clearAllLocalData, reloadPage } from '../lib/clear-local-data';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { useSession } from '../lib/session-context';

vi.mock('../lib/clear-local-data', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/clear-local-data')>(), reloadPage: vi.fn(), clearAllLocalData: vi.fn(),
}));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('../lib/register-context', () => ({ useRegister: vi.fn() }));
vi.mock('../lib/session-context', () => ({ useSession: vi.fn() }));

// Only the fields the dialog reads.
function setOutbox(pending: number, rejected: number, savesInFlight: number) {
  vi.mocked(useOutboxContext).mockReturnValue({ state: { pending, rejected, sending: false }, savesInFlight } as ReturnType<typeof useOutboxContext>);
}
function setTill({ pending = 0, status = 'closed', capabilities = { orderCreate: 5, register: 3 } }: {
  pending?: number; status?: string; capabilities?: { orderCreate: number; register?: number };
}) {
  vi.mocked(useRegister).mockReturnValue({
    register: { session: { status } }, registerOutbox: { state: { pending, sending: false } },
  } as unknown as ReturnType<typeof useRegister>);
  vi.mocked(useSession).mockReturnValue({ session: { capabilities } } as unknown as ReturnType<typeof useSession>);
}

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
  setOutbox(0, 0, 0);
  setTill({});
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

  const confirm = async () => { await act(async () => { fireEvent.click(screen.getByTestId('clear-local-data-confirm')); }); };
  const type = async (value: string) => {
    await act(async () => { fireEvent.change(screen.getByTestId('clear-local-data-word'), { target: { value } }); });
  };
  const line = (n: number) => screen.queryByTestId(`clear-local-data-warning-${n}`)?.textContent;
  const takeOver = 'The till is open. Its session stays open on your server: after the reset, open this register again and choose Take over.';

  it('counts the till outbox apart from sales', async () => {
    setOutbox(2, 1, 1);
    setTill({ pending: 3 });
    await section();
    expect(screen.getByTestId('clear-local-data-warning').textContent)
      .toBe('4 sales and 3 till entries on this device have never reached your server and will be permanently lost.');
  });

  it('an open till warns and needs the typed word', async () => {
    for (const status of ['open', 'counting'] as const) {
      stored.clear();
      locationReload.mockClear();
      setTill({ status });
      await section();
      expect(line(1)).toBe(takeOver);
      expect(screen.getByTestId('clear-local-data-word')).toBeTruthy();
      await confirm();
      expect(stored.has(CLEAR_FLAG_KEY)).toBe(false);
      await type('clea');
      await confirm();
      expect(stored.has(CLEAR_FLAG_KEY)).toBe(false);
      await type(' clear ');
      await confirm();
      expect(stored.get(CLEAR_FLAG_KEY)).toBe('1');
      expect(locationReload).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  it('warns that an unsynced store loses the cash record', async () => {
    setTill({ status: 'open', capabilities: { orderCreate: 5 } });
    await section();
    expect(line(1)).toBe("The till is open. This store doesn't keep till records, so its cash record (float, pay ins and outs) will be lost.");
    expect(screen.getByTestId('clear-local-data-word')).toBeTruthy();
    cleanup();

    setTill({ status: 'closed', capabilities: { orderCreate: 5 } });
    await section();
    expect(line(1)).toBe("This store doesn't keep till records, so this device's till history will be lost.");
    expect(screen.queryByTestId('clear-local-data-word')).toBeNull();
    await confirm();
    expect(stored.get(CLEAR_FLAG_KEY)).toBe('1');
  });

  it('nothing at risk keeps the two-step confirm', async () => {
    await section();
    expect(screen.queryByTestId('clear-local-data-word')).toBeNull();
    await confirm();
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
