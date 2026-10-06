// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { router } from 'expo-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DemoScreen from '../app/demo';
import { storeConfig } from '../lib/config';
import { SessionProvider } from '../lib/session-context';

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn() },
  Stack: { Screen: () => null },
}));
vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));

const originalDemoMode = storeConfig.demo;
beforeEach(() => {
  storeConfig.demo = true;
  vi.spyOn(window, 'open').mockImplementation(() => null);
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
});
afterEach(() => {
  cleanup();
  storeConfig.demo = originalDemoMode;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Demo card', () => {
  it('the demo card lists what to try: sell, split, attach a customer, park and resume, change a price, close the register', () => {
    render(<SessionProvider><DemoScreen /></SessionProvider>);
    expect(screen.getByRole('heading', { name: 'What to try', level: 2 })).toBeTruthy();
    for (const item of [
      'Ring up a sale and take cash or card',
      'Split a payment: part card, the rest cash (Split payment at checkout)',
      'Attach a customer to a sale: search one, or add a new one',
      'Park a sale, then resume it from Parked sales',
      "Change a line's price in the cart",
      'Close the register with a cash count',
    ]) expect(screen.getByText(`• ${item}`)).toBeTruthy();
  });

  it('About MedusaPOS and Quick start open in a new tab and leave the demo page', () => {
    render(<SessionProvider><DemoScreen /></SessionProvider>);
    fireEvent.click(screen.getByRole('link', { name: 'About MedusaPOS' }));
    fireEvent.click(screen.getByRole('link', { name: 'Quick start' }));
    expect(window.open).toHaveBeenNthCalledWith(1, 'https://medusapos.com', '_blank', 'noopener,noreferrer');
    expect(window.open).toHaveBeenNthCalledWith(2, 'https://github.com/medusapos/app/blob/main/docs/QUICKSTART.md', '_blank', 'noopener,noreferrer');
    expect(window.open).toHaveBeenCalledTimes(2);
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('the card makes no claim the demo cannot back: no refunds', () => {
    render(<SessionProvider><DemoScreen /></SessionProvider>);
    expect(document.body.textContent).not.toMatch(/refund/i);
  });
});
