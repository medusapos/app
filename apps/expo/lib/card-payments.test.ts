import { defaultPaymentMethods, paymentMethodOf, type PaymentMethodDescriptor } from '@tallyui/core';
import { describe, expect, it } from 'vitest';
import { cardPaymentMode, TILL_PAYMENT_METHODS } from './card-payments';

describe('cardPaymentMode', () => {
  it("describes the till's own card method as a separate terminal with nothing paired", () => {
    expect(cardPaymentMode(TILL_PAYMENT_METHODS)).toEqual({
      method: 'Card terminal', capture: 'Separate card terminal', readers: 'None paired', manual: true,
    });
  });

  it('is null when the till offers no card method', () => {
    expect(cardPaymentMode([paymentMethodOf('cash')])).toBeNull();
  });

  it('names the provider and leaves readers to it for a driver-backed card method', () => {
    const device: PaymentMethodDescriptor = {
      ...paymentMethodOf('external'),
      capture: { mode: 'device', provider: 'Stripe Terminal', hardware: { discovery: 'server', readers: [], defaultReader: null, lockToDefault: false } },
    };
    expect(cardPaymentMode([paymentMethodOf('cash'), device])).toEqual({
      method: 'Card terminal', capture: 'Through Stripe Terminal', readers: 'Managed by the payment provider', manual: false,
    });
  });

  it("is TallyUI's default payment methods", () => {
    expect(TILL_PAYMENT_METHODS).toEqual(defaultPaymentMethods());
  });
});
