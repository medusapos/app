// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import { PortalHost } from '@tallyui/primitives';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPrintingSettings } from '../lib/printing-settings';
import { BUILT_IN_PRINTER, printTestPage } from '../lib/printers';
import { printReceiptPage } from '../lib/receipt-templates';
import { saveSession } from '../lib/session';
import { saveCachedSettings } from '../lib/store-settings';
import { SessionProvider } from '../lib/session-context';
import SettingsScreen from '../app/settings';
import { setWindowWidth } from './window-width';

const { searchCustomers } = vi.hoisted(() => ({ searchCustomers: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/pos-connector', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/pos-connector')>(),
  createPosConnector: () => ({ id: 'medusa', searchCustomers }),
}));

// The phone opens one section per page, named by the route's `section` param.
const { params } = vi.hoisted(() => ({ params: {} as { section?: string } }));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), navigate: vi.fn(), push: vi.fn(), dismissTo: vi.fn() }, usePathname: () => '/settings',
  useLocalSearchParams: () => params,
  Stack: { Screen: ({ options }: { options: { headerLeft?: () => ReactNode; headerRight?: () => ReactNode } }) => <>
    <div data-testid="header-left">{options.headerLeft?.()}</div>
    {options.headerRight?.()}
  </> },
}));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));
// A printer's Test print, observed; the rest of the module (profiles, test page) stays real.
vi.mock('../lib/printers', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/printers')>(),
  printTestPage: vi.fn(),
}));
// Test print goes to the print dialog; the rest of the module (templates, sample, page) stays real.
vi.mock('../lib/receipt-templates', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/receipt-templates')>(),
  printReceiptPage: vi.fn(),
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

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); act(() => setWindowWidth(0)); delete params.section; });

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

  it('on a phone lists Printing between Tax and Card readers', async () => {
    setWindowWidth(390, 844);
    await mount();
    const printing = screen.getByTestId('settings-list-printing');
    expect(printing.textContent).toBe('Printing');
    expect(follows(screen.getByTestId('settings-list-tax'), printing)).toBe(true);
    expect(follows(printing, screen.getByTestId('settings-list-card-readers'))).toBe(true);
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
      params.section = 'printing';
      await mount();
      expect(screen.getByTestId('settings-printing-method').textContent).toBe('Not available on this device');
    } finally { Platform.OS = original; }
  });
});

describe('Settings › Printing › Receipt templates', () => {
  const templateIds = ['standard', 'thermal-80mm', 'thermal-58mm'];

  async function openPreview(name: string) {
    setWindowWidth(1280, 800);
    await mount(<><SettingsScreen /><PortalHost /></>);
    fireEvent.click(screen.getByTestId('settings-nav-printing'));
    fireEvent.click(screen.getByRole('button', { name: `Preview ${name}` }));
    return screen.findByTestId('receipt-template-preview');
  }

  it('on a wide window lists the three templates under the Printing group, each going to the print dialog', async () => {
    setWindowWidth(1280, 800);
    await mount();
    fireEvent.click(screen.getByTestId('settings-nav-printing'));
    const group = screen.getByTestId('settings-receipt-templates');
    expect(follows(screen.getByTestId('settings-printing'), group)).toBe(true);
    expect(within(group).getByText('Receipt templates')).toBeTruthy();
    const rows = templateIds.map((id) => within(group).getByTestId(`settings-receipt-template-${id}`));
    expect(follows(rows[0]!, rows[1]!) && follows(rows[1]!, rows[2]!)).toBe(true);
    const expected = [
      ['Standard Receipt', 'Sales'], ['Thermal Receipt (80mm)', 'Thermal 80mm'], ['Thermal Receipt (58mm)', 'Thermal 58mm'],
    ];
    rows.forEach((row, i) => {
      expect(within(row).getByText(expected[i]![0]!)).toBeTruthy();
      expect(within(row).getByText(expected[i]![1]!)).toBeTruthy();
      expect(within(row).getByTestId(`settings-receipt-template-${templateIds[i]}-printer`).textContent).toBe('Auto — Print dialog');
    });
    expect(screen.queryByTestId('settings-receipt-template-standard-preview')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preview Standard Receipt' })).toBeNull();
    expect(screen.getByTestId('settings-receipt-template-thermal-80mm-preview').textContent).toBe('Preview');
    expect(screen.getByTestId('settings-receipt-template-thermal-58mm-preview').textContent).toBe('Preview');
  });

  it("Preview opens the template filled with a sample sale from the cached store, until Close", async () => {
    saveCachedSettings(localStorage, baseUrl, {
      storeName: 'Corner shop', currency: 'GBP', location: { id: 'loc', name: 'Main', countryCode: 'GB', addressLine: '2 Low Road' },
    });
    const sheet = await openPreview('Thermal Receipt (80mm)');
    expect(within(sheet).getByRole('heading', { name: 'Thermal Receipt (80mm)' })).toBeTruthy();
    expect(within(sheet).getByText('Sample sale')).toBeTruthy();
    const srcdoc = within(sheet).getByTestId('receipt-template-preview-frame').getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('Corner shop');
    expect(srcdoc).toContain('2 Low Road');
    expect(srcdoc).toContain('Sample item');
    expect(srcdoc).not.toContain('<script');
    fireEvent.click(within(sheet).getByTestId('receipt-template-close'));
    await waitFor(() => expect(screen.queryByTestId('receipt-template-preview')).toBeNull());
  });

  it('Test print sends the previewed page to the print dialog and says how it went', async () => {
    vi.mocked(printReceiptPage).mockResolvedValueOnce(undefined);
    let sheet = await openPreview('Thermal Receipt (58mm)');
    const page = within(sheet).getByTestId('receipt-template-preview-frame').getAttribute('srcdoc');
    expect(page).toContain('Your store');
    expect(within(sheet).queryByTestId('receipt-template-print-status')).toBeNull();
    await act(async () => { fireEvent.click(within(sheet).getByTestId('receipt-template-test-print')); });
    expect(printReceiptPage).toHaveBeenCalledOnce();
    expect(vi.mocked(printReceiptPage).mock.calls[0]).toEqual([page]);
    expect((await within(sheet).findByTestId('receipt-template-print-status')).textContent).toBe('Sent to Print dialog');

    fireEvent.click(within(sheet).getByTestId('receipt-template-close'));
    await waitFor(() => expect(screen.queryByTestId('receipt-template-preview')).toBeNull());
    vi.mocked(printReceiptPage).mockRejectedValueOnce(new Error('jammed'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview Thermal Receipt (58mm)' }));
    sheet = await screen.findByTestId('receipt-template-preview');
    expect(within(sheet).queryByTestId('receipt-template-print-status')).toBeNull();
    await act(async () => { fireEvent.click(within(sheet).getByTestId('receipt-template-test-print')); });
    const failed = await within(sheet).findByTestId('receipt-template-print-status');
    expect(failed.textContent).toBe("Couldn't print. Try again.");
  });

  it('Test print is pressed once while a print is pending, and is ready again when it settles', async () => {
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    vi.mocked(printReceiptPage).mockReturnValueOnce(pending);
    const sheet = await openPreview('Thermal Receipt (80mm)');
    const button = within(sheet).getByTestId('receipt-template-test-print');
    expect(button.getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => { fireEvent.click(button); });
    expect(within(sheet).getByTestId('receipt-template-test-print').getAttribute('aria-disabled')).toBe('true');
    await act(async () => { fireEvent.click(within(sheet).getByTestId('receipt-template-test-print')); });
    expect(printReceiptPage).toHaveBeenCalledOnce();
    await act(async () => { settle(); });
    expect(within(sheet).getByTestId('receipt-template-test-print').getAttribute('aria-disabled')).not.toBe('true');
    expect(within(sheet).getByTestId('receipt-template-print-status').textContent).toBe('Sent to Print dialog');
  });

  it("an earlier opening's pending print never shows its outcome in a later opening", async () => {
    let settle!: () => void;
    vi.mocked(printReceiptPage).mockReturnValueOnce(new Promise<void>((resolve) => { settle = resolve; }));
    let sheet = await openPreview('Thermal Receipt (80mm)');
    await act(async () => { fireEvent.click(within(sheet).getByTestId('receipt-template-test-print')); });
    fireEvent.click(within(sheet).getByTestId('receipt-template-close'));
    await waitFor(() => expect(screen.queryByTestId('receipt-template-preview')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Preview Thermal Receipt (80mm)' }));
    sheet = await screen.findByTestId('receipt-template-preview');
    await act(async () => { settle(); });
    expect(within(sheet).queryByTestId('receipt-template-print-status')).toBeNull();
    expect(within(sheet).getByTestId('receipt-template-test-print').getAttribute('aria-disabled')).not.toBe('true');
  });

  it('sandboxes the preview frame, so a script in a receipt cannot run', async () => {
    const sheet = await openPreview('Thermal Receipt (58mm)');
    expect(within(sheet).getByTestId('receipt-template-preview-frame').getAttribute('sandbox')).toBe('');
  });

  it('on a native till lists the templates with no printer and no Preview', async () => {
    const original = Platform.OS;
    Platform.OS = 'ios';
    try {
      setWindowWidth(390, 844);
      params.section = 'printing';
      await mount();
      for (const id of templateIds) {
        expect(screen.getByTestId(`settings-receipt-template-${id}-printer`).textContent).toBe('Not available on this device');
        expect(screen.queryByTestId(`settings-receipt-template-${id}-preview`)).toBeNull();
      }
      expect(screen.queryByRole('button', { name: /^Preview/ })).toBeNull();
    } finally { Platform.OS = original; }
  });
});

describe('Settings › Printing › Printers', () => {
  async function openPrinting() {
    setWindowWidth(1280, 800);
    await mount();
    fireEvent.click(screen.getByTestId('settings-nav-printing'));
    return screen.getByTestId('settings-printers');
  }

  it('on a wide window lists the built-in print dialog between Printing and Receipt templates, with no Add printer', async () => {
    const group = await openPrinting();
    expect(follows(screen.getByTestId('settings-printing'), group)).toBe(true);
    expect(follows(group, screen.getByTestId('settings-receipt-templates'))).toBe(true);
    expect(within(group).getByText('Printers')).toBeTruthy();
    expect(within(group).getByText('Devices receipts can be sent to.')).toBeTruthy();
    const row = within(group).getByTestId('settings-printer-system');
    expect(within(row).getByText('Print dialog')).toBeTruthy();
    expect(within(row).getByText('Built-in')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Test print Print dialog' }).textContent).toBe('Test print');
    expect(within(group).queryByTestId('settings-printer-system-print-status')).toBeNull();
    expect(screen.queryByText(/Add printer/i)).toBeNull();
    expect(screen.queryByLabelText(/Add printer/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Add printer/i })).toBeNull();
  });

  it('Test print prints a test page through the built-in printer and says how it went', async () => {
    saveCachedSettings(localStorage, baseUrl, {
      storeName: 'Corner shop', currency: 'GBP', location: { id: 'loc', name: 'Main', countryCode: 'GB', addressLine: '2 Low Road' },
    });
    vi.mocked(printTestPage).mockResolvedValueOnce(undefined);
    await openPrinting();
    await act(async () => { fireEvent.click(screen.getByTestId('settings-printer-system-test-print')); });
    expect(printTestPage).toHaveBeenCalledOnce();
    const [profile, page] = vi.mocked(printTestPage).mock.calls[0]!;
    expect(profile).toEqual(BUILT_IN_PRINTER);
    expect(page).toContain('Corner shop');
    expect(page).toContain('Test print');
    expect((await screen.findByTestId('settings-printer-system-print-status')).textContent).toBe('Sent to Print dialog');

    vi.mocked(printTestPage).mockRejectedValueOnce(new Error('jammed'));
    await act(async () => { fireEvent.click(screen.getByTestId('settings-printer-system-test-print')); });
    await waitFor(() => expect(screen.getByTestId('settings-printer-system-print-status').textContent).toBe("Couldn't print. Try again."));

    let settle!: () => void;
    vi.mocked(printTestPage).mockReturnValueOnce(new Promise<void>((resolve) => { settle = resolve; }));
    await act(async () => { fireEvent.click(screen.getByTestId('settings-printer-system-test-print')); });
    expect(screen.getByTestId('settings-printer-system-test-print').getAttribute('aria-disabled')).toBe('true');
    await act(async () => { fireEvent.click(screen.getByTestId('settings-printer-system-test-print')); });
    expect(printTestPage).toHaveBeenCalledTimes(3);
    await act(async () => { settle(); });
    expect(screen.getByTestId('settings-printer-system-test-print').getAttribute('aria-disabled')).not.toBe('true');
    expect(screen.getByTestId('settings-printer-system-print-status').textContent).toBe('Sent to Print dialog');
  });

  it('on a phone shows the Printers group and its Test print', async () => {
    setWindowWidth(390, 844);
    params.section = 'printing';
    await mount();
    expect(within(screen.getByTestId('settings-printers')).getByTestId('settings-printer-system-test-print')).toBeTruthy();
  });

  it('on a native till says the printer is not available, with no Test print', async () => {
    const original = Platform.OS;
    Platform.OS = 'ios';
    try {
      setWindowWidth(390, 844);
      params.section = 'printing';
      await mount();
      expect(screen.getByTestId('settings-printer-system-status').textContent).toBe('Not available on this device');
      expect(screen.queryByTestId('settings-printer-system-test-print')).toBeNull();
      expect(screen.queryByRole('button', { name: /^Test print/ })).toBeNull();
    } finally { Platform.OS = original; }
  });
});
