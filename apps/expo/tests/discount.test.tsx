// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatMoney, type ServerCapabilities, type StoreSettings as PricingSettings } from '@tallyui/core';
import { medusaConnector } from '@tallyui/connector-medusa';
import { createOrderBuilder, TaxProvider, taxProviderProps, toOrderCreateEnvelope, type Order, type PosOrder } from '@tallyui/pos';
import type { CartAction, CartLineProps, CartTotalProps } from '@tallyui/components';
import { Cart } from '../components/cart';
import { parseDiscount } from '../components/discount-form';
import { Receipt } from '../components/receipt';
import { catalogueEntries } from '../lib/catalogue';
import { DISCOUNTS_UNSUPPORTED, useSale } from '../lib/use-sale';

vi.mock('@tallyui/components', () => ({
  CartLine: ({ name, lineTotal }: CartLineProps) => <span>{name}: {formatMoney(lineTotal)}</span>,
  CartLineActions: ({ children, actions }: { children: ReactNode; actions: CartAction[] }) => <div>{children}
    {actions.map((action) => <button key={action.id} onClick={action.onPress}>{action.label}</button>)}</div>,
  CartTotal: ({ subtotal, taxLines, discount, total }: CartTotalProps) => <div>
    <span>Subtotal: {formatMoney(subtotal)}</span>
    {taxLines?.map((line) => <span key={line.label}>{line.label}: {formatMoney(line.amount)}</span>)}
    {discount && discount.amount > 0 ? <span>Discount: {formatMoney(discount)}</span> : null}
    <span>Total: {formatMoney(total)}</span>
  </div>,
  DiscountBadge: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }] }));
vi.mock('../lib/outbox-context', () => ({ useOutboxContext: vi.fn() }));
vi.mock('../lib/session-context', () => ({ useSession: vi.fn() }));

const pricing: PricingSettings = { currency: 'EUR', pricesIncludeTax: false, taxRatesPpm: { default: 250000 } };
const taxContext = { getTaxRatePpm: () => 250000, pricesIncludeTax: false };
const traits = medusaConnector.traits.product;
const [blue] = catalogueEntries([{ id: 'shirt', title: 'Shirt', status: 'published',
  variants: [{ id: 'blue', title: 'Blue', sku: 'BLUE', prices: [{ amount: 12.5, currency_code: 'eur' }] }] }], traits);
const money = (amount: number) => formatMoney({ amount, currency: 'EUR' });
let sale: ReturnType<typeof useSale>;
type Props = { capabilities?: ServerCapabilities; onSaleCompleted?: (order: PosOrder) => void; settings?: PricingSettings };
function SaleView({ settings = pricing, ...props }: Props) {
  sale = useSale(settings, { registerId: 'register-1', cashierRef: 'cashier', ...props });
  return <Cart sale={sale} />;
}
const Harness = (props: Props) => <TaxProvider {...taxProviderProps(props.settings ?? pricing)}><SaleView {...props} /></TaxProvider>;
const receiptSettings = { storeName: 'Shop', currency: 'EUR', location: { id: 'l', name: 'Main', countryCode: 'dk' } };
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
function discount(opener: string, type: 'Percent' | 'Amount', value: string) {
  click(opener);
  click(type);
  fireEvent.change(screen.getByRole('textbox', { name: 'Discount value' }), { target: { value } });
  click('Apply');
}
// Two blue shirts: €25.00 before tax.
function start(props: Props = { capabilities: { orderCreate: 2 } }) {
  const view = render(<Harness {...props} />);
  act(() => { sale.add(blue, traits); sale.add(blue, traits); });
  return view;
}
const totals = ({ subtotalMinor, discountMinor, taxMinor, totalMinor }: Order) => ({ subtotalMinor, discountMinor, taxMinor, totalMinor });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('parseDiscount', () => {
  it.each([
    ['percentage', '', 'EUR', 'Enter a discount.'],
    ['fixed', '  ', 'EUR', 'Enter a discount.'],
    ['percentage', 'ten', 'EUR', 'Enter a number.'],
    ['fixed', '1,50', 'EUR', { type: 'fixed', value: 150 }],
    ['fixed', '1,5', 'EUR', { type: 'fixed', value: 150 }],
    ['fixed', '1,2,3', 'EUR', 'Enter a number.'],
    // A comma or dot with 3 decimals may be a thousands separator: refused in both modes, never read as 1.
    ['percentage', '1,000', 'EUR', 'Use at most 2 decimal places.'],
    ['percentage', '1.000', 'EUR', 'Use at most 2 decimal places.'],
    ['percentage', '10,125', 'EUR', 'Use at most 2 decimal places.'],
    ['fixed', '1,000', 'EUR', 'Use at most 2 decimal places.'],
    ['percentage', '12,5', 'EUR', { type: 'percentage', value: 12.5 }],
    ['percentage', '12,50', 'EUR', { type: 'percentage', value: 12.5 }],
    ['fixed', '12,5', 'EUR', { type: 'fixed', value: 1250 }],
    ['percentage', '0', 'EUR', 'Enter a discount above 0.'],
    ['fixed', '-1', 'EUR', 'Enter a discount above 0.'],
    ['percentage', '100.5', 'EUR', 'A percentage can be at most 100.'],
    ['fixed', '1.234', 'EUR', 'Use at most 2 decimal places.'],
    ['fixed', '5.5', 'JPY', 'Use a whole amount.'],
    ['percentage', '12.5', 'EUR', { type: 'percentage', value: 12.5 }],
    ['percentage', '100', 'EUR', { type: 'percentage', value: 100 }],
    ['fixed', '0.5', 'EUR', { type: 'fixed', value: 50 }],
    ['fixed', '500', 'JPY', { type: 'fixed', value: 500 }],
  ] as const)('%s %j in %s gives %j', (type, text, currency, expected) => {
    expect(parseDiscount(type, text, currency)).toEqual(expected);
  });
});

// Several form round trips per test: past the 5 s default under a full suite on the shared host.
describe('discounts in the cart', { timeout: 20_000 }, () => {
  it('refuses a fixed amount above the line, and above what the order has left', () => {
    start();
    const plain = totals(sale.order);
    discount('Discount', 'Amount', '50');
    expect(within(screen.getByRole('group', { name: 'Discount on Shirt' })).getByRole('alert').textContent).toBe('The discount is more than the line');
    expect(totals(sale.order)).toEqual(plain);
    expect(sale.order.lineItems[0].discounts).toEqual([]);
    expect(screen.queryByRole('button', { name: /^Remove discount/ })).toBeNull();
    click('Cancel');
    discount('Order discount', 'Amount', '25');
    expect(sale.order.totalMinor).toBe(0);
    discount('Order discount', 'Amount', '1');
    expect(within(screen.getByRole('group', { name: 'Order discount' })).getByRole('alert').textContent).toBe('The discount is more than the order');
    expect(sale.order.discounts).toHaveLength(1);
  });

  // 10% then €12.00 on a €12.50 line: only €11.25 is left, so the fixed discount is refused or labelled €11.25.
  // TallyUI #129 fixed this: each stacked line discount's amountMinor is what it actually removed.
  it('refuses a stacked fixed line discount above what the earlier ones leave, or labels what comes off', () => {
    render(<Harness capabilities={{ orderCreate: 2 }} />);
    act(() => sale.add(blue, traits));
    discount('Discount', 'Percent', '10');
    discount('Discount', 'Amount', '12');
    const fixed = sale.order.lineItems[0].discounts.find((entry) => entry.type === 'fixed');
    expect(fixed === undefined || fixed.amountMinor === 1125).toBe(true);
  });

  it('labels a fixed chip with the amount that comes off, not the amount asked for', () => {
    start();
    discount('Discount', 'Amount', '20');
    expect(screen.getByText(money(2000)!)).toBeTruthy();
    act(() => sale.setQuantity(sale.order.lineItems[0].id, 1));
    expect(sale.order.lineItems[0].discounts[0]).toMatchObject({ value: 2000, amountMinor: 1250 });
    expect(screen.getByText(money(1250)!)).toBeTruthy();
    expect(screen.queryByText(money(2000)!)).toBeNull();
  });

  it('shows invalid input inline and applies nothing', () => {
    start();
    const before = sale.order;
    discount('Discount', 'Percent', '120');
    expect(screen.getByRole('alert').textContent).toBe('A percentage can be at most 100.');
    expect(sale.order).toBe(before);
    expect(screen.getByRole('group', { name: 'Discount on Shirt' })).toBeTruthy();
  });

  it('gives the builder\'s totals for a line discount plus an order discount, and removing them restores the totals', () => {
    start();
    const plain = totals(sale.order);
    discount('Discount', 'Percent', '10');
    discount('Order discount', 'Amount', '0.50');
    const expected = createOrderBuilder({ currency: 'EUR', taxContext });
    expected.addLine({ productId: 'shirt', variantId: 'blue', name: 'Shirt', unitPrice: { amount: 1250, currency: 'EUR' }, quantity: 2 });
    expected.applyLineDiscount(expected.getSnapshot().lineItems[0].id, { type: 'percentage', value: 10 });
    expected.applyOrderDiscount({ type: 'fixed', value: 50 });
    const order = expected.getSnapshot();
    expect(totals(sale.order)).toEqual(totals(order));
    expect(sale.order.lineItems[0]).toMatchObject({ discountMinor: 300, orderDiscountMinor: 50, netMinor: 2200 });
    expect(screen.getByText(`Discount: ${money(300)}`)).toBeTruthy();
    expect(screen.getByText('10%')).toBeTruthy();
    expect(screen.getByText(`Order discount −${money(50)}`)).toBeTruthy();
    expect(screen.queryByRole('group')).toBeNull();
    click('Remove discount 10%');
    click(`Remove discount ${money(50)}`);
    expect(totals(sale.order)).toEqual(plain);
    expect(screen.queryByText(/^Discount: /)).toBeNull();
  });

  // Two shirts at €12.50, 10% off the line and €0.50 off the order: €3.00 off, 25% VAT, in each display mode (ADR-063).
  it.each([
    [false, { subtotalMinor: 2500, discountMinor: 300, taxMinor: 550, totalMinor: 2750 }],
    [true, { subtotalMinor: 2500, discountMinor: 300, taxMinor: 440, totalMinor: 2200 }],
  ])('cart and receipt show order.display\'s rows, which add up (prices include tax: %s)', (inclusive, expected) => {
    render(<Harness settings={{ ...pricing, pricesIncludeTax: inclusive }} capabilities={{ orderCreate: 2 }} />);
    act(() => { sale.add(blue, traits); sale.add(blue, traits); });
    discount('Discount', 'Percent', '10');
    discount('Order discount', 'Amount', '0.50');
    const { display } = sale.order;
    expect(display).toEqual({ taxInclusive: inclusive, ...expected });
    // Exclusive: subtotal − discount + VAT = total. Inclusive: subtotal − discount = total, the VAT included.
    expect(display.subtotalMinor - display.discountMinor + (inclusive ? 0 : display.taxMinor)).toBe(display.totalMinor);
    expect(screen.getByText(`Subtotal: ${money(display.subtotalMinor)}`)).toBeTruthy();
    expect(screen.getByText(`Discount: ${money(display.discountMinor)}`)).toBeTruthy();
    expect(screen.getByText(`Total: ${money(display.totalMinor)}`)).toBeTruthy();
    if (inclusive) expect(screen.getByLabelText(`Includes VAT 25%: ${money(display.taxMinor)}`)).toBeTruthy();
    expect(screen.queryByText(`VAT 25%: ${money(display.taxMinor)}`)).toEqual(inclusive ? null : expect.anything());
    const order = sale.order;
    cleanup();
    render(<Receipt order={order} settings={receiptSettings} cashier="cashier" registerId="register-1" newSale={() => {}} />);
    const rows = [`Subtotal: ${money(display.subtotalMinor)}`, `Discount: −${money(display.discountMinor)}`,
      `${inclusive ? 'Includes ' : ''}VAT 25%: ${money(display.taxMinor)}`, `Total: ${money(display.totalMinor)}`];
    for (const label of rows) expect(screen.getByLabelText(label)).toBeTruthy();
  });

  it('at order.create 1 shows TallyUI\'s message when applying, and the order stays undiscounted', async () => {
    const completed = vi.fn();
    start({ capabilities: { orderCreate: 1 }, onSaleCompleted: completed });
    const before = sale.order;
    discount('Order discount', 'Percent', '10');
    expect(within(screen.getByRole('group', { name: 'Order discount' })).getByRole('alert').textContent).toBe(DISCOUNTS_UNSUPPORTED);
    expect(sale.order).toBe(before);
    act(() => sale.startTender('external'));
    await act(async () => { await sale.complete(); });
    expect(toOrderCreateEnvelope(completed.mock.calls[0][0], 'device').version).toBe(1);
  });

  it('finalize is the backstop when the capability drops after a discount was applied', async () => {
    const completed = vi.fn();
    const view = start({ capabilities: { orderCreate: 2 }, onSaleCompleted: completed });
    discount('Discount', 'Percent', '10');
    view.rerender(<Harness capabilities={{ orderCreate: 1 }} onSaleCompleted={completed} />);
    act(() => sale.startTender('external'));
    await act(async () => { await sale.complete(); });
    expect(sale.error).toBe(DISCOUNTS_UNSUPPORTED);
    expect(sale.stage.kind).toBe('tender');
    expect(completed).not.toHaveBeenCalled();
  });

  it('at order.create 2 records a version 2 order, and the receipt shows the discount', async () => {
    const completed = vi.fn();
    start({ capabilities: { orderCreate: 2 }, onSaleCompleted: completed });
    discount('Discount', 'Percent', '10');
    discount('Discount', 'Amount', '2.50');
    const order = sale.order;
    act(() => sale.startTender('external'));
    await act(async () => { await sale.complete(); });
    const envelope = toOrderCreateEnvelope(completed.mock.calls[0][0], 'device');
    expect(envelope.version).toBe(2);
    expect(envelope.payload).toMatchObject({ discountMinor: 500, totalMinor: order.totalMinor, lines: [expect.objectContaining({ discountMinor: 500 })] });
    cleanup();
    render(<Receipt order={order} settings={receiptSettings} cashier="cashier" registerId="register-1" newSale={() => {}} />);
    // The line's own discounts label its description; the amounts come from the snapshot.
    expect(screen.getByText(`2 × ${money(1250)} · 10% off · ${money(250)} off`)).toBeTruthy();
    expect(screen.getByLabelText(`Discount: −${money(500)}`)).toBeTruthy();
    expect(screen.getByLabelText(`Subtotal: ${money(2500)}`)).toBeTruthy();
    expect(screen.getByLabelText(`VAT 25%: ${money(order.taxMinor)}`)).toBeTruthy();
    expect(screen.getByLabelText(`Total: ${money(order.totalMinor)}`)).toBeTruthy();
    expect(screen.queryByText(/^Includes/)).toBeNull();
  });
});
