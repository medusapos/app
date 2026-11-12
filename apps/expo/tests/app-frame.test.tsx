// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router, usePathname } from 'expo-router';
import { AppFrame, FrameMenuButton, frameStep, useFrameBadge } from '../components/app-frame';
import { setWindowWidth } from './window-width';

vi.mock('expo-router', () => ({
  usePathname: vi.fn(() => '/'),
  router: { push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn() },
}));

function Area({ count = 0 }: { count?: number }) {
  useFrameBadge('orders', count);
  return <FrameMenuButton />;
}

function mount(pathname: string, { signedIn = true, count = 0 } = {}) {
  vi.mocked(usePathname).mockReturnValue(pathname);
  return render(<AppFrame signedIn={signedIn}><Area count={count} /></AppFrame>);
}

const navIds = () => Array.from(document.querySelectorAll('[data-testid^="nav-item-"]'))
  .map((node) => node.getAttribute('data-testid')).filter((id) => !id!.endsWith('-badge'));

beforeEach(() => setWindowWidth(1440, 900));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (document.documentElement as { clientWidth?: number }).clientWidth;
  delete (document.documentElement as { clientHeight?: number }).clientHeight;
});

describe('AppFrame on a wide window', () => {
  it('draws the rail with Sale, Orders, Reports and Settings in that order, and no menu button', () => {
    mount('/');
    expect(screen.getByTestId('app-frame')).toBeTruthy();
    expect(screen.getByTestId('nav-rail')).toBeTruthy();
    expect(navIds()).toEqual(['nav-item-sale', 'nav-item-orders', 'nav-item-reports', 'nav-item-settings']);
    expect(['Sale', 'Orders', 'Reports', 'Settings'].map((name) => screen.getByRole('button', { name }).getAttribute('data-testid')))
      .toEqual(navIds());
    expect(screen.queryByTestId('frame-menu')).toBeNull();
  });

  it('shows the attention count on Orders and hides it at 0', () => {
    const view = mount('/', { count: 3 });
    expect(screen.getByTestId('nav-item-orders-badge').textContent).toBe('3');
    view.rerender(<AppFrame signedIn><Area count={0} /></AppFrame>);
    expect(screen.queryByTestId('nav-item-orders-badge')).toBeNull();
  });

  it('pushes an area over the sale, replaces between areas, dismisses back to / and ignores the current area', () => {
    mount('/');
    fireEvent.click(screen.getByTestId('nav-item-sale'));
    fireEvent.click(screen.getByTestId('nav-item-orders'));
    expect(router.push).toHaveBeenCalledExactlyOnceWith('/orders');
    cleanup();
    mount('/orders');
    fireEvent.click(screen.getByTestId('nav-item-orders'));
    fireEvent.click(screen.getByTestId('nav-item-reports'));
    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/reports');
    fireEvent.click(screen.getByTestId('nav-item-sale'));
    expect(router.dismissTo).toHaveBeenCalledExactlyOnceWith('/');
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('marks the current route active', () => {
    mount('/settings');
    expect(screen.getByTestId('nav-item-settings').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('nav-item-sale').getAttribute('aria-current')).toBeNull();
  });

  it('draws no frame on /login, /demo or when signed out', () => {
    for (const [path, signedIn] of [['/login', true], ['/demo', true], ['/', false]] as const) {
      mount(path, { signedIn });
      expect(screen.queryByTestId('app-frame')).toBeNull();
      expect(screen.queryByTestId('nav-rail')).toBeNull();
      cleanup();
    }
  });
});

describe('frameStep', () => {
  it('is null to the same area, dismisses to /, pushes from the sale and replaces between areas', () => {
    expect(frameStep('orders', 'orders')).toBeNull();
    expect(frameStep('settings', 'sale')).toEqual({ method: 'dismissTo', href: '/' });
    expect(frameStep('sale', 'reports')).toEqual({ method: 'push', href: '/reports' });
    expect(frameStep('orders', 'settings')).toEqual({ method: 'replace', href: '/settings' });
  });
});

describe('AppFrame on a phone', () => {
  it('has no rail; the 44 px menu button opens the drawer, which navigates and closes', async () => {
    setWindowWidth(390, 844);
    mount('/', { count: 2 });
    expect(screen.queryByTestId('nav-rail')).toBeNull();
    expect(screen.queryByTestId('nav-drawer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByTestId('nav-drawer')).toBeTruthy();
    expect(screen.getByTestId('nav-item-orders-badge').textContent).toBe('2');
    fireEvent.click(screen.getByTestId('nav-item-orders'));
    expect(router.push).toHaveBeenCalledExactlyOnceWith('/orders');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(screen.queryByTestId('nav-drawer')).toBeNull();
  });

  it('a phone on its side (844 x 390) is a phone', () => {
    setWindowWidth(844, 390);
    mount('/orders');
    expect(screen.queryByTestId('nav-rail')).toBeNull();
    expect(screen.getByTestId('frame-menu')).toBeTruthy();
  });
});
