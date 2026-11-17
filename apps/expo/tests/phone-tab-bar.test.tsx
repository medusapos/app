// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PhoneTabBar, type PhoneTab } from '../components/phone-tab-bar';

afterEach(cleanup);

it.each<PhoneTab>(['products', 'cart'])('marks only the active %s tab selected', (active) => {
  render(<PhoneTabBar active={active} itemCount={0} onSelect={vi.fn()} />);
  const tabs = within(screen.getByRole('tablist'));
  expect(tabs.getAllByRole('tab')).toHaveLength(2);
  expect(tabs.getByRole('tab', { name: 'Products' }).getAttribute('aria-selected')).toBe(String(active === 'products'));
  expect(tabs.getByRole('tab', { name: 'Cart' }).getAttribute('aria-selected')).toBe(String(active === 'cart'));
});

it.each([[0, 'Cart'], [1, 'Cart, 1 item'], [3, 'Cart, 3 items']] as const)(
  'labels the cart and badges its %i items', (itemCount, name) => {
    render(<PhoneTabBar active="products" itemCount={itemCount} onSelect={vi.fn()} />);
    expect(screen.getByRole('tab', { name })).toBeTruthy();
    if (itemCount === 0) expect(screen.queryByTestId('phone-tab-cart-count')).toBeNull();
    else expect(screen.getByTestId('phone-tab-cart-count').textContent).toBe(String(itemCount));
  },
);

it.each<PhoneTab>(['products', 'cart'])('selects either tab, including the active %s tab and an empty cart', (active) => {
  const onSelect = vi.fn();
  render(<PhoneTabBar active={active} itemCount={0} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Cart' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Products' }));
  expect(onSelect.mock.calls).toEqual([['cart'], ['products']]);
});
