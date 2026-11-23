// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { router, usePathname } from 'expo-router';
import { AppFrame, AreaAccountButton, FrameMenuButton, frameStep, useFrameAccountPublisher, useFrameBadge } from '../components/app-frame';
import { version as appVersion } from '../package.json';
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

const navIds = (root: ParentNode = document) => Array.from(root.querySelectorAll('[data-testid^="nav-item-"]'))
  .map((node) => node.getAttribute('data-testid')).filter((id) => !id!.endsWith('-badge'));

beforeEach(() => setWindowWidth(1440, 900));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (document.documentElement as { clientWidth?: number }).clientWidth;
  delete (document.documentElement as { clientHeight?: number }).clientHeight;
});

describe('AppFrame on a wide window', () => {
  it('shows the package version through the rail\'s own footer, under its bottom items', () => {
    mount('/');
    const version = screen.getByTestId('frame-version');
    expect(version.textContent).toBe(`v ${appVersion}`);
    expect(screen.getByTestId('nav-rail-footer').contains(version)).toBe(true);
    expect(screen.getByTestId('nav-rail').contains(version)).toBe(true);
    expect(screen.getByTestId('frame-rail').contains(screen.getByTestId('nav-rail'))).toBe(true);
    expect(screen.getByTestId('nav-item-settings').compareDocumentPosition(version) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows no version on /login or when signed out', () => {
    for (const [pathname, signedIn] of [['/login', true], ['/', false]] as const) {
      mount(pathname, { signedIn });
      expect(screen.queryByTestId('frame-version')).toBeNull();
      cleanup();
    }
  });

  it('draws the rail with POS, Products, Orders, Customers, Reports and Settings in that order, and no menu button', () => {
    mount('/');
    expect(screen.getByTestId('app-frame')).toBeTruthy();
    expect(screen.getByTestId('nav-rail')).toBeTruthy();
    expect(navIds()).toEqual(['nav-item-sale', 'nav-item-products', 'nav-item-orders', 'nav-item-customers', 'nav-item-reports', 'nav-item-settings']);
    expect(['POS', 'Products', 'Orders', 'Customers', 'Reports', 'Settings'].map((name) => screen.getByRole('button', { name }).getAttribute('data-testid')))
      .toEqual(navIds());
    expect(screen.queryByTestId('frame-menu')).toBeNull();
  });

  it('the first entry reads POS, as v2\'s menu does, on the rail and in the drawer', () => {
    mount('/');
    const rail = screen.getByTestId('nav-rail');
    expect(navIds(rail)[0]).toBe('nav-item-sale');
    expect(within(rail).getByRole('button', { name: 'POS' }).getAttribute('data-testid')).toBe('nav-item-sale');
    expect(within(rail).queryByRole('button', { name: 'Sale' })).toBeNull();
    cleanup();
    setWindowWidth(390, 844);
    mount('/');
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const panel = screen.getByTestId('nav-drawer-panel');
    expect(navIds(panel)[0]).toBe('nav-item-sale');
    expect(within(panel).getByRole('button', { name: 'POS' }).getAttribute('data-testid')).toBe('nav-item-sale');
    expect(within(panel).queryByRole('button', { name: 'Sale' })).toBeNull();
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
  it('shows the package version at the drawer\'s foot through its footer, and none with the drawer closed', () => {
    setWindowWidth(390, 844);
    mount('/');
    expect(screen.queryByTestId('frame-version')).toBeNull();
    expect(screen.queryByTestId('frame-drawer-version')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const version = screen.getByTestId('frame-drawer-version');
    expect(version.textContent).toBe(`v ${appVersion}`);
    expect(screen.getByTestId('nav-drawer-footer').contains(version)).toBe(true);
    expect(screen.getByTestId('nav-drawer-panel').contains(version)).toBe(true);
    expect(screen.getByTestId('nav-item-settings').compareDocumentPosition(version) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('frame-version')).toBeNull();
  });

  it('starts the drawer on its POS row, with no block above it', () => {
    setWindowWidth(390, 844);
    mount('/');
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const panel = screen.getByTestId('nav-drawer-panel');
    expect(panel.textContent).toMatch(/^POS/);
    expect(panel.querySelector('[data-testid^="nav-item-"]')?.getAttribute('data-testid')).toBe('nav-item-sale');
  });

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

  it('lists POS, Products, Orders, Customers, Reports and Settings in the drawer in v2\'s order', () => {
    setWindowWidth(390, 844);
    mount('/');
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const panel = screen.getByTestId('nav-drawer-panel');
    expect(navIds(panel)).toEqual(['nav-item-sale', 'nav-item-products', 'nav-item-orders', 'nav-item-customers', 'nav-item-reports', 'nav-item-settings']);
    expect(['POS', 'Products', 'Orders', 'Customers', 'Reports', 'Settings'].map((name) => within(panel).getByRole('button', { name }).getAttribute('data-testid')))
      .toEqual(navIds(panel));
  });

  it('a phone on its side (844 x 390) is a phone', () => {
    setWindowWidth(844, 390);
    mount('/orders');
    expect(screen.queryByTestId('nav-rail')).toBeNull();
    expect(screen.getByTestId('frame-menu')).toBeTruthy();
  });
});

describe('the account channel (row 14a)', () => {
  function Publisher({ open }: { open: () => void }) {
    useFrameAccountPublisher({ displayName: 'Dana Cole', initials: 'DC', open });
    return null;
  }

  it('a published account draws the area avatar, named for the user, which calls open once', () => {
    vi.mocked(usePathname).mockReturnValue('/orders');
    const open = vi.fn();
    render(<AppFrame signedIn><Publisher open={open} /><AreaAccountButton /></AppFrame>);
    const button = screen.getByRole('button', { name: 'Account: Dana Cole' });
    expect(button.getAttribute('data-testid')).toBe('area-user-menu');
    expect(within(button).getByTestId('area-user-menu-avatar').textContent).toBe('DC');
    fireEvent.click(button);
    expect(open).toHaveBeenCalledOnce();
  });

  it('draws nothing with no publisher, or once the publisher unmounts', () => {
    vi.mocked(usePathname).mockReturnValue('/orders');
    const { rerender } = render(<AppFrame signedIn><AreaAccountButton /></AppFrame>);
    expect(screen.queryByTestId('area-user-menu')).toBeNull();
    rerender(<AppFrame signedIn><Publisher open={vi.fn()} /><AreaAccountButton /></AppFrame>);
    expect(screen.getByTestId('area-user-menu')).toBeTruthy();
    rerender(<AppFrame signedIn><AreaAccountButton /></AppFrame>);
    expect(screen.queryByTestId('area-user-menu')).toBeNull();
  });

  it('outside the frame the publisher does not throw and the area avatar draws nothing', () => {
    expect(() => render(<><Publisher open={vi.fn()} /><AreaAccountButton /></>)).not.toThrow();
    expect(screen.queryByTestId('area-user-menu')).toBeNull();
  });
});
