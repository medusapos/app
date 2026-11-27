// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import RootLayout from '../app/_layout';

let pathname: string;
vi.mock('expo-router', () => ({ usePathname: () => pathname, Slot: () => <div data-testid="slot" />, Stack: () => null }));
vi.mock('../lib/session-context', () => ({ SessionProvider: () => <div data-testid="session-provider" /> }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: () => null }));
vi.mock('uniwind', () => ({ Uniwind: { setTheme: vi.fn() } }));
vi.mock('../components/clear-local-data', async () => ({ ClearLocalDataGate: (await import('react')).Fragment }));
vi.mock('../components/font-choice', async () => ({ AppFontProvider: (await import('react')).Fragment }));
vi.mock('../components/app-frame', () => ({ AppFrame: () => null }));
vi.mock('../components/device-scanner', () => ({ DeviceScannerProvider: () => null }));
vi.mock('../components/storage-health', () => ({ StorageHealth: () => null }));
vi.mock('../components/store-refused', () => ({ OutboxStrip: () => null }));
vi.mock('../lib/outbox-context', () => ({ OutboxProvider: () => null }));
vi.mock('../lib/customer-display-context', () => ({ CustomerDisplayProvider: () => null }));

afterEach(cleanup);

it('RL-1: /display renders the route slot outside the till session', () => {
  pathname = '/display';
  render(<RootLayout />);
  expect(screen.getByTestId('slot')).toBeTruthy();
  expect(screen.queryByTestId('session-provider')).toBeNull();
});

it('RL-2: / still renders the session provider rather than the display slot', () => {
  pathname = '/';
  render(<RootLayout />);
  expect(screen.getByTestId('session-provider')).toBeTruthy();
  expect(screen.queryByTestId('slot')).toBeNull();
});
