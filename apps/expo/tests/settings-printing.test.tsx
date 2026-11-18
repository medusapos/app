// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPrintingSettings } from '../lib/printing-settings';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import SettingsScreen from '../app/settings';
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

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); act(() => setWindowWidth(0)); });

async function mount(children: ReactNode = <SettingsScreen />) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<SessionProvider>{children}</SessionProvider>); });
  return view;
}

const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('Settings › Printing', () => {
  it('on a wide window lists Printing between Tax and Card readers and shows its section', async () => {
    setWindowWidth(1280, 800);
    await mount();
    const printing = screen.getByTestId('settings-nav-printing');
    expect(printing.textContent).toBe('Printing');
    expect(follows(screen.getByTestId('settings-nav-tax'), printing)).toBe(true);
    expect(follows(printing, screen.getByTestId('settings-nav-card-readers'))).toBe(true);
    expect(screen.queryByTestId('settings-printing')).toBeNull();
    fireEvent.click(printing);
    expect(screen.getByTestId('settings-printing')).toBeTruthy();
  });

  it('saves the auto-print switch on this till', async () => {
    setWindowWidth(1280, 800);
    await mount();
    fireEvent.click(screen.getByTestId('settings-nav-printing'));
    expect(screen.getByRole('switch', { name: 'Automatically print receipt after checkout', checked: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Automatically print receipt after checkout' }));
    expect(loadPrintingSettings(localStorage, baseUrl).autoPrintReceipt).toBe(true);
    expect(screen.getByRole('switch', { name: 'Automatically print receipt after checkout', checked: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Automatically print receipt after checkout' }));
    expect(loadPrintingSettings(localStorage, baseUrl).autoPrintReceipt).toBe(false);
  });

  it('on a phone shows Printing between Tax and Card readers', async () => {
    setWindowWidth(390, 844);
    await mount();
    const printing = screen.getByTestId('settings-printing');
    expect(follows(screen.getByTestId('settings-tax'), printing)).toBe(true);
    expect(follows(printing, screen.getByTestId('settings-card-readers'))).toBe(true);
  });

  it('names the print dialog as the print method under the auto-print switch', async () => {
    setWindowWidth(1280, 800);
    await mount();
    fireEvent.click(screen.getByTestId('settings-nav-printing'));
    const method = screen.getByTestId('settings-printing-method');
    expect(method.textContent).toBe('Print dialog (browser)');
    expect(screen.getByText('Print method')).toBeTruthy();
    expect(follows(screen.getByRole('switch', { name: 'Automatically print receipt after checkout' }), method)).toBe(true);
    expect(screen.queryByRole('switch', { name: 'Print method' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Print method' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Print method' })).toBeNull();
  });

  it('says no print method on a native till', async () => {
    const original = Platform.OS;
    Platform.OS = 'ios';
    try {
      setWindowWidth(390, 844);
      await mount();
      expect(screen.getByTestId('settings-printing-method').textContent).toBe('Not available on this device');
    } finally { Platform.OS = original; }
  });
});
