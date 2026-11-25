// @vitest-environment jsdom
// v2's No sale opens the cash drawer: a recorded No sale kicks the drawer printer once, a refused one kicks nothing and
// its error still reaches the sheet, and a paid in or paid out never opens it.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PosOrder } from '@tallyui/pos';
import { PortalHost } from '@tallyui/primitives';
import type { RxCollection } from 'rxdb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RegisterPanelSheet } from '../components/register';
import { useRegister, type RegisterContextValue } from '../lib/register-context';
import type { Session } from '../lib/session';
import { useSession } from '../lib/session-context';
import { openCashDrawer } from '../lib/thermal-printing';
import { openRegisterFixture } from './register-fixture';

const ORDERS = { name: 'pos_orders' } as unknown as RxCollection<PosOrder>;

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-GB' }] }));
vi.mock('../lib/register-context', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/register-context')>(), useRegister: vi.fn(),
}));
vi.mock('../lib/session-context', () => ({ useSession: vi.fn() }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn(() => ({ orders: ORDERS })) }));
vi.mock('../lib/thermal-printing', () => ({ openCashDrawer: vi.fn(async () => {}) }));

let recordMovement: ReturnType<typeof vi.fn>;
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  vi.mocked(useSession).mockReturnValue({ session: { baseUrl: 'https://store-drawer.test', email: 'admin@store.test', token: 't',
    capabilities: { register: 3 } as Session['capabilities'] } } as ReturnType<typeof useSession>);
  const fixture = openRegisterFixture();
  recordMovement = vi.fn(async () => ({ id: 'movement-1' }));
  vi.mocked(useRegister).mockReturnValue({ ...fixture,
    register: { ...fixture.register, actions: { ...fixture.register.actions, recordMovement } } } as unknown as RegisterContextValue);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function openSheet(button: string) {
  await act(async () => {
    render(<><RegisterPanelSheet currency="EUR" store={{ name: 'Shop' }} online open onOpenChange={vi.fn()} /><PortalHost /></>);
  });
  fireEvent.click(await screen.findByTestId(button));
  return within(await screen.findByTestId('movement-sheet'));
}

describe('the cash drawer from the register panel', () => {
  it('a recorded No sale opens the drawer once, with this till\'s orders', async () => {
    const sheet = await openSheet('register-panel-no-sale');
    fireEvent.click(sheet.getByTestId('movement-reason-drawer-check'));
    await act(async () => { fireEvent.click(sheet.getByTestId('movement-confirm')); });
    expect(recordMovement).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'no_sale' }));
    expect(openCashDrawer).toHaveBeenCalledExactlyOnceWith(ORDERS);
  });

  it('a refused No sale opens nothing, and its error reaches the sheet', async () => {
    recordMovement.mockRejectedValue(new Error('The register is closed.'));
    const sheet = await openSheet('register-panel-no-sale');
    fireEvent.click(sheet.getByTestId('movement-reason-drawer-check'));
    await act(async () => { fireEvent.click(sheet.getByTestId('movement-confirm')); });
    expect(recordMovement).toHaveBeenCalledOnce();
    expect(openCashDrawer).not.toHaveBeenCalled();
    expect(await sheet.findByText('The register is closed.')).toBeTruthy();
  });

  it.each([['register-panel-paid-in', 'paid_in'], ['register-panel-paid-out', 'paid_out']])('%s never opens the drawer', async (button, type) => {
    const sheet = await openSheet(button);
    fireEvent.change(sheet.getByTestId('movement-amount'), { target: { value: '5.00' } });
    fireEvent.change(sheet.getByTestId('movement-reason'), { target: { value: 'Change' } });
    await act(async () => { fireEvent.click(sheet.getByTestId('movement-confirm')); });
    expect(recordMovement).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type }));
    expect(openCashDrawer).not.toHaveBeenCalled();
  });
});
