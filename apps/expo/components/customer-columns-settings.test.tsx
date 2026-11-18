// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CustomersScreen from '../app/customers';

const { searchCustomers } = vi.hoisted(() => ({ searchCustomers: vi.fn() }));
vi.mock('expo-router', () => ({ Redirect: () => null, Stack: { Screen: () => null } }));
vi.mock('./app-frame', () => ({ FrameMenuButton: () => null }));
vi.mock('../lib/pos-connector', () => ({ authHeaders: () => ({ Authorization: 'Bearer t' }),
  createPosConnector: () => ({ id: 'medusa', searchCustomers, createCustomer: vi.fn(), updateCustomer: vi.fn() }) }));
vi.mock('../lib/session-context', () => ({ useSession: () => ({
  session: { baseUrl: 'https://store.test', token: 't' }, reportUnauthorized: vi.fn(),
}) }));

const ada = { id: 'ada', name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' };
const KEY = 'medusapos.customer-columns.https://store.test';
const column = (id: string) => screen.getByTestId(`customers-settings-column-${id}`);
const heads = () => screen.getAllByRole('columnheader').map((head) => head.textContent);

// A fresh store per test; jsdom here has no localStorage of its own.
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  searchCustomers.mockResolvedValue([ada]);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

async function showAda() {
  render(<><CustomersScreen /><PortalHost /></>);
  fireEvent.change(screen.getByTestId('customers-search'), { target: { value: 'ada' } });
  await screen.findByTestId('customer-row-ada', {}, { timeout: 2000 });
  fireEvent.click(screen.getByTestId('customers-settings-button'));
}

it('shows Add customer as an icon button that opens the editor', () => {
  render(<><CustomersScreen /><PortalHost /></>);
  const add = screen.getByRole('button', { name: 'Add customer' });
  expect(add.getAttribute('data-testid')).toBe('customers-add');
  expect(add.textContent).not.toContain('Add customer');
  fireEvent.click(add);
  expect(screen.getByTestId('customer-editor')).toBeTruthy();
});

it('hides the Email column when its switch goes off, and saves the choice for the store', async () => {
  await showAda();
  expect(heads()).toContain('Email');
  fireEvent.click(column('email'));
  expect(column('email').getAttribute('aria-checked')).toBe('false');
  expect(heads()).not.toContain('Email');
  expect(screen.queryByTestId('customer-cell-ada-email')).toBeNull();
  expect(screen.getByTestId('customer-cell-ada-first')).toBeTruthy();
  expect(screen.getByTestId('customer-cell-ada-last')).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toMatchObject({ email: false });
});

it('keeps the last column on', async () => {
  await showAda();
  for (const id of ['avatar', 'firstName', 'lastName']) fireEvent.click(column(id));
  expect(column('email').getAttribute('aria-checked')).toBe('true');
  expect(column('email').hasAttribute('disabled') || column('email').getAttribute('aria-disabled') === 'true').toBe(true);
  fireEvent.click(column('email'));
  expect(column('email').getAttribute('aria-checked')).toBe('true');
  expect(heads()).toEqual(['Email', '']);
  expect(screen.getByTestId('customer-cell-ada-email')).toBeTruthy();
});

it('brings every column back on Restore Default Settings', async () => {
  await showAda();
  for (const id of ['avatar', 'firstName', 'email']) fireEvent.click(column(id));
  expect(screen.queryByTestId('customer-cell-ada-email')).toBeNull();
  fireEvent.click(screen.getByTestId('customers-settings-restore'));
  for (const id of ['avatar', 'firstName', 'lastName', 'email']) expect(column(id).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByTestId('customer-cell-ada-email')).toBeTruthy();
  expect(screen.getByTestId('customer-cell-ada-first')).toBeTruthy();
});
