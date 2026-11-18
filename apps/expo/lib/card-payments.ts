import { defaultPaymentMethods, type PaymentMethodDescriptor } from '@tallyui/core';

// The payment methods this till offers at checkout. The Medusa connector has no `paymentMethods`,
// so it is TallyUI's default pair: Cash and Card terminal.
export const TILL_PAYMENT_METHODS: PaymentMethodDescriptor[] = defaultPaymentMethods();

/** How this till takes card payments, as Settings shows it: three display strings and whether the card method is taken manually. */
export type CardPaymentMode = { method: string; capture: string; readers: string; manual: boolean };

/** The till's card method in words, or `null` when the till offers no card method. */
export function cardPaymentMode(methods: readonly PaymentMethodDescriptor[]): CardPaymentMode | null {
  const card = methods.find((method) => method.kind === 'card');
  if (!card) return null;
  const { mode, provider, hardware } = card.capture;
  const manual = mode === 'manual';
  return {
    method: card.title,
    capture: manual ? 'Separate card terminal' : `Through ${provider ?? mode}`,
    readers: hardware === null ? 'None paired' : 'Managed by the payment provider',
    manual,
  };
}
