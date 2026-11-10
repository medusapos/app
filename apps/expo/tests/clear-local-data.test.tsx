// @vitest-environment jsdom
// Settings › Danger zone › Clear all local data: the startup gate and the confirm dialog.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createOrderBuilder, finalizeOrder } from '@tallyui/pos';
import { PortalHost } from '@tallyui/primitives';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClearLocalDataGate, ClearLocalDataSection } from '../components/clear-local-data';
import { CLEAR_FLAG_KEY, clearAllLocalData, reloadPage } from '../lib/clear-local-data';
import { draftsCollection, openOrderStore, registerCollections } from '../lib/order-store';
import { useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { useSession } from '../lib/session-context';

vi.mock('../lib/clear-local-data', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/clear-local-data')>(), reloadPage: vi.fn(), clearAllLocalData: vi.fn(),
}));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('../lib/register-context', () => ({ useRegister: vi.fn() }));
vi.mock('../lib/session-context', () => ({ useSession: vi.fn() }));

// Only the fields the dialog reads; `orders` is a real (memory) order store's, or null while it opens.
let store: Awaited<ReturnType<typeof openOrderStore>> | undefined;
function setOutbox(pending: number, rejected: number, savesInFlight: number, orders = store?.orders ?? null) {
  vi.mocked(useOutboxContext).mockReturnValue({ state: { pending, rejected, sending: false }, savesInFlight, orders } as ReturnType<typeof useOutboxContext>);
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
    expect(screen.getByText('Some local data may already be deleted.')).toBeTruthy();
    expect(reloadPage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('clear-local-data-retry'));
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('app')).toBeNull();
    expect(stored.get(CLEAR_FLAG_KEY)).toBe('1');
  });

  it('Cancel reset leaves a failed clear: the flag goes and the app reloads', async () => {
    stored.set(CLEAR_FLAG_KEY, '1');
    stored.set('medusapos.session', '{}');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(clearAllLocalData).mockRejectedValue(new Error('held'));
    await act(async () => { gate(); });
    fireEvent.click(screen.getByTestId('clear-local-data-cancel-reset'));
    expect(stored.has(CLEAR_FLAG_KEY)).toBe(false);
    expect(stored.get('medusapos.session')).toBe('{}');
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });
});

describe('ClearLocalDataSection', () => {
  beforeEach(async () => {
    store = await openOrderStore(`https://clear-${crypto.randomUUID()}.test`);
    setOutbox(0, 0, 0);
  });
  afterEach(async () => { cleanup(); await store?.close(); store = undefined; });
  const unknown = "Can't tell yet what is unsent on this device, so treat it as lost.";
  const warning = () => screen.getByTestId('clear-local-data-warning').textContent;
  // The counts are live queries, so the lines settle once each has emitted.
  const section = async (settle = true) => {
    await act(async () => { render(<><ClearLocalDataSection /><PortalHost /></>); });
    await act(async () => { fireEvent.click(screen.getByTestId('clear-local-data')); });
    if (settle) await waitFor(() => expect(warning()).not.toBe(unknown));
  };

  const confirm = async () => { await act(async () => { fireEvent.click(screen.getByTestId('clear-local-data-confirm')); }); };
  const type = async (value: string) => {
    await act(async () => { fireEvent.change(screen.getByTestId('clear-local-data-word'), { target: { value } }); });
  };
  const line = (n: number) => screen.queryByTestId(`clear-local-data-warning-${n}`)?.textContent;
  const takeOver = 'The till is open. Its session stays open on your server: after the reset, open this register again and choose Take over.';
  const at = '2026-11-10T09:00:00.000Z';
  const commands = (...statuses: ('pending' | 'applied' | 'rejected')[]) => registerCollections(store!.orders).commands.bulkInsert(
    statuses.map((syncStatus, seq) => ({ key: `movement.record:${seq}`, registerId: 'register-1', seq, commandId: `command-${seq}`,
      type: 'register.movement.record' as const, version: 1, payload: {}, createdAt: at, updatedAt: at, syncStatus })));
  const sales = (...statuses: ('pending' | 'applied' | 'rejected')[]) => store!.orders.bulkInsert(statuses.map((syncStatus, i) => {
    const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
    builder.addLine({ productId: 'shirt', name: 'Shirt', unitPrice: { amount: 100, currency: 'EUR' } });
    builder.addPayment({ method: 'cash', amountMinor: 100 });
    return { ...finalizeOrder(builder.getSnapshot()), id: `order-${i}`, createdAt: at, syncStatus };
  }));
  const lockedUntilClear = async () => {
    await confirm();
    expect(stored.has(CLEAR_FLAG_KEY)).toBe(false);
    await type('CLEAR');
    await confirm();
    expect(stored.get(CLEAR_FLAG_KEY)).toBe('1');
  };

  it('counts unsent till entries apart from sales', async () => {
    setOutbox(0, 0, 1);
    await sales('pending', 'pending', 'rejected', 'applied');
    await commands('pending', 'pending', 'pending', 'applied');
    await section();
    expect(warning()).toBe('4 sales and 3 till entries on this device have never reached your server and will be permanently lost.');
  });

  it('counts unsent sales from the order store, not the outbox state', async () => {
    setOutbox(0, 0, 0);
    await sales('pending', 'rejected');
    await section();
    expect(warning()).toBe('2 sales on this device have never reached your server and will be permanently lost.');
    await lockedUntilClear();
  });

  it('counts a till entry the server refused, which the register outbox does not', async () => {
    setTill({ pending: 0 });
    await commands('rejected');
    await section();
    expect(warning()).toBe('1 till entry on this device has never reached your server and will be permanently lost.');
    expect(line(1)).toBe('Till entries are till opens, pay ins and outs, and closures, including any your server refused.');
    await lockedUntilClear();
  });

  it('names a parked sale and needs the typed word', async () => {
    await draftsCollection(store!.orders)!.insert({ id: 'draft-1', data: '{}', itemCount: 1, total: 250, parkedAt: at });
    await section();
    expect(warning()).toBe('1 parked sale on this device has never reached your server and will be permanently lost.');
    expect(line(1)).toBe('Parked sales are kept only on this device.');
    await lockedUntilClear();
  });

  it('an order store still opening is treated as lost', async () => {
    setOutbox(0, 0, 0, null);
    await section(false);
    expect(warning()).toBe(unknown);
    await lockedUntilClear();
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
    expect(line(1)).toBeUndefined();
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
