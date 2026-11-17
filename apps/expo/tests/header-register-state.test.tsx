// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeaderRegisterState } from '../components/header-register-state';

afterEach(() => { cleanup(); });

describe('HeaderRegisterState', () => {
  it.each([
    ['Closed', 'Register: Closed'], ['Counting', 'Register: Counting'], ['Choose register', 'Choose register'],
  ] as const)('shows %s with the accessible name %s', (label, name) => {
    render(<HeaderRegisterState label={label} onPress={() => {}} />);
    const control = screen.getByTestId('header-register-state');
    expect(control.textContent).toBe(label);
    expect(screen.getByRole('button', { name })).toBe(control);
  });

  it('calls onPress when pressed', () => {
    const onPress = vi.fn();
    render(<HeaderRegisterState label="Closed" onPress={onPress} />);
    fireEvent.click(screen.getByTestId('header-register-state'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
