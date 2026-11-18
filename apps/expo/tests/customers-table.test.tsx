// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Customer } from '@tallyui/core';
import { CustomersTable } from '../components/customers-table';

const ada: Customer = { id: 'ada', name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: '+44 1' };
const grace: Customer = { id: 'grace', name: 'Grace Hopper' };
afterEach(() => { cleanup(); });
// Input order mia, ben, zoe, cal differs from the first-name, last-name and email orders; cal has no last name.
const mia: Customer = { id: 'mia', name: 'Mia Young', firstName: 'Mia', lastName: 'Young', email: 'bee@example.com' };
const ben: Customer = { id: 'ben', name: 'Ben Abbott', firstName: 'Ben', lastName: 'Abbott', email: 'cole@example.com' };
const zoe: Customer = { id: 'zoe', name: 'Zoe Moss', firstName: 'Zoe', lastName: 'Moss', email: 'amber@example.com' };
const cal: Customer = { id: 'cal', name: 'Cal', firstName: 'Cal', email: 'dart@example.com' };
const unsorted = [mia, ben, zoe, cal];
const rowOrder = () => screen.getAllByTestId(/^customer-row-/).map((row) => row.getAttribute('data-testid')?.replace('customer-row-', ''));
const sortHeader = (field: string) => screen.getByTestId(`customers-sort-${field}`);
const ariaSort = (field: string) => sortHeader(field).closest('[aria-sort]')?.getAttribute('aria-sort');

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
    expect(within(screen.getByTestId('customer-row-ada')).queryByRole('button')).toBeNull();
  });

  it('leaves blank cells for a customer with only a name', () => {
    render(<CustomersTable customers={[grace]} />);
    for (const cell of ['first', 'last', 'email']) {
      expect(screen.getByTestId(`customer-cell-grace-${cell}`).textContent).toBe('');
    }
  });

  it('keeps the given order and shows no sort glyph before any header tap', () => {
    render(<CustomersTable customers={unsorted} />);
    expect(rowOrder()).toEqual(['mia', 'ben', 'zoe', 'cal']);
    for (const field of ['firstName', 'lastName', 'email']) {
      expect(sortHeader(field).textContent).not.toMatch(/[▲▼]/);
      expect(ariaSort(field)).toBe('none');
    }
  });

  it('sorts by last name on a Last name tap and reverses on a second tap, missing last names last', () => {
    render(<CustomersTable customers={unsorted} />);
    expect(screen.getByLabelText('Sort by Last name')).toBe(sortHeader('lastName'));
    fireEvent.click(sortHeader('lastName'));
    expect(rowOrder()).toEqual(['ben', 'zoe', 'mia', 'cal']);
    expect(sortHeader('lastName').textContent).toBe('Last name ▲');
    expect(ariaSort('lastName')).toBe('ascending');
    fireEvent.click(sortHeader('lastName'));
    expect(rowOrder()).toEqual(['mia', 'zoe', 'ben', 'cal']);
    expect(sortHeader('lastName').textContent).toBe('Last name ▼');
    expect(ariaSort('lastName')).toBe('descending');
  });

  it('sorts ascending by first name when First name is tapped after Last name', () => {
    render(<CustomersTable customers={unsorted} />);
    fireEvent.click(sortHeader('lastName'));
    fireEvent.click(sortHeader('firstName'));
    expect(rowOrder()).toEqual(['ben', 'cal', 'mia', 'zoe']);
    expect(sortHeader('firstName').textContent).toBe('First name ▲');
    expect(ariaSort('firstName')).toBe('ascending');
    expect(sortHeader('lastName').textContent).toBe('Last name');
    expect(ariaSort('lastName')).toBe('none');
    expect(sortHeader('email').textContent).toBe('Email');
  });

  it('sorts by email on an Email tap', () => {
    render(<CustomersTable customers={unsorted} />);
    expect(screen.getByLabelText('Sort by Email')).toBe(sortHeader('email'));
    expect(screen.getByLabelText('Sort by First name')).toBe(sortHeader('firstName'));
    fireEvent.click(sortHeader('email'));
    expect(rowOrder()).toEqual(['zoe', 'mia', 'ben', 'cal']);
    expect(sortHeader('email').textContent).toBe('Email ▲');
  });

  it('shows the given order again when the sorted column is hidden', () => {
    const { rerender } = render(<CustomersTable customers={unsorted} />);
    fireEvent.click(sortHeader('lastName'));
    expect(rowOrder()).toEqual(['ben', 'zoe', 'mia', 'cal']);
    rerender(<CustomersTable customers={unsorted} columns={{ avatar: true, firstName: true, lastName: false, email: true }} />);
    expect(rowOrder()).toEqual(['mia', 'ben', 'zoe', 'cal']);
    expect(screen.queryByTestId('customers-sort-lastName')).toBeNull();
  });

  it('renders nothing for no customers', () => {
    render(<CustomersTable customers={[]} />);
    expect(screen.queryByTestId('customers-table')).toBeNull();
  });
});
