// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorUnauthorizedError, CustomerServiceError, type Customer, type CustomerPatch } from '@tallyui/core';
import { CustomerAddressDialog, CUSTOMER_GONE, CUSTOMER_LOAD_FAILED, CUSTOMER_LOADING } from '../components/customer-address-dialog';
import { NETWORK_ERROR_TEXT } from '../components/customer-editor';

const ada: Customer = { id: 'ada', name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' };
const stored = { firstName: 'Ada', address1: '1 Old St', city: 'London', postcode: 'N1 1AA', country: 'GB' };

afterEach(() => { cleanup(); });

function setup(getCustomer: (id: string) => Promise<Customer | null> = async () => ada) {
  const fakes = {
    getCustomer: vi.fn(getCustomer),
    loadAddresses: vi.fn(async () => ({ billing: stored })),
    update: vi.fn(async (_id: string, patch: CustomerPatch): Promise<Customer> => ({ ...ada, ...patch })),
    onSaved: vi.fn(), onClose: vi.fn(), onUnauthorized: vi.fn(),
  };
  render(<><CustomerAddressDialog customerId="ada" {...fakes} /><PortalHost /></>);
  return fakes;
}
const settle = () => act(async () => {});
const input = (label: string) => screen.getByLabelText(label, { exact: true }) as HTMLInputElement;
const saveCustomer = () => act(async () => { fireEvent.click(screen.getByTestId('customer-save')); });

describe('CustomerAddressDialog', () => {
  it('shows the loading text, then the editor with the fetched customer and their stored billing address', async () => {
    let resolveCustomer!: (customer: Customer | null) => void;
    const { getCustomer, loadAddresses } = setup(() => new Promise((resolve) => { resolveCustomer = resolve; }));
    const dialog = screen.getByTestId('customer-address-dialog');
    expect(within(dialog).getByText('Edit customer address')).toBeTruthy();
    expect(within(dialog).getByText(CUSTOMER_LOADING)).toBeTruthy();
    await act(async () => { resolveCustomer(ada); });
    expect(getCustomer).toHaveBeenCalledExactlyOnceWith('ada');
    expect(loadAddresses).toHaveBeenCalledExactlyOnceWith('ada');
    expect((screen.getByPlaceholderText('First name') as HTMLInputElement).value).toBe('Ada');
    expect(input('City').value).toBe('London');
    expect(screen.queryByText(CUSTOMER_LOADING)).toBeNull();
  });

  it('saves a changed billing city through update alone, then reports the customer and closes', async () => {
    const { update, onSaved, onClose } = setup();
    await settle();
    fireEvent.change(input('City'), { target: { value: 'Leeds' } });
    await saveCustomer();
    expect(update).toHaveBeenCalledExactlyOnceWith('ada', { billing: { ...stored, city: 'Leeds' } });
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({ ...ada, billing: { ...stored, city: 'Leeds' } });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes without updating or reporting when nothing changed', async () => {
    const { update, onSaved, onClose } = setup();
    await settle();
    await saveCustomer();
    expect(update).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says the customer is gone when the store has no such customer', async () => {
    setup(async () => null);
    await settle();
    expect(screen.getByText(CUSTOMER_GONE)).toBeTruthy();
    expect(screen.queryByTestId('customer-save')).toBeNull();
  });

  it('shows the load failure and reports unauthorized credentials', async () => {
    const { onUnauthorized } = setup(async () => { throw new ConnectorUnauthorizedError('HTTP 401', 401); });
    await settle();
    expect(screen.getByText(CUSTOMER_LOAD_FAILED)).toBeTruthy();
    expect(onUnauthorized).toHaveBeenCalledExactlyOnceWith();
    expect(screen.queryByTestId('customer-save')).toBeNull();
  });

  it('stays open with the network message when the update fails', async () => {
    const { update, onSaved, onClose } = setup();
    update.mockRejectedValue(new CustomerServiceError('network', 'down'));
    await settle();
    fireEvent.change(input('City'), { target: { value: 'Leeds' } });
    await saveCustomer();
    expect(update).toHaveBeenCalledTimes(1);
    expect(within(screen.getByTestId('customer-address-dialog')).getByRole('alert').textContent).toBe(NETWORK_ERROR_TEXT);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
