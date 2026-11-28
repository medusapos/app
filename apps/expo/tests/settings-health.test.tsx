// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { saleLogger } from '@tallyui/pos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthSection } from '../components/health-section';
import { clearRecentLogs, installLogSinks } from '../lib/logging';
import { version as appVersion } from '../package.json';

// The outbox and register hooks give the two outboxes' states; each test sets them.
const { outboxes } = vi.hoisted(() => ({ outboxes: { sales: { pending: 0 } as object, till: { pending: 0 } as object } }));
vi.mock('../lib/outbox-context', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/outbox-context')>(),
  useOutboxContext: () => ({ state: outboxes.sales }),
}));
vi.mock('../lib/register-context', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/register-context')>(),
  useRegister: () => ({ registerOutbox: { state: outboxes.till } }),
}));

const session = { baseUrl: 'https://store.test', email: 'admin@store.test', token: 'header.e30.signature' };
const info = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
}));
const writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  installLogSinks();
  clearRecentLogs();
  outboxes.sales = { pending: 0, sending: false };
  outboxes.till = { pending: 0, sending: false };
  vi.stubGlobal('fetch', info({ pluginContract: 5, pluginVersion: '0.3.0', contracts: {} }));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  Object.defineProperty(navigator, 'storage', { value: { estimate: async () => ({ usage: 25165824 }) }, configurable: true });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount() {
  await act(async () => { render(<HealthSection session={session} />); });
}
const text = (testID: string) => screen.getByTestId(testID).textContent;

describe('Settings › Health', () => {
  it('shows the store URL, the plugin contract from /info, the app version and the storage used', async () => {
    await mount();
    expect(text('settings-health-store-url')).toBe('https://store.test');
    await waitFor(() => expect(text('settings-health-plugin-contract')).toBe('5'));
    expect(text('settings-health-plugin-version')).toBe('0.3.0');
    expect(vi.mocked(fetch)).toHaveBeenCalledExactlyOnceWith('https://store.test/tally/v1/info', expect.anything());
    expect(text('settings-health-app-version')).toBe(appVersion);
    expect(text('settings-health-storage')).toBe('24 MB');
  });

  it('shows Unknown plugin version for a plugin from before the field', async () => {
    vi.stubGlobal('fetch', info({ contracts: {}, pluginContract: 5 }));
    await mount();
    await waitFor(() => expect(text('settings-health-plugin-contract')).toBe('5'));
    expect(text('settings-health-plugin-version')).toBe('Unknown');
  });

  it('shows Unknown plugin version when /info sends null', async () => {
    vi.stubGlobal('fetch', info({ contracts: {}, pluginContract: 5, pluginVersion: null }));
    await mount();
    await waitFor(() => expect(text('settings-health-plugin-contract')).toBe('5'));
    expect(text('settings-health-plugin-version')).toBe('Unknown');
  });

  it('shows Unknown when /info fails', async () => {
    vi.stubGlobal('fetch', info({}, 500));
    await mount();
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledOnce());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(text('settings-health-plugin-contract')).toBe('Unknown');
    expect(text('settings-health-plugin-version')).toBe('Unknown');
  });

  it('shows the sales and till updates waiting to send, and those that need attention', async () => {
    outboxes.sales = { pending: 2, sending: false, rejected: 1 };
    outboxes.till = { pending: 1, sending: false };
    await mount();
    expect(text('settings-health-sales-pending')).toBe('2');
    expect(text('settings-health-till-pending')).toBe('1');
    expect(text('settings-health-attention')).toBe('1');
  });

  it('logs: empty text and a disabled Copy, then live lines newest first, copied with their data', async () => {
    await mount();
    expect(text('settings-health-logs-empty')).toBe('No warnings or errors since the app started.');
    const copy = screen.getByTestId('settings-health-copy');
    expect(copy.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(copy);
    expect(writeText).not.toHaveBeenCalled();
    act(() => { saleLogger.warn('x', { a: 1 }); });
    act(() => { saleLogger.error('y'); });
    const lines = screen.getAllByTestId('settings-health-log-line').map((line) => line.textContent);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/ ERROR \[sale\] y$/);
    expect(lines[1]).toMatch(/ WARN \[sale\] x$/);
    expect(screen.queryByTestId('settings-health-logs-empty')).toBeNull();
    expect(copy.getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => { fireEvent.click(copy); });
    expect(writeText).toHaveBeenCalledOnce();
    const copied = writeText.mock.calls[0]![0].split('\n');
    expect(copied).toHaveLength(2);
    expect(copied[0]).toMatch(/ WARN \[sale\] x \{"a":1\}$/);
    expect(copied[1]).toMatch(/ ERROR \[sale\] y$/);
    expect(text('settings-health-copy-status')).toBe('Copied');
  });

  it('a clipboard that refuses shows Could not copy', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    await mount();
    act(() => { saleLogger.warn('x', { a: 1 }); });
    await act(async () => { fireEvent.click(screen.getByTestId('settings-health-copy')); });
    expect(text('settings-health-copy-status')).toBe('Could not copy');
  });
});
