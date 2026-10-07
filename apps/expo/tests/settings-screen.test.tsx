// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';
import { DEFAULT_SCANNER_SETTINGS, loadScannerSettings, useScannerSettings } from '../lib/scanner-settings';
import { saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { loadTillName, useTillName } from '../lib/till-name';
import SettingsScreen from '../app/settings';

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), navigate: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => false) },
  Stack: { Screen: ({ options }: { options: { headerLeft?: () => ReactNode; headerRight?: () => ReactNode } }) => <>
    <div data-testid="header-left">{options.headerLeft?.()}</div>
    {options.headerRight?.()}
  </> },
}));

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
    expect(loadScannerSettings(localStorage, baseUrl)).toEqual({ avgKeyMs: 60, minChars: 6 });

    fireEvent.change(screen.getByLabelText('Minimum characters'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText(/whole number/)).toBeTruthy();
    expect(loadScannerSettings(localStorage, baseUrl)).toEqual({ avgKeyMs: 60, minChars: 6 });
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

  it('Settings shows one Products back control, in the header (walkthrough item 10)', async () => {
    await mount();
    const headerLeft = screen.getByTestId('header-left');
    const products = screen.getAllByRole('button', { name: 'Products' });
    expect(products).toHaveLength(1);
    expect(headerLeft.contains(products[0])).toBe(true);
    const labels = screen.getAllByText('‹ Products');
    expect(labels).toHaveLength(1);
    expect(headerLeft.contains(labels[0])).toBe(true);
  });

  it('the Products link navigates home, for when Settings was opened directly by URL', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Products' }));
    expect(router.replace).toHaveBeenCalledWith('/');
    expect(router.back).not.toHaveBeenCalled();
  });

  // A replace would mount a second, empty Products screen over the one holding the sale.
  it('the Products link goes back to the Products screen under Settings when there is history', async () => {
    vi.mocked(router.canGoBack).mockReturnValueOnce(true);
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Products' }));
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });
});
