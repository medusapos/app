import { createStorePricedDiscountCodes, type Order, type SaleDiscountCodes, type StorePricedAccepted } from '@tallyui/pos';
import { authHeaders } from './pos-connector';

// A network that never answers must not hold Apply.
export const COUPON_PREVIEW_TIMEOUT_MS: number = 15000;
export const COUPON_INCLUSIVE_DISCOUNT: string = "This coupon can't be combined with a discount on a tax-inclusive item yet.";
export const COUPON_NEEDS_ITEMS: string = 'Add an item before applying a coupon';
export const COUPON_CHECK_FAILED: string = "Couldn't check the coupon. Try again.";

export type MedusaDiscountCodesOptions = {
  baseUrl: string;
  token: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** Pure: the preview body for these codes and this order, or the refusal to show without asking the store. */
export function couponPreviewRequest(codes: readonly string[], order: Order):
  { body: { currency: string; customerId?: string; codes: string[]; lines: Array<{ lineId: string; variantId?: string;
    quantity: number; taxInclusive: boolean; netMinor: number; taxRatePpm: number }> } } | { refusal: string } {
  if (!order.lineItems.length) return { refusal: COUPON_NEEDS_ITEMS };
  if (order.lineItems.some(line => line.taxInclusive && line.discountMinor > 0)) {
    return { refusal: COUPON_INCLUSIVE_DISCOUNT };
  }
  const customerId = order.customer?.id;
  return { body: {
    currency: order.currency,
    ...(typeof customerId === 'string' && customerId.length > 0 && customerId.length <= 64 ? { customerId } : {}),
    codes: [...codes],
    lines: order.lineItems.map(line => ({
      lineId: line.id,
      ...(line.custom ? {} : { variantId: line.variantId ?? line.productId }),
      quantity: line.quantity, taxInclusive: line.taxInclusive,
      netMinor: line.unitPriceMinor * line.quantity - (line.taxInclusive ? 0 : line.discountMinor),
      taxRatePpm: line.taxLines.reduce((sum, tax) => sum + tax.ratePpm, 0),
    })),
  } };
}

export function createMedusaDiscountCodes({ baseUrl, token, fetchImpl = globalThis.fetch,
  timeoutMs = COUPON_PREVIEW_TIMEOUT_MS }: MedusaDiscountCodesOptions): SaleDiscountCodes<StorePricedAccepted> {
  return createStorePricedDiscountCodes({ async price(codes, sale) {
    const request = couponPreviewRequest(codes, sale.order);
    if ('refusal' in request) return request;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl.trim().replace(/\/+$/, '')}/tally/v1/promotions/preview`, {
        method: 'POST', headers: { ...authHeaders(token()), 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body), signal: controller.signal,
      });
      if (response.status >= 500 || response.status === 401 || response.status === 403) throw new Error(COUPON_CHECK_FAILED);
      if (!response.ok) return { refusal: COUPON_CHECK_FAILED };
      let body: unknown;
      try { body = await response.json(); }
      catch (error) {
        if (error instanceof SyntaxError) return { refusal: COUPON_CHECK_FAILED };
        throw error;
      }
      if (typeof body !== 'object' || body === null || !('coupons' in body) ||
        !Array.isArray(body.coupons) || body.coupons.length !== codes.length) return { refusal: COUPON_CHECK_FAILED };
      const coupons: unknown[] = body.coupons;
      for (const entry of coupons) {
        if (typeof entry === 'object' && entry !== null && 'storeCode' in entry) {
          return { refusal: 'message' in entry && typeof entry.message === 'string' && entry.message.length > 0
            ? entry.message : COUPON_CHECK_FAILED };
        }
      }
      const priced = new Map<string, StorePricedAccepted['coupon']>();
      for (const [index, entry] of coupons.entries()) {
        if (typeof entry !== 'object' || entry === null || !('couponId' in entry) ||
          typeof entry.couponId !== 'string' || !entry.couponId || !('lines' in entry) || !Array.isArray(entry.lines) ||
          !entry.lines.every((line: unknown) => typeof line === 'object' && line !== null &&
            'lineId' in line && typeof line.lineId === 'string' && 'amountMinor' in line &&
            typeof line.amountMinor === 'number' && Number.isSafeInteger(line.amountMinor) && line.amountMinor >= 0)) {
          return { refusal: COUPON_CHECK_FAILED };
        }
        priced.set(codes[index], { couponId: entry.couponId, lines: entry.lines });
      }
      return { priced };
    } finally { clearTimeout(timeout); }
  } });
}
