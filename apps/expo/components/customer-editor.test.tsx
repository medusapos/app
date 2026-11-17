// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { ConnectorUnauthorizedError, CustomerServiceError, type CustomerAddress } from '@tallyui/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CustomersScreen from '../app/customers';
import { BILLING_COUNTRY_HINT, BILLING_LOAD_FAILED, BILLING_NOT_SAVED, BillingNotSavedError } from '../lib/customer-billing';
import { CustomerEditor } from './customer-editor';

const { createCustomer, updateCustomer } = vi.hoisted(() => ({ createCustomer: vi.fn(), updateCustomer: vi.fn() }));
vi.mock('expo-router', () => ({ Redirect: () => null, Stack: { Screen: () => null } }));
vi.mock('./app-frame', () => ({ FrameMenuButton: () => null }));
vi.mock('../lib/pos-connector', () => ({ authHeaders: () => ({ Authorization: 'Bearer t' }),
  createPosConnector: () => ({ id: 'medusa', searchCustomers: vi.fn(), createCustomer, updateCustomer }) }));
vi.mock('../lib/session-context', () => ({ useSession: () => ({
  session: { baseUrl: 'https://store.test', token: 't' }, reportUnauthorized: vi.fn(),
}) }));

const ada = { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' };
const stored = { firstName: 'Ada', address1: '1 Old St', city: 'London', postcode: 'N1 1AA', country: 'GB' };
const input = (label: string) => screen.getByLabelText(label, { exact: true }) as HTMLInputElement;
const change = (label: string, value: string) => fireEvent.change(input(label), { target: { value } });
const changeForm = (placeholder: string, value: string) => fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
const submit = () => act(async () => { fireEvent.click(screen.getByTestId('customer-save')); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('CustomerEditor billing', () => {
  it('sends the new billing address with trimmed names and an uppercase country', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const loadBilling = vi.fn();
    render(<CustomerEditor customer={null} save={save} onUnauthorized={vi.fn()} loadBilling={loadBilling} />);
    changeForm('email@example.com', 'nia@example.com');
    changeForm('First name', ' Nia ');
    change('Address line 1', '1 Market St');
    change('City', 'Leeds');
    change('Postal code', 'LS1 1AA');
    change('Country code', 'gb');
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ email: 'nia@example.com' }),
      { firstName: 'Nia', address1: '1 Market St', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB' });
    expect(loadBilling).not.toHaveBeenCalled();
  });
  it('omits billing for a new customer without an address', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={null} save={save} onUnauthorized={vi.fn()} />);
    changeForm('email@example.com', 'nia@example.com');
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), undefined);
  });
  it('loads once, prevents blind edits and preserves stored keys when only city changes', async () => {
    let resolve!: (address: CustomerAddress) => void;
    const loadBilling = vi.fn(() => new Promise<CustomerAddress>((done) => { resolve = done; }));
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={ada} save={save} onUnauthorized={vi.fn()} loadBilling={loadBilling} />);
    expect(input('Address line 1').readOnly).toBe(true);
    expect(input('Address line 1').value).toBe('');
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), undefined);
    await act(async () => { resolve(stored); });
    expect(input('Address line 1').value).toBe('1 Old St');
    expect(input('Address line 1').readOnly).toBe(false);
    change('City', 'Leeds');
    await submit();
    expect(save).toHaveBeenLastCalledWith(expect.any(Object), { firstName: 'Ada', address1: '1 Old St',
      city: 'Leeds', postcode: 'N1 1AA', country: 'GB' });
    expect(loadBilling).toHaveBeenCalledTimes(1);
  });
  it('omits billing when only phone changes after loading', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={ada} save={save} onUnauthorized={vi.fn()} loadBilling={async () => stored} />);
    await waitFor(() => expect(input('Address line 1').value).toBe('1 Old St'));
    changeForm('Phone number', '123');
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ phone: '123' }), undefined);
  });
  it('uses customer.billing immediately when no loader is provided', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={{ ...ada, billing: stored }} save={save} onUnauthorized={vi.fn()} />);
    expect(input('Address line 1').value).toBe('1 Old St');
    expect(input('Address line 1').readOnly).toBe(false);
    change('City', 'Leeds');
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), { ...stored, city: 'Leeds' });
  });
  it.each([new CustomerServiceError('network', 'offline'), new ConnectorUnauthorizedError('expired', 401)])(
    'locks billing after a failed load: %s', async (error) => {
      const save = vi.fn().mockResolvedValue(undefined);
      const onUnauthorized = vi.fn();
      render(<CustomerEditor customer={ada} save={save} onUnauthorized={onUnauthorized} loadBilling={async () => { throw error; }} />);
      expect(await screen.findByText(BILLING_LOAD_FAILED)).toBeTruthy();
      expect(input('Address line 1').readOnly).toBe(true);
      changeForm('Phone number', '123');
      await submit();
      expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ phone: '123' }), undefined);
      expect(onUnauthorized).toHaveBeenCalledTimes(error instanceof ConnectorUnauthorizedError ? 1 : 0);
    });
  it('limits country length and blocks an invalid two-character code', async () => {
    const save = vi.fn();
    render(<CustomerEditor customer={null} save={save} onUnauthorized={vi.fn()} />);
    changeForm('email@example.com', 'nia@example.com');
    expect(input('Country code').maxLength).toBe(2);
    change('Country code', 'G1');
    expect(screen.getByTestId('customer-save').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(BILLING_COUNTRY_HINT)).toBeTruthy();
    await submit();
    expect(save).not.toHaveBeenCalled();
  });
  it.each([new Error('offline'), new ConnectorUnauthorizedError('expired', 401)])('shows a partial save error: %s', async (cause) => {
    const onUnauthorized = vi.fn();
    const error = new BillingNotSavedError(ada, cause);
    render(<CustomerEditor customer={ada} save={vi.fn().mockRejectedValue(error)} onUnauthorized={onUnauthorized} />);
    await submit();
    expect(screen.getByText(BILLING_NOT_SAVED)).toBeTruthy();
    expect(error.customer).toBe(ada);
    expect(error.cause).toBe(cause);
    expect(onUnauthorized).toHaveBeenCalledTimes(cause instanceof ConnectorUnauthorizedError ? 1 : 0);
  });
});

it('retries only billing after a partial creation, keeps one latest row, and resets for the next editor', async () => {
  const created = { id: 'nia', name: 'Nia', email: 'nia@example.com' };
  createCustomer.mockResolvedValueOnce(created).mockResolvedValueOnce({ id: 'next', name: 'Next', email: 'next@example.com' });
  updateCustomer.mockRejectedValueOnce(new CustomerServiceError('network', 'offline'))
    .mockResolvedValueOnce({ ...created, phone: '123', billing: { city: 'Leeds' } });
  render(<><CustomersScreen /><PortalHost /></>);
  fireEvent.click(screen.getByTestId('customers-add'));
  changeForm('email@example.com', created.email);
  changeForm('First name', 'Nia');
  change('City', 'Leeds');
  await submit();
  expect(screen.getByText(BILLING_NOT_SAVED)).toBeTruthy();
  expect(screen.getAllByTestId('customer-row-nia')).toHaveLength(1);
  await submit();
  const context = { connectorId: 'medusa', baseUrl: 'https://store.test', headers: { Authorization: 'Bearer t' } };
  expect(createCustomer).toHaveBeenCalledExactlyOnceWith(context, { email: created.email, firstName: 'Nia' });
  expect(updateCustomer).toHaveBeenCalledTimes(2);
  expect(updateCustomer).toHaveBeenNthCalledWith(1, context, created.id, { billing: { firstName: 'Nia', city: 'Leeds' } });
  expect(updateCustomer).toHaveBeenNthCalledWith(2, context, created.id, { billing: { firstName: 'Nia', city: 'Leeds' } });
  expect(screen.queryByTestId('customer-editor')).toBeNull();
  expect(screen.getAllByTestId('customer-row-nia')).toHaveLength(1);
  expect(screen.getByLabelText('Nia, nia@example.com, 123')).toBeTruthy();
  fireEvent.click(screen.getByTestId('customers-add'));
  changeForm('email@example.com', 'next@example.com');
  await submit();
  expect(createCustomer).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('customer-row-next')).toBeTruthy();
});
