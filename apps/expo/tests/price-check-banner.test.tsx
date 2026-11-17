// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriceCheckBanner, PRICE_CHECK_ONLY } from '../components/price-check-banner';
import { useRegister } from '../lib/register-context';
import { OPEN_SESSION, openRegisterFixture } from './register-fixture';

vi.mock('../lib/register-context', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/register-context')>(), useRegister: vi.fn(),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('PriceCheckBanner', () => {
  it('shows the price-check text without an alert role when unbound', () => {
    const fixture = openRegisterFixture();
    vi.mocked(useRegister).mockReturnValue({ ...fixture, boundRegisterId: null,
      register: { ...fixture.register, session: null } });
    render(<PriceCheckBanner />);
    expect(screen.getByTestId('price-check-banner').textContent).toBe(PRICE_CHECK_ONLY);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows when bound without a session', () => {
    const fixture = openRegisterFixture();
    vi.mocked(useRegister).mockReturnValue({ ...fixture,
      register: { ...fixture.register, session: null } });
    render(<PriceCheckBanner />);
    expect(screen.getByTestId('price-check-banner').textContent).toBe(PRICE_CHECK_ONLY);
  });

  it.each(['counting', 'closed'] as const)('shows when the session is %s', (status) => {
    const fixture = openRegisterFixture();
    vi.mocked(useRegister).mockReturnValue({ ...fixture,
      register: { ...fixture.register, session: { ...OPEN_SESSION, status } } });
    render(<PriceCheckBanner />);
    expect(screen.getByTestId('price-check-banner').textContent).toBe(PRICE_CHECK_ONLY);
  });

  it('renders nothing when the session is open', () => {
    vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
    render(<PriceCheckBanner />);
    expect(screen.queryByTestId('price-check-banner')).toBeNull();
  });

  it('renders nothing before the register is read', () => {
    const fixture = openRegisterFixture();
    vi.mocked(useRegister).mockReturnValue({ ...fixture, boundRegisterId: undefined,
      register: { ...fixture.register, session: null } });
    render(<PriceCheckBanner />);
    expect(screen.queryByTestId('price-check-banner')).toBeNull();
  });

  it('renders nothing while the order store opens', () => {
    const fixture = openRegisterFixture({ enabled: false });
    vi.mocked(useRegister).mockReturnValue({ ...fixture, boundRegisterId: null,
      register: { ...fixture.register, session: null } });
    render(<PriceCheckBanner />);
    expect(screen.queryByTestId('price-check-banner')).toBeNull();
  });

  it('goes away when a bound register opens a session', () => {
    const fixture = openRegisterFixture();
    vi.mocked(useRegister).mockReturnValue({ ...fixture,
      register: { ...fixture.register, session: null } });
    const { rerender } = render(<PriceCheckBanner />);
    expect(screen.getByTestId('price-check-banner').textContent).toBe(PRICE_CHECK_ONLY);
    vi.mocked(useRegister).mockReturnValue(openRegisterFixture());
    rerender(<PriceCheckBanner />);
    expect(screen.queryByTestId('price-check-banner')).toBeNull();
  });
});
