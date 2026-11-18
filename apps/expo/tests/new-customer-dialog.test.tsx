// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    onSaved: vi.fn(), onOpenChange: vi.fn(), onUnauthorized: vi.fn(),
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
    const { create, onSaved, onOpenChange, rerender } = setup();
    fill(ada.email!, 'Ada');
    let resolveCreate!: (customer: Customer) => void;
    create.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    await saveCustomer();
    expect(create).toHaveBeenCalledTimes(1);
    rerender(false);
    await act(async () => { resolveCreate(ada); });
    expect(onSaved).not.toHaveBeenCalled();
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
});
