// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { router } from 'expo-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DemoScreen from '../app/demo';
import { storeConfig } from '../lib/config';
import { DEMO_CAPTURE_URL } from '../lib/demo-analytics';
import { useSession } from '../lib/session-context';

vi.mock('expo-router', () => ({
  Redirect: () => null, router: { replace: vi.fn(), push: vi.fn() }, Stack: { Screen: () => null },
}));
vi.mock('expo-linking', () => ({ openURL: vi.fn() }));
vi.mock('../lib/session-context', () => ({ useSession: vi.fn() }));

const originalDemoMode = storeConfig.demo;
const originalAnalytics = storeConfig.analytics;
const originalFetch = globalThis.fetch;
const signIn = vi.fn();
const fetchMock = vi.fn<typeof fetch>();
const events = () => fetchMock.mock.calls.filter(([url]) => url === DEMO_CAPTURE_URL)
  .map(([, init]) => JSON.parse(init?.body as string).event);
beforeEach(() => {
  storeConfig.demo = true;
  storeConfig.analytics = true;
  signIn.mockReset().mockResolvedValue(undefined);
  vi.mocked(useSession).mockReturnValue({
    session: null, signIn, signOut: vi.fn(), reportUnauthorized: vi.fn(), mergeCapabilities: vi.fn(),
    setSaleHold: vi.fn(), setSavesHold: vi.fn(), signOutDeferred: false,
  });
  fetchMock.mockReset().mockImplementation((input, init) => input === DEMO_CAPTURE_URL
    ? Promise.resolve(new Response()) : originalFetch(input, init));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  storeConfig.demo = originalDemoMode;
  storeConfig.analytics = originalAnalytics;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('demo sign-in analytics', () => {
  it('sends demo_signed_in after a successful one-click sign-in', async () => {
    let resolveSignIn!: () => void;
    signIn.mockImplementation(() => new Promise<void>((resolve) => { resolveSignIn = resolve; }));
    render(<DemoScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Enter the demo' }));
    expect(events()).toEqual(['demo_opened']);
    resolveSignIn();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(signIn).toHaveBeenCalledExactlyOnceWith(storeConfig.defaultBaseUrl, 'cashier@demo.medusapos.com', 'demo1234');
    expect(events()).toEqual(['demo_opened', 'demo_signed_in']);
    expect(fetchMock.mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(router.replace).mock.invocationCallOrder[0]);
  });

  it('sends no demo_signed_in when sign-in rejects', async () => {
    signIn.mockRejectedValue(new Error('sign-in failed'));
    render(<DemoScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Enter the demo' }));
    await screen.findByRole('alert');
    expect(events()).toEqual(['demo_opened']);
    expect(router.replace).not.toHaveBeenCalled();
  });
});
