// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveSession } from '../lib/session';
import { saveCachedPricing } from '../lib/store-settings';
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
// Settings' Danger zone imports the approval dialog, which reads the locale.
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-GB' }] }));

const baseUrl = 'https://store.test';
const regionId = 'reg_eu';
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
// Answers /info with the plugin contract and /payment-providers with the providers, by URL.
const providersResponse = (providers: unknown[], pluginContract = 6) => vi.fn(async (url: string) =>
  url.includes('/tally/v1/info') ? ok({ contracts: {}, pluginContract })
    : url.includes('/tally/v1/payment-providers') ? ok({ providers }) : new Response(null, { status: 404 }));
const manual = { id: 'pp_system_default', name: 'Manual payment', tillCanTake: true, terminal: false };
const stripe = { id: 'pp_stripe_stripe', name: 'Stripe', tillCanTake: false, terminal: true };

beforeEach(() => {
  vi.stubGlobal('fetch', providersResponse([]));
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
  saveCachedPricing(localStorage, baseUrl, { currency: 'EUR', pricesIncludeTax: true, taxRatesPpm: { default: 250000 },
    pricingContext: { region_id: regionId, currency_code: 'eur' } });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); act(() => setWindowWidth(0)); delete params.section; });

async function mount(children: ReactNode = <SettingsScreen />) {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<SessionProvider>{children}</SessionProvider>); });
  return view;
}

const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('Settings › Card readers', () => {
  it('on a wide window lists Card readers between Printing and Scanner and shows how cards are taken', async () => {
    setWindowWidth(1280, 800);
    await mount();
    const nav = screen.getByTestId('settings-nav-card-readers');
    expect(nav.textContent).toBe('Card readers');
    expect(follows(screen.getByTestId('settings-nav-printing'), nav)).toBe(true);
    expect(follows(nav, screen.getByTestId('settings-nav-scanner'))).toBe(true);
    expect(screen.queryByTestId('settings-card-readers')).toBeNull();
    fireEvent.click(nav);
    expect(screen.getByTestId('settings-card-readers')).toBeTruthy();
    expect(screen.getByTestId('settings-card-readers').textContent).toContain('Readers this till can take card payments with.');
    expect(screen.queryByTestId('settings-card-readers-method')).toBeNull();
    const how = screen.getByTestId('settings-card-readers-how').textContent;
    expect(how).toContain('Terminal reference');
    expect(how).toContain('Card terminal');
    expect(screen.getByTestId('settings-nav-card-readers').getAttribute('aria-selected')).toBe('true');
  });

  it('on a phone lists Card readers between Printing and Scanner', async () => {
    setWindowWidth(0);
    await mount();
    const cardReaders = screen.getByTestId('settings-list-card-readers');
    expect(cardReaders.textContent).toBe('Card readers');
    expect(follows(screen.getByTestId('settings-list-printing'), cardReaders)).toBe(true);
    expect(follows(cardReaders, screen.getByTestId('settings-list-scanner'))).toBe(true);
  });

  it("lists the store's payment providers and whether this till can take each", async () => {
    vi.stubGlobal('fetch', providersResponse([
      { id: 'pp_system_default', name: 'Manual payment', tillCanTake: true, terminal: false },
      { id: 'pp_stripe_stripe', name: 'Stripe', tillCanTake: false, terminal: false },
    ]));
    setWindowWidth(1280, 800);
    await mount();
    fireEvent.click(screen.getByTestId('settings-nav-card-readers'));
    await screen.findByTestId('settings-payment-providers');
    expect(screen.getByTestId('settings-payment-provider-pp_system_default').textContent).toContain('Manual payment');
    expect(screen.getByTestId('settings-payment-provider-pp_system_default-state').textContent).toBe('Taken at this till');
    expect(screen.getByTestId('settings-payment-provider-pp_stripe_stripe').textContent).toContain('Stripe');
    expect(screen.getByTestId('settings-payment-provider-pp_stripe_stripe-state').textContent).toBe('Not at this till');
    expect(screen.getByTestId('settings-card-readers-how')).toBeTruthy();
  });

  it('with no payment providers shows the card note only', async () => {
    setWindowWidth(1280, 800);
    await mount();
    fireEvent.click(screen.getByTestId('settings-nav-card-readers'));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringMatching(`^${baseUrl}/tally/v1/payment-providers`), expect.anything()));
    await act(async () => {});
    expect(screen.getByTestId('settings-card-readers-how')).toBeTruthy();
    expect(screen.queryByTestId('settings-payment-providers')).toBeNull();
  });

  it("lists the region's terminal providers as card readers, each Not paired", async () => {
    vi.stubGlobal('fetch', providersResponse([manual, stripe]));
    setWindowWidth(1280, 800);
    await mount();
    fireEvent.click(screen.getByTestId('settings-nav-card-readers'));
    expect((await screen.findByTestId('settings-card-reader-pp_stripe_stripe')).textContent).toContain('Stripe');
    expect(screen.getByTestId('settings-card-reader-pp_stripe_stripe-state').textContent).toBe('Not paired');
    const group = screen.getByTestId('settings-payment-providers');
    expect(group.textContent).not.toContain('Stripe');
    expect(screen.queryByTestId('settings-payment-provider-pp_stripe_stripe')).toBeNull();
    expect(screen.getByTestId('settings-payment-provider-pp_system_default').textContent).toContain('Manual payment');
    expect(screen.queryByTestId('settings-card-reader-pp_system_default')).toBeNull();
    expect(screen.getByTestId('settings-card-readers-how').textContent).toContain("isn't available yet");
  });

  it("asks for the till's region's providers", async () => {
    setWindowWidth(1280, 800);
    await mount();
    fireEvent.click(screen.getByTestId('settings-nav-card-readers'));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`${baseUrl}/tally/v1/payment-providers?region_id=${regionId}`, expect.anything()));
  });

  it('on a plugin older than contract 6 lists no readers and says to update the plugin', async () => {
    vi.stubGlobal('fetch', providersResponse([manual, stripe], 5));
    setWindowWidth(1280, 800);
    await mount();
    fireEvent.click(screen.getByTestId('settings-nav-card-readers'));
    await screen.findByTestId('settings-card-readers-update');
    expect(screen.queryByTestId(/^settings-card-reader-pp_/)).toBeNull();
    expect(screen.getByTestId('settings-card-readers-how').textContent).toContain('No card readers');
  });

  it('with the plugin contract unknown (the /info read fails), says nothing about updating the plugin', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('/tally/v1/info') ? new Response(null, { status: 500 })
        : url.includes('/tally/v1/payment-providers') ? ok({ providers: [manual, stripe] }) : new Response(null, { status: 404 })));
    setWindowWidth(1280, 800);
    await mount();
    fireEvent.click(screen.getByTestId('settings-nav-card-readers'));
    await screen.findByTestId('settings-payment-provider-pp_system_default');
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringMatching(`^${baseUrl}/tally/v1/info`), expect.anything()));
    expect(screen.queryByTestId('settings-card-readers-update')).toBeNull();
    expect(screen.queryByTestId(/^settings-card-reader-pp_/)).toBeNull();
    expect(screen.getByTestId('settings-card-readers-how').textContent).toContain('No card readers');
  });

  it('with no terminal providers says there are no card readers and how to take a card at checkout', async () => {
    vi.stubGlobal('fetch', providersResponse([manual]));
    setWindowWidth(1280, 800);
    await mount();
    fireEvent.click(screen.getByTestId('settings-nav-card-readers'));
    await screen.findByTestId('settings-payment-provider-pp_system_default');
    expect(screen.queryByTestId(/^settings-card-reader-pp_/)).toBeNull();
    expect(screen.queryByTestId('settings-card-readers-update')).toBeNull();
    const how = screen.getByTestId('settings-card-readers-how').textContent;
    expect(how).toContain('No card readers');
    expect(how).toContain('Terminal reference');
  });
});
