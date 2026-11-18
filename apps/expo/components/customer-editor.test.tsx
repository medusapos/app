// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { ConnectorUnauthorizedError, CustomerServiceError, type CustomerAddress } from '@tallyui/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CustomersScreen from '../app/customers';
import { BILLING_COUNTRY_HINT, BILLING_LOAD_FAILED, BILLING_NOT_SAVED, BillingNotSavedError, SHIPPING_COUNTRY_HINT } from '../lib/customer-billing';
import { CustomerEditor } from './customer-editor';

const { createCustomer, updateCustomer } = vi.hoisted(() => ({ createCustomer: vi.fn(), updateCustomer: vi.fn() }));
vi.mock('expo-router', () => ({ Redirect: () => null, Stack: { Screen: () => null } }));
vi.mock('./app-frame', () => ({ FrameMenuButton: () => null, useFrameMenu: () => undefined }));
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
const pickCountry = (query: string, code: string) => {
  change('Country', query);
  fireEvent.click(screen.getByTestId(`customer-billing-country-${code}`));
};
const matchNames = (query: string) => { change('Country', query);
  return Array.from(screen.getByTestId('customer-billing-country-matches').querySelectorAll('[role=button]'), (row) => row.textContent); };
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('CustomerEditor billing', () => {
  it('sends the new billing address with trimmed names and an uppercase country', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const loadAddresses = vi.fn();
    render(<CustomerEditor customer={null} save={save} onUnauthorized={vi.fn()} loadAddresses={loadAddresses} />);
    changeForm('email@example.com', 'nia@example.com');
    changeForm('First name', ' Nia ');
    change('Address line 1', '1 Market St');
    change('City', 'Leeds');
    change('Postal code', 'LS1 1AA');
    pickCountry('gb', 'GB');
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ email: 'nia@example.com' }),
      { firstName: 'Nia', address1: '1 Market St', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB' }, undefined);
    expect(loadAddresses).not.toHaveBeenCalled();
  });
  it('omits billing for a new customer without an address', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={null} save={save} onUnauthorized={vi.fn()} />);
    changeForm('email@example.com', 'nia@example.com');
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), undefined, undefined);
  });
  it('loads once, prevents blind edits and preserves stored keys when only city changes', async () => {
    let resolve!: (addresses: { billing?: CustomerAddress }) => void;
    const loadAddresses = vi.fn(() => new Promise<{ billing?: CustomerAddress }>((done) => { resolve = done; }));
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={ada} save={save} onUnauthorized={vi.fn()} loadAddresses={loadAddresses} />);
    expect(input('Address line 1').readOnly).toBe(true);
    expect(input('Address line 1').value).toBe('');
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), undefined, undefined);
    await act(async () => { resolve({ billing: stored }); });
    expect(input('Address line 1').value).toBe('1 Old St');
    expect(input('Address line 1').readOnly).toBe(false);
    change('City', 'Leeds');
    await submit();
    expect(save).toHaveBeenLastCalledWith(expect.any(Object), { firstName: 'Ada', address1: '1 Old St',
      city: 'Leeds', postcode: 'N1 1AA', country: 'GB' }, undefined);
    expect(loadAddresses).toHaveBeenCalledTimes(1);
  });
  it('omits billing when only phone changes after loading', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={ada} save={save} onUnauthorized={vi.fn()} loadAddresses={async () => ({ billing: stored })} />);
    await waitFor(() => expect(input('Address line 1').value).toBe('1 Old St'));
    changeForm('Phone number', '123');
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ phone: '123' }), undefined, undefined);
  });
  it('uses customer.billing immediately when no loader is provided', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={{ ...ada, billing: stored }} save={save} onUnauthorized={vi.fn()} />);
    expect(input('Address line 1').value).toBe('1 Old St');
    expect(input('Address line 1').readOnly).toBe(false);
    change('City', 'Leeds');
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), { ...stored, city: 'Leeds' }, undefined);
  });
  it('ignores an address load that fails after the editor closes', async () => {
    let reject!: (error: Error) => void;
    const loadAddresses = () => new Promise<{ billing?: CustomerAddress }>((_, fail) => { reject = fail; });
    const onUnauthorized = vi.fn();
    const { unmount } = render(<CustomerEditor customer={ada} save={vi.fn()} onUnauthorized={onUnauthorized} loadAddresses={loadAddresses} />);
    unmount();
    await act(async () => { reject(new ConnectorUnauthorizedError('expired', 401)); });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
  it.each([new CustomerServiceError('network', 'offline'), new ConnectorUnauthorizedError('expired', 401)])(
    'locks billing after a failed load: %s', async (error) => {
      const save = vi.fn().mockResolvedValue(undefined);
      const onUnauthorized = vi.fn();
      render(<CustomerEditor customer={ada} save={save} onUnauthorized={onUnauthorized} loadAddresses={async () => { throw error; }} />);
      expect(await screen.findByText(BILLING_LOAD_FAILED)).toBeTruthy();
      expect(input('Address line 1').readOnly).toBe(true);
      changeForm('Phone number', '123');
      await submit();
      expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ phone: '123' }), undefined, undefined);
      expect(onUnauthorized).toHaveBeenCalledTimes(error instanceof ConnectorUnauthorizedError ? 1 : 0);
    });
  it('blocks a stored country that is not a two-letter code until a country is picked', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={{ ...ada, billing: { ...stored, country: 'G1' } }} save={save} onUnauthorized={vi.fn()} />);
    expect(screen.getByTestId('customer-save').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(BILLING_COUNTRY_HINT)).toBeTruthy();
    await submit();
    expect(save).not.toHaveBeenCalled();
    pickCountry('united k', 'GB');
    expect(screen.queryByText(BILLING_COUNTRY_HINT)).toBeNull();
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), { ...stored, country: 'GB' }, undefined);
  });
  it('shows the stored country by name and locks the picker until billing loads', async () => {
    let resolve!: (addresses: { billing?: CustomerAddress }) => void;
    const loadAddresses = vi.fn(() => new Promise<{ billing?: CustomerAddress }>((done) => { resolve = done; }));
    render(<CustomerEditor customer={ada} save={vi.fn()} onUnauthorized={vi.fn()} loadAddresses={loadAddresses} />);
    expect(input('Country').readOnly).toBe(true);
    expect(input('Country').value).toBe('');
    expect(input('Country').placeholder).toBe('Type a country');
    change('Country', 'gb');
    expect(screen.queryByTestId('customer-billing-country-matches')).toBeNull();
    await act(async () => { resolve({ billing: stored }); });
    expect(input('Country').readOnly).toBe(false);
    expect(input('Country').value).toBe('United Kingdom');
  });
  it('saves the address without a country after clearing the country field', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={ada} save={save} onUnauthorized={vi.fn()} loadAddresses={async () => ({ billing: stored })} />);
    await waitFor(() => expect(input('Country').value).toBe('United Kingdom'));
    change('Country', '');
    expect(screen.queryByTestId('customer-billing-country-matches')).toBeNull();
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), { firstName: 'Ada', address1: '1 Old St',
      city: 'London', postcode: 'N1 1AA' }, undefined);
    expect(save.mock.calls[0][1]).not.toHaveProperty('country');
  });
  it('keeps a stored code that is missing from the list', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={{ ...ada, billing: { ...stored, country: 'XK' } }} save={save} onUnauthorized={vi.fn()} />);
    expect(input('Country').value).toBe('XK');
    change('City', 'Leeds');
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), { ...stored, city: 'Leeds', country: 'XK' }, undefined);
  });
  it('filters countries by code, name or word, ignoring accents and case', () => {
    render(<CustomerEditor customer={null} save={vi.fn()} onUnauthorized={vi.fn()} />);
    expect(matchNames('united')).toEqual(['United Arab Emirates', 'United Kingdom', 'United States', 'United States Minor Outlying Islands']);
    expect(matchNames('s')).toHaveLength(6);
    expect(matchNames('gb')[0]).toBe('United Kingdom');
    expect(matchNames('aland')).toEqual(['Åland Islands']);
    expect(matchNames('KING')).toContain('United Kingdom');
    expect(matchNames('zz')).toEqual([]);
    expect(screen.getByTestId('customer-billing-country-matches').textContent).toBe('No matching country');
  });
  it('picks the first match on Enter, and a press on a match keeps the field focused on web', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={null} save={save} onUnauthorized={vi.fn()} />);
    changeForm('email@example.com', 'nia@example.com');
    change('Country', 'fra');
    expect(fireEvent.mouseDown(screen.getByTestId('customer-billing-country-FR'))).toBe(false);
    fireEvent.keyDown(input('Country'), { key: 'Enter' });
    expect(input('Country').value).toBe('France');
    expect(screen.queryByTestId('customer-billing-country-matches')).toBeNull();
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), { country: 'FR' }, undefined);
  });
  it('restores the chosen country when the field is left without a pick', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={{ ...ada, billing: stored }} save={save} onUnauthorized={vi.fn()} />);
    change('Country', 'zzz');
    fireEvent.blur(input('Country'));
    expect(input('Country').value).toBe('United Kingdom');
    expect(screen.queryByTestId('customer-billing-country-matches')).toBeNull();
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), undefined, undefined);
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

describe('CustomerEditor shipping', () => {
  const shipping = { firstName: 'Ada', address1: '2 Dock Rd', city: 'Hull', postcode: 'HU1 1AA', country: 'GB' };
  const loaded = (addresses: { billing?: CustomerAddress; shipping?: CustomerAddress }) => async () => addresses;
  it('starts a new customer on Same as billing and sends only the billing address', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={null} save={save} onUnauthorized={vi.fn()} />);
    expect(screen.getByText('Same as billing')).toBeTruthy();
    expect(screen.queryByLabelText('Shipping address line 1')).toBeNull();
    changeForm('email@example.com', 'nia@example.com');
    changeForm('First name', 'Nia');
    change('Address line 1', '1 Market St');
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), { firstName: 'Nia', address1: '1 Market St' }, undefined);
  });
  it('sends a different shipping address alone for a new customer', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={null} save={save} onUnauthorized={vi.fn()} />);
    changeForm('email@example.com', 'nia@example.com');
    changeForm('First name', ' Nia ');
    fireEvent.click(screen.getByTestId('customer-shipping-different'));
    change('Shipping address line 1', '2 Dock Rd');
    change('Shipping city', 'Hull');
    fireEvent.change(screen.getByTestId('customer-shipping-country'), { target: { value: 'fra' } });
    fireEvent.click(screen.getByTestId('customer-shipping-country-FR'));
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), undefined,
      { firstName: 'Nia', address1: '2 Dock Rd', city: 'Hull', country: 'FR' });
  });
  it('opens a different stored shipping address in its own grid and saves a change to it', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={ada} save={save} onUnauthorized={vi.fn()} loadAddresses={loaded({ billing: stored, shipping })} />);
    await waitFor(() => expect(input('Shipping city').value).toBe('Hull'));
    expect(input('City').value).toBe('London');
    expect(input('Shipping country').value).toBe('United Kingdom');
    change('Shipping city', 'Beverley');
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), undefined, { ...shipping, city: 'Beverley' });
  });
  it('keeps a shipping address equal to billing in step with a billing change', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const sameShipping = { lastName: 'Lovelace', address1: '1 Old St', city: 'London', postcode: 'N1 1AA', country: 'GB' };
    render(<CustomerEditor customer={ada} save={save} onUnauthorized={vi.fn()}
      loadAddresses={loaded({ billing: stored, shipping: sameShipping })} />);
    await waitFor(() => expect(input('City').value).toBe('London'));
    expect(screen.getByText('Same as billing')).toBeTruthy();
    expect(screen.queryByLabelText('Shipping city')).toBeNull();
    change('City', 'Leeds');
    await submit();
    const newBilling = { ...stored, city: 'Leeds' };
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), newBilling, newBilling);
  });
  it('sends the stored billing as shipping after Same as billing is pressed', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={ada} save={save} onUnauthorized={vi.fn()} loadAddresses={loaded({ billing: stored, shipping })} />);
    await waitFor(() => expect(input('Shipping city').value).toBe('Hull'));
    fireEvent.click(screen.getByTestId('customer-shipping-same'));
    expect(screen.queryByLabelText('Shipping city')).toBeNull();
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), undefined, stored);
  });
  it('leaves shipping out when none is stored and billing changes', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={ada} save={save} onUnauthorized={vi.fn()} loadAddresses={loaded({ billing: stored })} />);
    await waitFor(() => expect(input('City').value).toBe('London'));
    expect(screen.getByText('Same as billing')).toBeTruthy();
    change('City', 'Leeds');
    await submit();
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), { ...stored, city: 'Leeds' }, undefined);
  });
  it('blocks a stored shipping country that is not a two-letter code', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<CustomerEditor customer={ada} save={save} onUnauthorized={vi.fn()}
      loadAddresses={loaded({ billing: stored, shipping: { ...shipping, country: 'GBR' } })} />);
    expect(await screen.findByText(SHIPPING_COUNTRY_HINT)).toBeTruthy();
    expect(screen.queryByText(BILLING_COUNTRY_HINT)).toBeNull();
    expect(screen.getByTestId('customer-save').getAttribute('aria-disabled')).toBe('true');
    await submit();
    expect(save).not.toHaveBeenCalled();
  });
  it('creates a customer and saves only a different shipping address', async () => {
    const created = { id: 'nia', name: 'Nia', firstName: 'Nia', email: 'nia@example.com' };
    createCustomer.mockResolvedValueOnce(created);
    updateCustomer.mockResolvedValueOnce({ ...created, shipping: { firstName: 'Nia', city: 'York' } });
    render(<><CustomersScreen /><PortalHost /></>);
    fireEvent.click(screen.getByTestId('customers-add'));
    changeForm('email@example.com', created.email);
    changeForm('First name', 'Nia');
    fireEvent.click(screen.getByTestId('customer-shipping-different'));
    change('Shipping city', 'York');
    await submit();
    const context = { connectorId: 'medusa', baseUrl: 'https://store.test', headers: { Authorization: 'Bearer t' } };
    expect(updateCustomer).toHaveBeenCalledExactlyOnceWith(context, created.id, { shipping: { firstName: 'Nia', city: 'York' } });
    expect(screen.queryByTestId('customer-editor')).toBeNull();
  });
});

it('retries only billing after a partial creation, keeps one latest row, and resets for the next editor', async () => {
  const created = { id: 'nia', name: 'Nia', firstName: 'Nia', email: 'nia@example.com' };
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

it('saves corrected customer fields with billing when retrying a partial creation', async () => {
  const created = { id: 'nia', name: 'Nia', firstName: 'Nia', email: 'nia@example.com' };
  createCustomer.mockResolvedValueOnce(created);
  updateCustomer.mockRejectedValueOnce(new CustomerServiceError('network', 'offline'))
    .mockResolvedValueOnce({ ...created, name: 'Nina', firstName: 'Nina', phone: '555', billing: { firstName: 'Nina', city: 'Leeds' } });
  render(<><CustomersScreen /><PortalHost /></>);
  fireEvent.click(screen.getByTestId('customers-add'));
  changeForm('email@example.com', created.email);
  changeForm('First name', 'Nia');
  change('City', 'Leeds');
  await submit();
  expect(screen.getByText(BILLING_NOT_SAVED)).toBeTruthy();
  changeForm('First name', 'Nina');
  changeForm('Phone number', '555');
  await submit();
  const context = { connectorId: 'medusa', baseUrl: 'https://store.test', headers: { Authorization: 'Bearer t' } };
  expect(createCustomer).toHaveBeenCalledExactlyOnceWith(context, { email: created.email, firstName: 'Nia' });
  expect(updateCustomer).toHaveBeenCalledTimes(2);
  expect(updateCustomer).toHaveBeenNthCalledWith(2, context, 'nia', {
    firstName: 'Nina', phone: '555', billing: { firstName: 'Nina', city: 'Leeds' },
  });
});
