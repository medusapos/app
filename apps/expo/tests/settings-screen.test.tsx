// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { DEFAULT_SCANNER_SETTINGS, loadScannerSettings, useScannerSettings } from '../lib/scanner-settings';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { loadTillName, useTillName } from '../lib/till-name';
import { loadDefaultCustomer } from '../lib/default-customer';
import { loadDefaultCustomerIsCashier } from '../lib/cashier-customer';
import SettingsScreen from '../app/settings';
import { AppFrame } from '../components/app-frame';
import { setWindowWidth } from './window-width';

const { searchCustomers } = vi.hoisted(() => ({ searchCustomers: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/pos-connector', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/pos-connector')>(),
  createPosConnector: () => ({ id: 'medusa', searchCustomers }),
}));

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), navigate: vi.fn(), push: vi.fn(), dismissTo: vi.fn() }, usePathname: () => '/settings',
  Stack: { Screen: ({ options }: { options: { headerLeft?: () => ReactNode; headerRight?: () => ReactNode } }) => <>
    <div data-testid="header-left">{options.headerLeft?.()}</div>
    {options.headerRight?.()}
  </> },
}));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));

const baseUrl = 'https://store.test';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  saveSession(localStorage, {
    baseUrl, email: 'admin@store.test',
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature`,
  });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function mountFramed(width: number, height: number) {
  setWindowWidth(width, height);
  return mount(<AppFrame signedIn><SettingsScreen /></AppFrame>);
}

async function mount(children: ReactNode = <SettingsScreen />) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<SessionProvider>{children}</SessionProvider>); });
  return view;
}

function TillNameReader() {
  const { tillName } = useTillName(localStorage, baseUrl);
  return <span aria-label="till name reader">{tillName ?? 'none'}</span>;
}

function Reader({ label }: { label: string }) {
  const { settings } = useScannerSettings(localStorage, baseUrl);
  return <span aria-label={label}>{settings.avgKeyMs}</span>;
}

describe('SettingsScreen', () => {
  it('saves a picked default customer and clears it back to Guest', async () => {
    const ada = { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' };
    searchCustomers.mockResolvedValueOnce([ada]);
    vi.useFakeTimers();
    await mount();
    expect(screen.getByTestId('settings-default-customer-current').textContent).toBe('Guest');
    fireEvent.change(screen.getByTestId('customer-picker-search'), { target: { value: 'ada' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    fireEvent.click(screen.getByText('Ada Lovelace'));
    expect(screen.getByTestId('settings-default-customer-current').textContent).toBe('Ada Lovelace');
    expect(loadDefaultCustomer(localStorage, baseUrl)).toEqual(ada);
    fireEvent.click(screen.getByTestId('settings-default-customer-clear'));
    expect(screen.getByTestId('settings-default-customer-current').textContent).toBe('Guest');
    expect(loadDefaultCustomer(localStorage, baseUrl)).toBeNull();
  });

  it('turns on Default customer is cashier and says which Medusa customer new sales start on', async () => {
    await mount();
    const toggle = screen.getByRole('switch', { name: 'Default customer is cashier' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByTestId('settings-default-customer-cashier-status')).toBeNull();
    searchCustomers.mockResolvedValueOnce([{ id: 'cus_x', name: 'X Admin', email: 'xadmin@store.test' },
      { id: 'cus_admin', name: 'Store Admin', email: 'admin@store.test' }]);
    await act(async () => { fireEvent.click(toggle); });
    expect(loadDefaultCustomerIsCashier(localStorage, baseUrl)).toBe(true);
    expect(searchCustomers).toHaveBeenCalledWith(expect.anything(), 'admin@store.test');
    expect(screen.getByTestId('settings-default-customer-cashier-status').textContent)
      .toBe('New sales start on Store Admin, the customer in Medusa with your email.');
    expect(screen.getByTestId('settings-default-customer-current').textContent).toBe('Guest');
  });

  it('says when no Medusa customer has the cashier\'s email', async () => {
    searchCustomers.mockResolvedValueOnce([{ id: 'cus_x', name: 'X Admin', email: 'xadmin@store.test' }]);
    localStorage.setItem('medusapos.default-customer-is-cashier.' + baseUrl, 'true');
    await mount();
    expect(screen.getByRole('switch', { name: 'Default customer is cashier' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('settings-default-customer-cashier-status').textContent)
      .toBe('No customer in Medusa has your email, admin@store.test. New sales start on the default customer above.');
  });

  it('on a wide window shows section navigation and only the chosen section', async () => {
    setWindowWidth(1024);
    try {
      await mount();
      expect(within(screen.getByTestId('settings-nav')).getAllByRole('button').map((item) => item.textContent))
        .toEqual(['General', 'Tax', 'Printing', 'Card readers', 'Barcode Scanning', 'Theme', 'Register', 'Customer', 'Danger zone']);
      expect(within(screen.getByTestId('settings-nav')).getAllByRole('button').map((item) => item.dataset.testid))
        .toEqual(['settings-nav-store', 'settings-nav-tax', 'settings-nav-printing', 'settings-nav-card-readers', 'settings-nav-scanner',
          'settings-nav-theme', 'settings-nav-register', 'settings-nav-customer', 'settings-nav-danger']);
      expect(screen.getByTestId('settings-store')).toBeTruthy();
      expect(screen.queryByLabelText('Minimum characters')).toBeNull();
      fireEvent.click(screen.getByTestId('settings-nav-scanner'));
      expect(screen.getByLabelText('Minimum characters')).toBeTruthy();
      expect(screen.getByTestId('settings-nav-scanner').getAttribute('aria-selected')).toBe('true');
      expect(screen.queryByTestId('settings-store')).toBeNull();
    } finally {
      act(() => setWindowWidth(0));
    }
  });

  it('on a wide window draws the chosen section in a card titled with its nav label', async () => {
    setWindowWidth(1024);
    try {
      await mount();
      const card = screen.getByTestId('settings-section-card');
      expect(within(card).getByTestId('settings-store')).toBeTruthy();
      expect(screen.getByTestId('settings-section-title').textContent).toBe('General');
      fireEvent.click(screen.getByTestId('settings-nav-tax'));
      expect(screen.getByTestId('settings-section-title').textContent).toBe('Tax');
      expect(within(screen.getByTestId('settings-section-card')).getByTestId('settings-tax')).toBeTruthy();
      fireEvent.click(screen.getByTestId('settings-nav-danger'));
      expect(screen.getByTestId('settings-section-title').textContent).toBe('Danger zone');
    } finally {
      act(() => setWindowWidth(0));
    }
  });

  it('on a phone the sections stack with no section card or title', async () => {
    await mount();
    expect(screen.queryByTestId('settings-section-card')).toBeNull();
    expect(screen.queryByTestId('settings-section-title')).toBeNull();
    expect(screen.getByTestId('settings-store')).toBeTruthy();
    expect(screen.getByTestId('settings-tax')).toBeTruthy();
  });

  it('redirects to login when signed out', async () => {
    localStorage.removeItem('medusapos.session');
    await mount();
    expect(screen.getByText('redirect:/login')).toBeTruthy();
  });

  it('shows the saved values on open', async () => {
    await mount();
    expect((screen.getByLabelText('Average time per key (ms)') as HTMLInputElement).value).toBe(String(DEFAULT_SCANNER_SETTINGS.avgKeyMs));
    expect((screen.getByLabelText('Minimum characters') as HTMLInputElement).value).toBe(String(DEFAULT_SCANNER_SETTINGS.minChars));
  });

  it('saves valid values, keeping the last valid save when a later one is refused', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText('Average time per key (ms)'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('Minimum characters'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(loadScannerSettings(localStorage, baseUrl)).toEqual({ ...DEFAULT_SCANNER_SETTINGS, avgKeyMs: 60, minChars: 6 });

    fireEvent.change(screen.getByLabelText('Minimum characters'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText(/whole number/)).toBeTruthy();
    expect(loadScannerSettings(localStorage, baseUrl)).toEqual({ ...DEFAULT_SCANNER_SETTINGS, avgKeyMs: 60, minChars: 6 });
  });

  it('saves scanner prefix and suffix', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText('Scanner prefix'), { target: { value: '#' } });
    fireEvent.change(screen.getByLabelText('Scanner suffix'), { target: { value: '!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(loadScannerSettings(localStorage, baseUrl)).toEqual({ ...DEFAULT_SCANNER_SETTINGS, prefix: '#', suffix: '!' });
  });

  it('saves sound immediately while leaving an unsaved threshold unsaved', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText('Minimum characters'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Play a sound on scan' }));
    expect(loadScannerSettings(localStorage, baseUrl)).toEqual({ ...DEFAULT_SCANNER_SETTINGS, playSound: true });
    expect(screen.getByTestId('settings-scanner-sound').getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText('Minimum characters') as HTMLInputElement).value).toBe('6');
  });

  it('reports the stripped test scan with timing from the raw buffer', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText('Scanner prefix'), { target: { value: '#' } });
    fireEvent.change(screen.getByLabelText('Scanner suffix'), { target: { value: '!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const field = screen.getByLabelText('Test scan here');
    vi.useFakeTimers();
    for (const [index, key] of ['#', 'A', 'B', 'C', '!'].entries()) {
      vi.setSystemTime(1_000 + index * 80); fireEvent.keyDown(field, { key });
    }
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByText(/^Last scan: ABC · 3 characters · average 80 ms per key/)).toBeTruthy();
    expect(screen.getByText('Counts as a scan')).toBeTruthy();
  });

  it('resets to defaults', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText('Minimum characters'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    expect((screen.getByLabelText('Minimum characters') as HTMLInputElement).value).toBe(String(DEFAULT_SCANNER_SETTINGS.minChars));
    expect(loadScannerSettings(localStorage, baseUrl)).toEqual(DEFAULT_SCANNER_SETTINGS);
  });

  it('a save updates every other mounted reader live, the way the wedge listener reads it', async () => {
    await mount(<><SettingsScreen /><Reader label="reader" /></>);
    expect(screen.getByLabelText('reader').textContent).toBe(String(DEFAULT_SCANNER_SETTINGS.avgKeyMs));
    fireEvent.change(screen.getByLabelText('Average time per key (ms)'), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByLabelText('reader').textContent).toBe('42');
  });

  it('the Register section saves the till name through the hook, live for every reader', async () => {
    await mount(<><SettingsScreen /><TillNameReader /></>);
    expect(screen.getByText('Register')).toBeTruthy();
    expect(screen.getByText('Shown to another till that finds this register open or takes it over. Leave empty to use \u201cWeb till\u201d.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Till name'), { target: { value: ' Front counter ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save till name' }));
    expect(loadTillName(localStorage, baseUrl)).toBe('Front counter');
    expect(screen.getByLabelText('till name reader').textContent).toBe('Front counter');
  });

  it('a 65-character till name shows the error and saves nothing', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText('Till name'), { target: { value: 'x'.repeat(65) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save till name' }));
    expect(screen.getByText('A till name can be at most 64 characters.')).toBeTruthy();
    expect(loadTillName(localStorage, baseUrl)).toBeNull();
  });

  it('the test field reports the average and verdict for a fast input', async () => {
    await mount();
    const field = screen.getByLabelText('Test scan here');
    vi.useFakeTimers();
    const start = 1_000;
    for (const [index, key] of ['E', '2', 'E'].entries()) { vi.setSystemTime(start + index * 20); fireEvent.keyDown(field, { key }); }
    vi.setSystemTime(start + 3 * 20);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByText(/Last scan: E2E · 3 characters · average 20 ms per key/)).toBeTruthy();
    expect(screen.getByText('Counts as a scan')).toBeTruthy();
  });

  it('the test field reports the verdict for a slow input', async () => {
    await mount();
    const field = screen.getByLabelText('Test scan here');
    vi.useFakeTimers();
    const start = 1_000;
    for (const [index, key] of ['A', 'B', 'C', 'D'].entries()) { vi.setSystemTime(start + index * 150); fireEvent.keyDown(field, { key }); }
    vi.setSystemTime(start + 4 * 150);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByText('Too slow / too short')).toBeTruthy();
  });

  it('shows help text for minimum characters and the test field', async () => {
    await mount();
    expect(screen.getByText('Codes shorter than this are treated as typing, not a scan')).toBeTruthy();
    expect(screen.getByText('Scan a barcode into this field to check it counts as a scan')).toBeTruthy();
  });

  it('on a phone Settings shows one control in the header, the frame\'s Menu (walkthrough item 10)', async () => {
    await mountFramed(390, 844);
    const headerLeft = screen.getByTestId('header-left');
    expect(headerLeft.contains(screen.getByTestId('frame-menu'))).toBe(true);
    expect(within(headerLeft).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Products' })).toBeNull();
    expect(screen.queryByText('‹ Products')).toBeNull();
  });

  // dismissTo replaces when nothing is under Settings, as when it was opened directly by URL.
  it('on a phone the drawer\'s Sale goes home by dismissTo, for when Settings was opened directly by URL', async () => {
    await mountFramed(390, 844);
    fireEvent.click(screen.getByTestId('frame-menu'));
    fireEvent.click(within(screen.getByTestId('nav-drawer')).getByRole('button', { name: 'Sale' }));
    expect(router.dismissTo).toHaveBeenCalledExactlyOnceWith('/');
    expect(router.replace).not.toHaveBeenCalled();
  });

  // A replace would mount a second, empty Products screen over the one holding the sale.
  it('on a wide window the header has no back control and the rail\'s Sale dismisses to the sale under Settings', async () => {
    await mountFramed(1440, 900);
    expect(screen.getByTestId('header-left').childElementCount).toBe(0);
    fireEvent.click(within(screen.getByTestId('nav-rail')).getByRole('button', { name: 'Sale' }));
    expect(router.dismissTo).toHaveBeenCalledExactlyOnceWith('/');
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });
});
