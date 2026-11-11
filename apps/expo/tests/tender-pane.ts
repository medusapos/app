// Drives TallyUI 3.14.0's tender pane (@tallyui/components src/sale/tender-pane.tsx, WCPOS v2's) and reads its cart line,
// as a cashier would: method tiles, the keypad, quick-cash chips, Take, then Complete.
import { fireEvent, screen, within } from '@testing-library/react';

export const tenderPane = () => within(screen.getByTestId('tender-pane'));
/** The balance headline: "Total" before any payment, "Remaining" after. */
export const tenderBalance = () => screen.getByTestId('tender-balance').textContent;
/** The amount the next Take records (the keypad entry, pre-typed with the balance). */
export const tenderEntry = () => screen.getByTestId('tender-entry-amount').textContent;

export function pickMethod(method: 'cash' | 'external') {
  fireEvent.click(screen.getByTestId(`tender-method-${method}`));
}

/** Clear, then each digit. The keypad has no decimal key (digits shift in from the right), so "10.00" is 1, 0, 0, 0. */
export function keyIn(amount: string) {
  const keypad = within(screen.getByTestId('tender-keypad'));
  fireEvent.click(keypad.getByRole('button', { name: 'Clear' }));
  for (const digit of amount.replace(/\D/g, '')) fireEvent.click(keypad.getByRole('button', { name: digit }));
}

export function take() {
  fireEvent.click(screen.getByTestId('tender-take'));
}

/** One payment leg: the method's tile, the amount on the keypad, then Take. */
export function takeLeg(method: 'cash' | 'external', amount: string) {
  pickMethod(method);
  keyIn(amount);
  take();
}

/** The ledger's payment legs as "<method title> <amount>", e.g. "Card terminal €15.00" (each leg's status left out). */
export function tenderLegs() {
  return screen.queryAllByTestId(/^tender-leg-/).filter((row) => !/-(status|void)$/.test(row.getAttribute('data-testid')!))
    .map((row) => Array.from(row.children[0].children).slice(0, 2).map((cell) => cell.textContent).join(' '));
}

/** The cart line's cells for the line named `name`, in column order: quantity, name, unit price (when shown), total. */
export function cartLineCells(name: string) {
  return Array.from(cartLine(name).children[0].children).map((cell) => cell.textContent);
}

/**
 * The cart's item for the line named `name`: the CartLine, its discount chips, then its actions row. Found from the
 * line's own Remove button (actions root > flex-1 > button row > Remove), so a product tile of the same name never matches.
 */
export function cartLine(name: string) {
  return screen.getByRole('button', { name: `Remove ${name}` }).parentElement!.parentElement!.parentElement!.parentElement!;
}
