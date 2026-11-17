// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameDrawerHeader, phoneRegisterState, registerStateLabel, storeRegisterTitle } from '../components/frame-drawer-header';

const state = vi.hoisted(() => ({
  session: { baseUrl: 'http://localhost:9000' } as { baseUrl: string } | null,
  register: { session: { status: 'open' } as { status: string } | null },
  boundRegisterId: 'register-1' as string | null | undefined,
  registerName: 'Register 1' as string | null,
  settings: { storeName: 'E2E Store' } as { storeName: string } | null,
}));
vi.mock('../lib/session-context', () => ({ useSession: vi.fn(() => ({ session: state.session })) }));
vi.mock('../lib/register-context', () => ({ useRegister: vi.fn(() => state) }));
vi.mock('../lib/store-settings', () => ({ loadCachedSettings: vi.fn(() => state.settings) }));

beforeEach(() => {
  state.session = { baseUrl: 'http://localhost:9000' };
  state.register = { session: { status: 'open' } };
  state.boundRegisterId = 'register-1';
  state.registerName = 'Register 1';
  state.settings = { storeName: 'E2E Store' };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('registerStateLabel', () => {
  it.each([
    ['open', 'Open'], ['counting', 'Counting'], ['closed', 'Closed'], ['conflict', 'Closed'],
    ['superseded', 'Closed'], ['abandoned', 'Closed'], [null, 'Closed'], [undefined, 'Closed'],
  ])('maps %s to %s', (status, label) => {
    expect(registerStateLabel(status)).toBe(label);
  });
});

describe('storeRegisterTitle', () => {
  it('names the store and bound register', () => {
    expect(storeRegisterTitle('E2E Store', 'register-1', 'Register 1')).toBe('E2E Store · Register 1');
  });
  it('uses Register when the bound register name is null', () => {
    expect(storeRegisterTitle('E2E Store', 'register-1', null)).toBe('E2E Store · Register');
  });
  it('names only the store when no register is chosen', () => {
    expect(storeRegisterTitle('E2E Store', null, null)).toBe('E2E Store');
  });
  it('names only the store while the binding is unknown', () => {
    expect(storeRegisterTitle('E2E Store', undefined, null)).toBe('E2E Store');
  });
});

describe('phoneRegisterState', () => {
  it('is absent while the binding is unknown', () => {
    expect(phoneRegisterState(undefined, 'closed')).toBeNull();
  });
  it('asks to choose a register when none is chosen', () => {
    expect(phoneRegisterState(null, undefined)).toBe('Choose register');
  });
  it('is absent for an open register', () => {
    expect(phoneRegisterState('register-1', 'open')).toBeNull();
  });
  it('shows Counting for a counting session', () => {
    expect(phoneRegisterState('register-1', 'counting')).toBe('Counting');
  });
  it.each(['closed', 'conflict', null, undefined])('shows Closed for a %s status', (status) => {
    expect(phoneRegisterState('register-1', status)).toBe('Closed');
  });
});

describe('FrameDrawerHeader', () => {
  it('shows the cached store name and the open register', () => {
    render(<FrameDrawerHeader />);
    expect(screen.getByTestId('frame-drawer-store').textContent).toBe('E2E Store');
    expect(screen.getByTestId('frame-drawer-register').textContent).toBe('Register 1 · Open');
  });

  it('shows Counting for a counting session', () => {
    state.register.session = { status: 'counting' };
    render(<FrameDrawerHeader />);
    expect(screen.getByTestId('frame-drawer-register').textContent).toBe('Register 1 · Counting');
  });

  it('shows Closed when the register has no session', () => {
    state.register.session = null;
    render(<FrameDrawerHeader />);
    expect(screen.getByTestId('frame-drawer-register').textContent).toBe('Register 1 · Closed');
  });

  it('uses Register when the register name is null', () => {
    state.register.session = null;
    state.registerName = null;
    render(<FrameDrawerHeader />);
    expect(screen.getByTestId('frame-drawer-register').textContent).toBe('Register · Closed');
  });

  it('shows No register chosen when unbound', () => {
    state.boundRegisterId = null;
    render(<FrameDrawerHeader />);
    expect(screen.getByTestId('frame-drawer-register').textContent).toBe('No register chosen');
  });

  it('omits the register line while the binding is unread', () => {
    state.boundRegisterId = undefined;
    render(<FrameDrawerHeader />);
    expect(screen.queryByTestId('frame-drawer-register')).toBeNull();
  });

  it.each([null, { storeName: '  ' }])('uses the host when cached settings are %s', (settings) => {
    state.settings = settings;
    render(<FrameDrawerHeader />);
    expect(screen.getByTestId('frame-drawer-store').textContent).toBe('localhost:9000');
  });

  it('renders nothing without a signed-in session', () => {
    state.session = null;
    const { container } = render(<FrameDrawerHeader />);
    expect(screen.queryByTestId('frame-drawer-header')).toBeNull();
    expect(container.childElementCount).toBe(0);
  });
});
