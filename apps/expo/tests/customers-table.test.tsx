// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Customer } from '@tallyui/core';
import { CustomersTable } from '../components/customers-table';

const ada: Customer = { id: 'ada', name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '+44 1' };
const grace: Customer = { id: 'grace', name: 'Grace Hopper' };
afterEach(() => { cleanup(); });

describe('CustomersTable', () => {
  it("shows v2's header row: First name, Last name, Email", () => {
    render(<CustomersTable customers={[ada]} />);
    const text = screen.getByTestId('customers-table').textContent ?? '';
    const positions = ['First name', 'Last name', 'Email'].map((label) => text.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('puts first name, last name and email in their own cells, with the initials avatar', () => {
    render(<CustomersTable customers={[ada]} />);
    expect(screen.getByTestId('customer-cell-ada-first').textContent).toBe('Ada');
    expect(screen.getByTestId('customer-cell-ada-last').textContent).toBe('Lovelace');
    expect(screen.getByTestId('customer-cell-ada-email').textContent).toBe('ada@example.com');
    const row = screen.getByTestId('customer-row-ada');
    expect(within(row).getByText('AL')).toBeTruthy();
    expect(screen.queryByText('+44 1')).toBeNull();
    expect(screen.getByLabelText('Ada Lovelace, ada@example.com, +44 1')).toBe(row);
  });

  it('opens the customer from the row, which ends in a chevron', () => {
    const onOpen = vi.fn();
    render(<CustomersTable customers={[ada]} onOpen={onOpen} />);
    const row = screen.getByTestId('customer-row-ada');
    expect(within(row).getByText('›')).toBeTruthy();
    expect(row.getAttribute('role')).toBe('button');
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(ada);
  });

  it('without onOpen, rows have no chevron and are not buttons', () => {
    render(<CustomersTable customers={[ada]} />);
    expect(screen.queryByText('›')).toBeNull();
    expect(screen.getByTestId('customer-row-ada').getAttribute('role')).not.toBe('button');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('leaves blank cells for a customer with only a name', () => {
    render(<CustomersTable customers={[grace]} />);
    for (const cell of ['first', 'last', 'email']) {
      expect(screen.getByTestId(`customer-cell-grace-${cell}`).textContent).toBe('');
    }
  });

  it('renders nothing for no customers', () => {
    render(<CustomersTable customers={[]} />);
    expect(screen.queryByTestId('customers-table')).toBeNull();
  });
});
