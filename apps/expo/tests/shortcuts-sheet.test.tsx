// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShortcutsSheet } from '../components/shortcuts-sheet';
import { useShortcut } from '../lib/shortcuts';

function Harness({ onOpenChange, checkout, newSale }: { onOpenChange: (open: boolean) => void; checkout: () => void; newSale: (() => void) | null }) {
  useShortcut('checkout.open', checkout);
  useShortcut('sale.new', newSale);
  return <><ShortcutsSheet open onOpenChange={onOpenChange} /><PortalHost /></>;
}
const mount = (newSale: (() => void) | null = null) => {
  const onOpenChange = vi.fn(), checkout = vi.fn();
  render(<Harness onOpenChange={onOpenChange} checkout={checkout} newSale={newSale} />);
  return { onOpenChange, checkout };
};

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ShortcutsSheet', () => {
  it('lists the five rows plus Escape, each with its key caps', () => {
    mount();
    expect(screen.getByTestId('shortcuts-sheet')).toBeTruthy();
    // The title and the help row.
    expect(screen.getAllByText('Keyboard shortcuts')).toHaveLength(2);
    const rows = Array.from(document.querySelectorAll('[data-testid^="shortcuts-row-"]')).map((row) => row.getAttribute('data-testid'));
    expect(rows).toEqual(['shortcuts-row-search.focus', 'shortcuts-row-sale.new', 'shortcuts-row-checkout.open',
      'shortcuts-row-orders.open', 'shortcuts-row-help.open', 'shortcuts-row-escape']);
    expect(screen.getByTestId('shortcuts-row-checkout.open').textContent).toMatch(/Checkout(Alt|⌥)P/);
    expect(screen.getByTestId('shortcuts-row-escape').textContent).toBe('Close a sheetEsc');
    expect(screen.getByTestId('shortcuts-sheet-close')).toBeTruthy();
  });

  it('an unavailable row is aria-disabled and pressing it runs nothing', () => {
    vi.useFakeTimers();
    const { onOpenChange, checkout } = mount(null);
    const row = screen.getByTestId('shortcuts-row-sale.new');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(row);
    act(() => { vi.runAllTimers(); });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(checkout).not.toHaveBeenCalled();
  });

  it('pressing an available row closes the sheet and runs it', () => {
    vi.useFakeTimers();
    const { onOpenChange, checkout } = mount();
    const row = screen.getByTestId('shortcuts-row-checkout.open');
    expect(row.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(row);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(checkout).not.toHaveBeenCalled();
    act(() => { vi.runAllTimers(); });
    expect(checkout).toHaveBeenCalledTimes(1);
  });
});
