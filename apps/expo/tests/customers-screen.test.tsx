// @vitest-environment jsdom
// @ts-expect-error no @types/react-dom in this Expo/React Native app
import { createPortal } from 'react-dom';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorUnauthorizedError, CustomerServiceError, type Customer } from '@tallyui/core';
import type { Session } from '../lib/session';
import CustomersScreen, { NETWORK_ERROR_TEXT, NO_MATCH_TEXT, SEARCH_HINT, SEARCHING_TEXT } from '../app/customers';
import { AppFrame, useFrameAccountPublisher } from '../components/app-frame';
import { setWindowWidth } from './window-width';

const { searchCustomers, updateCustomer, createCustomer, sessionState } = vi.hoisted(() => ({
  searchCustomers: vi.fn(), updateCustomer: vi.fn(), createCustomer: vi.fn(),
  sessionState: { session: null as Session | null, reportUnauthorized: vi.fn() },
}));
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn(), dismissTo: vi.fn() }, usePathname: () => '/customers',
  Stack: { Screen: ({ options }: { options: { title?: string; headerShown?: boolean; headerLeft?: () => ReactNode; headerRight?: () => ReactNode } }) =>
    <><div data-testid="header-left" data-header-shown={String(options.headerShown)} data-title={options.title}>
      {options.headerLeft?.()}</div>
      {/* The stack draws headerRight only when the header shows, outside the screen's main landmark. */}
      {createPortal(<div data-testid="header-right">{options.headerShown && options.headerRight?.()}</div>, document.body)}</> },
}));

function AccountPublisher({ open }: { open: () => void }) {
  useFrameAccountPublisher({ displayName: 'Dana Cole', initials: 'DC', open });
  return null;
}
vi.mock('../lib/pos-connector', () => ({
  createPosConnector: () => ({ id: 'medusa', searchCustomers, updateCustomer, createCustomer }),
  authHeaders: () => ({ Authorization: 'Bearer t' }),
}));
vi.mock('../lib/session-context', () => ({ useSession: () => sessionState }));

const ada = { id: 'ada', name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '+44 1' };
const context = { connectorId: 'medusa', baseUrl: 'https://store.test', headers: { Authorization: 'Bearer t' } };
beforeEach(() => {
  vi.useFakeTimers();
  searchCustomers.mockReset().mockResolvedValue([]);
  updateCustomer.mockReset().mockImplementation(async (_context, _id, patch) => ({ ...ada, ...patch }));
  createCustomer.mockReset().mockResolvedValue({ id: 'nia', name: 'Nia', firstName: 'Nia', email: 'new@example.com' });
  sessionState.session = { baseUrl: 'https://store.test', email: 'admin@store.test', token: 't' };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

const typeQuery = (value: string) => fireEvent.change(screen.getByTestId('customers-search'), { target: { value } });
const debounce = () => act(async () => { await vi.advanceTimersByTimeAsync(250); });
const changeField = (placeholder: string, value: string) => fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
const saveCustomer = () => act(async () => { fireEvent.click(screen.getByTestId('customer-save')); });
async function editAda() {
  searchCustomers.mockResolvedValue([ada]);
  render(<><CustomersScreen /><PortalHost /></>);
  typeQuery('ada');
  await debounce();
  fireEvent.click(screen.getByTestId('customer-row-ada'));
}

describe('CustomersScreen', () => {
  it('opens Ada, saves only the changed phone and replaces the row', async () => {
    await editAda();
    expect(within(screen.getByTestId('customer-editor')).getByText('Edit customer')).toBeTruthy();
    for (const [placeholder, value] of [['First name', 'Ada'], ['Last name', 'Lovelace'],
      ['email@example.com', 'ada@example.com'], ['Phone number', '+44 1']]) {
      expect((screen.getByPlaceholderText(placeholder) as HTMLInputElement).value).toBe(value);
    }
    expect(screen.queryByPlaceholderText('Street address')).toBeNull();
    changeField('Phone number', '+44 2');
    await saveCustomer();
    expect(updateCustomer).toHaveBeenCalledExactlyOnceWith(context, 'ada', { phone: '+44 2' });
    expect(screen.queryByTestId('customer-editor')).toBeNull();
    expect(screen.getByLabelText('Ada Lovelace, ada@example.com, +44 2')).toBeTruthy();
  });

  it('closes without updating when nothing changed', async () => {
    await editAda();
    await saveCustomer();
    expect(updateCustomer).not.toHaveBeenCalled();
    expect(screen.queryByTestId('customer-editor')).toBeNull();
  });

  it('sends an empty phone to clear it', async () => {
    await editAda();
    changeField('Phone number', '');
    await saveCustomer();
    expect(updateCustomer).toHaveBeenCalledExactlyOnceWith(context, 'ada', { phone: '' });
  });

  it('keeps the editor and typed values on an invalid update', async () => {
    updateCustomer.mockRejectedValue(new CustomerServiceError('invalid', 'Email already in use'));
    await editAda();
    changeField('email@example.com', 'taken@example.com');
    await saveCustomer();
    expect(within(screen.getByTestId('customer-editor')).getByRole('alert').textContent).toBe('Email already in use');
    expect((screen.getByPlaceholderText('email@example.com') as HTMLInputElement).value).toBe('taken@example.com');
  });

  it('reports unauthorized updates to the session', async () => {
    updateCustomer.mockRejectedValue(new ConnectorUnauthorizedError('expired', 401));
    await editAda();
    changeField('Phone number', '+44 2');
    await saveCustomer();
    expect(sessionState.reportUnauthorized).toHaveBeenCalledExactlyOnceWith();
  });

  it('adds a customer with only the supplied fields and shows the new row', async () => {
    render(<><CustomersScreen /><PortalHost /></>);
    fireEvent.click(screen.getByTestId('customers-add'));
    expect(within(screen.getByTestId('customer-editor')).getByText('New customer')).toBeTruthy();
    expect(screen.getByTestId('customer-save').getAttribute('aria-disabled')).toBe('true');
    changeField('email@example.com', 'new@example.com');
    changeField('First name', 'Nia');
    await saveCustomer();
    expect(createCustomer).toHaveBeenCalledExactlyOnceWith(context, { email: 'new@example.com', firstName: 'Nia' });
    expect(screen.queryByTestId('customer-editor')).toBeNull();
    expect(screen.getByLabelText('Nia, new@example.com')).toBeTruthy();
  });

  it('redirects to /login without a session', () => {
    sessionState.session = null;
    render(<CustomersScreen />);
    expect(screen.getByText('redirect:/login')).toBeTruthy();
  });

  it('shows the hint for empty or blank queries without searching', async () => {
    render(<CustomersScreen />);
    expect(screen.getByText(SEARCH_HINT)).toBeTruthy();
    await debounce();
    typeQuery('   ');
    await debounce();
    expect(screen.getByText(SEARCH_HINT)).toBeTruthy();
    expect(searchCustomers).not.toHaveBeenCalled();
  });

  it('debounces ada, searches the store and shows the labelled row with initials', async () => {
    searchCustomers.mockResolvedValue([ada]);
    render(<CustomersScreen />);
    typeQuery('a');
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    typeQuery('ada');
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(searchCustomers).not.toHaveBeenCalled();
    expect(screen.getByText(SEARCHING_TEXT)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(searchCustomers).toHaveBeenCalledExactlyOnceWith({ connectorId: 'medusa', baseUrl: 'https://store.test',
      headers: { Authorization: 'Bearer t' } }, 'ada', { limit: 50 });
    const row = screen.getByLabelText('Ada Lovelace, ada@example.com, +44 1');
    expect(row).toBe(screen.getByTestId('customer-row-ada'));
    expect(within(row).getByText('AL')).toBeTruthy();
    expect(within(screen.getByTestId('customers-table')).getByTestId('customer-row-ada')).toBe(row);
    expect(screen.getByTestId('customer-cell-ada-email').textContent).toBe('ada@example.com');
    typeQuery('');
    expect(screen.queryByTestId('customer-row-ada')).toBeNull();
    expect(screen.getByText(SEARCH_HINT)).toBeTruthy();
  });

  it('shows the no-match text with the query', async () => {
    render(<CustomersScreen />);
    typeQuery('nobody');
    await debounce();
    expect(screen.getByText(NO_MATCH_TEXT('nobody'))).toBeTruthy();
  });

  it('shows a network failure as an alert', async () => {
    searchCustomers.mockRejectedValue(new CustomerServiceError('network', 'offline'));
    render(<CustomersScreen />);
    typeQuery('ada');
    await debounce();
    expect(screen.getByRole('alert').textContent).toBe(NETWORK_ERROR_TEXT);
  });

  it('reports unauthorized credentials to the session', async () => {
    searchCustomers.mockRejectedValue(new ConnectorUnauthorizedError('expired', 401));
    render(<CustomersScreen />);
    typeQuery('ada');
    await debounce();
    expect(sessionState.reportUnauthorized).toHaveBeenCalledExactlyOnceWith();
  });

  it('ignores a slow first answer after the second query has answered', async () => {
    let resolveFirst!: (customers: Customer[]) => void;
    searchCustomers.mockReturnValueOnce(new Promise<Customer[]>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce([{ id: 'grace', name: 'Grace Hopper' }]);
    render(<CustomersScreen />);
    typeQuery('ada');
    await debounce();
    typeQuery('grace');
    await debounce();
    expect(screen.getByTestId('customer-row-grace')).toBeTruthy();
    await act(async () => { resolveFirst([ada]); });
    expect(screen.queryByTestId('customer-row-ada')).toBeNull();
    expect(screen.getAllByTestId(/^customer-row-/)).toEqual([screen.getByTestId('customer-row-grace')]);
  });
});

describe('the header', () => {
  it('on a wide window there is no title bar; the main landmark is named Customers', () => {
    setWindowWidth(1440, 900);
    render(<AppFrame signedIn><CustomersScreen /></AppFrame>);
    const header = screen.getByTestId('header-left');
    expect(header.dataset.headerShown).toBe('false');
    expect(header.dataset.title).toBe('Customers');
    expect(screen.queryByTestId('frame-menu')).toBeNull();
    const main = screen.getByRole('main', { name: 'Customers' });
    for (const control of [screen.getByTestId('customers-search'), screen.getByTestId('customers-add'),
      screen.getByRole('button', { name: 'Customer settings' })]) expect(main.contains(control)).toBe(true);
  });

  it('on a phone the header stays, with the frame\'s Menu', () => {
    setWindowWidth(390, 844);
    render(<AppFrame signedIn><CustomersScreen /></AppFrame>);
    const header = screen.getByTestId('header-left');
    expect(header.dataset.headerShown).toBe('true');
    expect(header.contains(screen.getByTestId('frame-menu'))).toBe(true);
  });
  it('the account avatar ends the search row on a wide window and is the header\'s right button on a phone (row 14a)', () => {
    const open = vi.fn();
    const mountFramed = () => render(<AppFrame signedIn><AccountPublisher open={open} /><CustomersScreen /></AppFrame>);
    setWindowWidth(1440, 900);
    const { unmount } = mountFramed();
    const avatar = screen.getByTestId('area-user-menu');
    expect(screen.getByRole('main', { name: 'Customers' }).contains(avatar)).toBe(true);
    expect(avatar.parentElement!.contains(screen.getByTestId('customers-search'))).toBe(true);
    expect(avatar.parentElement!.lastElementChild).toBe(avatar);
    fireEvent.click(avatar);
    expect(open).toHaveBeenCalledOnce();
    unmount();
    setWindowWidth(390, 844);
    mountFramed();
    const phoneAvatar = screen.getByTestId('area-user-menu');
    expect(screen.getByRole('main', { name: 'Customers' }).contains(phoneAvatar)).toBe(false);
    expect(screen.getByTestId('header-right').contains(phoneAvatar)).toBe(true);
  });

});
