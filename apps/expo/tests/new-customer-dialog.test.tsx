// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Customer, CustomerInput, CustomerPatch } from '@tallyui/core';
import { NewCustomerDialog } from '../components/new-customer-dialog';

const ada: Customer = { id: 'ada', name: 'Ada', firstName: 'Ada', email: 'ada@example.com' };
const nia: Customer = { id: 'nia', name: 'Nia', firstName: 'Nia', email: 'nia@example.com' };

afterEach(() => { cleanup(); });

function setup() {
  const fakes = {
    create: vi.fn(async (_input: CustomerInput): Promise<Customer> => nia),
    update: vi.fn(async (id: string, patch: CustomerPatch): Promise<Customer> => ({ ...ada, id, ...patch })),
    onSaved: vi.fn(), onAdded: vi.fn(), onOpenChange: vi.fn(), onUnauthorized: vi.fn(),
  };
  const view = render(<><NewCustomerDialog open {...fakes} /><PortalHost /></>);
  const rerender = (open: boolean) => view.rerender(<><NewCustomerDialog open={open} {...fakes} /><PortalHost /></>);
  return { ...fakes, rerender };
}
function fill(email: string, firstName: string) {
  fireEvent.change(screen.getByPlaceholderText('email@example.com'), { target: { value: email } });
  fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: firstName } });
}
const saveCustomer = () => act(async () => { fireEvent.click(screen.getByTestId('customer-save')); });

describe('NewCustomerDialog', () => {
  it('a save that settles after the dialog closed reports nothing', async () => {
    const { create, onSaved, onAdded, onOpenChange, rerender } = setup();
    fill(ada.email!, 'Ada');
    let resolveCreate!: (customer: Customer) => void;
    create.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    await saveCustomer();
    expect(create).toHaveBeenCalledTimes(1);
    rerender(false);
    await act(async () => { resolveCreate(ada); });
    expect(onSaved).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('a late save does not leak its customer into the next opening', async () => {
    const { create, update, onSaved, onOpenChange, rerender } = setup();
    fill(ada.email!, 'Ada');
    let resolveCreate!: (customer: Customer) => void;
    create.mockReturnValueOnce(new Promise((resolve) => { resolveCreate = resolve; }));
    await saveCustomer();
    rerender(false);
    rerender(true);
    await act(async () => { resolveCreate(ada); });
    fill(nia.email!, 'Nia');
    await saveCustomer();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenLastCalledWith({ email: nia.email, firstName: 'Nia' });
    expect(update).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(nia);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('reads v2\'s "Add Customer" in its title and on its save button', () => {
    setup();
    const dialog = screen.getByTestId('new-customer-dialog');
    expect(within(dialog).getByRole('heading', { name: 'Add Customer' })).toBeTruthy();
    expect(screen.getByTestId('customer-save').textContent).toBe('Add Customer');
    expect(screen.queryByText('Save customer')).toBeNull();
  });

  it('starts with name, email and phone, the addresses behind their add buttons', () => {
    setup();
    expect(screen.getByText('Addresses and other optional details')).toBeTruthy();
    expect(screen.getByTestId('customer-add-billing').textContent).toContain('Billing Address');
    expect(screen.getByTestId('customer-add-shipping').textContent).toContain('Shipping Address');
    expect(screen.queryByLabelText('Address line 1')).toBeNull();
    fireEvent.click(screen.getByTestId('customer-add-billing'));
    expect(screen.getByLabelText('Address line 1')).toBeTruthy();
  });

  it('reports the final customer to onAdded once, after its billing address is saved', async () => {
    const { create, update, onSaved, onAdded, onOpenChange } = setup();
    const billed: Customer = { ...nia, billing: { city: 'Leeds' } };
    update.mockResolvedValueOnce(billed);
    fill(nia.email!, 'Nia');
    fireEvent.click(screen.getByTestId('customer-add-billing'));
    const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
    change('Address line 1', '1 Market St');
    change('City', 'Leeds');
    change('Postal code', 'LS1 1AA');
    change('Country', 'gb');
    fireEvent.click(screen.getByTestId('customer-billing-country-GB'));
    await saveCustomer();
    expect(create).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledExactlyOnceWith(nia.id,
      { billing: { firstName: 'Nia', address1: '1 Market St', city: 'Leeds', postcode: 'LS1 1AA', country: 'GB' } });
    expect(onSaved).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenLastCalledWith(billed);
    expect(onAdded).toHaveBeenCalledExactlyOnceWith(billed);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });
});
