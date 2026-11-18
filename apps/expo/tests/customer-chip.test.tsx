// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomerChip } from '../components/customer-chip';

afterEach(() => { cleanup(); });

describe('CustomerChip', () => {
  it('shows the customer name and initials in a button named for them, the label outside it', () => {
    render(<CustomerChip name="Ada Lovelace" onPress={() => {}} />);
    const chip = screen.getByRole('button', { name: 'Customer: Ada Lovelace' });
    expect(chip.textContent).toContain('Ada Lovelace');
    expect(chip.textContent).toContain('AL');
    const label = screen.getByText('Customer');
    expect(chip.contains(label)).toBe(false);
  });

  it('shows Guest with an empty circle when the sale has no customer', () => {
    render(<CustomerChip name={null} onPress={() => {}} />);
    const chip = screen.getByRole('button', { name: 'Customer: Guest' });
    expect(chip.textContent).toBe('Guest');
    expect(chip.textContent).not.toContain('?');
  });

  it('pressing the chip calls onPress once', () => {
    const onPress = vi.fn();
    render(<CustomerChip name="Ada Lovelace" onPress={onPress} />);
    fireEvent.click(screen.getByRole('button', { name: 'Customer: Ada Lovelace' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('has no address button without onAddress, for a named customer or Guest', () => {
    render(<><CustomerChip name="Ada Lovelace" onPress={() => {}} /><CustomerChip name={null} onPress={() => {}} /></>);
    expect(screen.queryByTestId('customer-address')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit customer address' })).toBeNull();
  });

  it('with onAddress, the address button sits beside the chip button in the chip row and calls only onAddress', () => {
    const onPress = vi.fn();
    const onAddress = vi.fn();
    render(<CustomerChip name="Ada Lovelace" onPress={onPress} onAddress={onAddress} />);
    const chip = screen.getByRole('button', { name: 'Customer: Ada Lovelace' });
    const address = screen.getByRole('button', { name: 'Edit customer address' });
    expect(chip.contains(address)).toBe(false);
    const row = screen.getByTestId('customer-chip-row');
    expect(row.contains(chip)).toBe(true);
    expect(row.contains(address)).toBe(true);
    fireEvent.click(address);
    expect(onAddress).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });
});
