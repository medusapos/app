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
});
