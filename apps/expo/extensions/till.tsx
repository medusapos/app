import { defineExtension, EXTENSION_API_VERSION, type CreateExtensionHostOptions } from '@tallyui/extensions';
import { CouponField } from '../components/coupon-field';
import { OPEN_TO_PAY } from '../components/register';

// Experimental extension for a draft PR.
export const tillExtension = defineExtension({
  id: 'medusapos.till',
  apiVersion: EXTENSION_API_VERSION,
  capabilities: ['sale.read', 'sale.coupons', 'register.read'],
  targets: { 'pos.cart.after-subtotal': {
    load: async () => ({ default: CouponField }),
  } },
  hooks: { 'checkout.tender.start': {
    tier: 'guard',
    load: async () => ({ default: (ctx) => {
      if (ctx.view.register?.value.open === false) return { refuse: OPEN_TO_PAY };
    } }),
  } },
});

export const TILL_GRANT = { 'medusapos.till': ['sale.read', 'sale.coupons', 'register.read'] } as const satisfies CreateExtensionHostOptions['grant'];
