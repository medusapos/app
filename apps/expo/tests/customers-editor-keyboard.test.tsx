// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../lib/session';
import CustomersScreen from '../app/customers';

const { searchCustomers, updateCustomer, createCustomer, sessionState } = vi.hoisted(() => ({
  searchCustomers: vi.fn(), updateCustomer: vi.fn(), createCustomer: vi.fn(),
  sessionState: { session: null as Session | null, reportUnauthorized: vi.fn() },
}));
// react-native-web's ScrollView drops keyboardShouldPersistTaps, so a pass-through wrapper records it.
vi.mock('react-native', async (importOriginal) => {
  const original = await importOriginal<typeof import('react-native')>();
  const ScrollView = (props: ComponentProps<typeof original.ScrollView>) =>
    <div data-testid="scroll-view" data-keyboard-should-persist-taps={String(props.keyboardShouldPersistTaps)}>
      <original.ScrollView {...props} />
    </div>;
  return { ...original, ScrollView };
});
vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => <span>redirect:{href}</span>,
  router: { replace: vi.fn(), push: vi.fn(), dismissTo: vi.fn() }, usePathname: () => '/customers',
  Stack: { Screen: () => null },
}));
vi.mock('../lib/pos-connector', () => ({
  createPosConnector: () => ({ id: 'medusa', searchCustomers, updateCustomer, createCustomer }),
  authHeaders: () => ({ Authorization: 'Bearer t' }),
}));
vi.mock('../lib/session-context', () => ({ useSession: () => sessionState }));

const ada = { id: 'ada', name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '+44 1' };
beforeEach(() => {
  vi.useFakeTimers();
  searchCustomers.mockReset().mockResolvedValue([]);
  sessionState.session = { baseUrl: 'https://store.test', email: 'admin@store.test', token: 't' };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

// The first scroll view inside the dialog in document order is the outermost one: the one wrapping the form.
const editorScrollTaps = () =>
  within(screen.getByTestId('customer-editor')).getAllByTestId('scroll-view')[0].getAttribute('data-keyboard-should-persist-taps');

describe('Customers editor keyboard taps', () => {
  it("the new-customer editor's scroll view keeps taps for the country matches", () => {
    render(<><CustomersScreen /><PortalHost /></>);
    fireEvent.click(screen.getByTestId('customers-add'));
    expect(within(screen.getByTestId('customer-editor')).getByRole('heading', { name: 'Add Customer' })).toBeTruthy();
    expect(editorScrollTaps()).toBe('handled');
  });

  it("the edit-customer editor's scroll view keeps taps", async () => {
    searchCustomers.mockResolvedValue([ada]);
    render(<><CustomersScreen /><PortalHost /></>);
    fireEvent.change(screen.getByTestId('customers-search'), { target: { value: 'ada' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    fireEvent.click(screen.getByTestId('customer-row-ada'));
    expect(within(screen.getByTestId('customer-editor')).getByText('Edit customer')).toBeTruthy();
    expect(editorScrollTaps()).toBe('handled');
  });
});
