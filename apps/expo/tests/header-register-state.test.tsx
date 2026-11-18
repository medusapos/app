// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { headerStateText, HeaderRegisterState, wideRegisterState } from '../components/header-register-state';

afterEach(() => { cleanup(); });

describe('HeaderRegisterState', () => {
  it.each([
    ['Closed', 'Register: Closed'], ['Counting', 'Register: Counting'], ['Choose register', 'Choose register'],
    ['Offline', 'Register: Offline'],
  ] as const)('shows %s with the accessible name %s', (label, name) => {
    render(<HeaderRegisterState label={label} onPress={() => {}} />);
    const control = screen.getByTestId('header-register-state');
    expect(control.textContent).toBe(label);
    expect(screen.getByRole('button', { name })).toBe(control);
  });

  it.each([
    ['Offline', 1, 'Offline · 1 sale to send', 'Register: Offline · 1 sale to send'],
    ['Offline', 3, 'Offline · 3 sales to send', 'Register: Offline · 3 sales to send'],
    ['Offline', 0, 'Offline', 'Register: Offline'],
    ['Closed', 2, 'Closed', 'Register: Closed'],
  ] as const)('%s with %i sales to send reads %s', (label, salesToSend, text, name) => {
    render(<HeaderRegisterState label={label} salesToSend={salesToSend} onPress={() => {}} />);
    const control = screen.getByTestId('header-register-state');
    expect(control.textContent).toBe(text);
    expect(screen.getByRole('button', { name })).toBe(control);
  });

  it('calls onPress when pressed', () => {
    const onPress = vi.fn();
    render(<HeaderRegisterState label="Closed" onPress={onPress} />);
    fireEvent.click(screen.getByTestId('header-register-state'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('headerStateText', () => {
  it.each([
    ['Offline', undefined, 'Offline'], ['Offline', 0, 'Offline'], ['Offline', 1, 'Offline · 1 sale to send'],
    ['Offline', 2, 'Offline · 2 sales to send'], ['Closed', 2, 'Closed'], ['Choose register', 5, 'Choose register'],
    ['Overdue', 1, 'Overdue'],
  ] as const)('%s with %j sales to send reads %s', (label, salesToSend, expected) => {
    expect(headerStateText(label, salesToSend)).toBe(expected);
  });
});

describe('wideRegisterState', () => {
  type Register = Parameters<typeof wideRegisterState>[2];
  it.each([
    ['undefined binding', undefined, true, {}, null],
    ['null binding', null, true, {}, 'Choose register'],
    ['bound, sessions on, no session, online', 'register-1', true, { session: null, enabled: true }, 'Closed'],
    ['session counting', 'register-1', true, { session: { status: 'counting' }, enabled: true }, 'Counting'],
    ['session closed, not closing', 'register-1', true, { session: { status: 'closed' }, enabled: true, closing: false }, 'Close not finished'],
    ['open session, offline', 'register-1', false, { session: { status: 'open' }, enabled: true }, 'Offline'],
    ['open session, online, overdue', 'register-1', true, { session: { status: 'open' }, enabled: true, overdue: true }, 'Overdue'],
    ['open session, online, not overdue', 'register-1', true, { session: { status: 'open' }, enabled: true, overdue: false }, null],
    ['counting, approval required', 'register-1', true, { session: { status: 'counting', approval_required: true }, enabled: true }, 'Approval needed'],
  ] as const)('%s reads %j', (_case, bound, online, register, expected) => {
    expect(wideRegisterState(bound, online, { session: null, overdue: false, enabled: false, closing: false, ...register } as unknown as Register))
      .toBe(expected);
  });
});
