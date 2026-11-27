import { COUPON_LIST_PLUGIN_CONTRACT } from './plugin-contract';
import { authHeaders } from './pos-connector';
import type { Session } from './session';

export type StoreCoupon = {
  code: string; label: string | null; type: 'percentage' | 'fixed'; value: number; currency: string | null; endsAt: string | null;
};

function isCoupon(row: unknown): row is StoreCoupon {
  if (!row || typeof row !== 'object') return false;
  const coupon = row as Record<string, unknown>;
  return typeof coupon.code === 'string' && (coupon.label === null || typeof coupon.label === 'string') &&
    ((coupon.type === 'fixed' && typeof coupon.currency === 'string') || (coupon.type === 'percentage' && coupon.currency === null)) &&
    typeof coupon.value === 'number' && (coupon.endsAt === null || typeof coupon.endsAt === 'string');
}

export async function readStoreCoupons(session: Pick<Session, 'baseUrl' | 'token'>, pluginContract: number,
  currency?: string, fetchImpl = globalThis.fetch, timeoutMs = 5000): Promise<{ coupons: StoreCoupon[]; truncated: boolean } | null> {
  if (pluginContract < COUPON_LIST_PLUGIN_CONTRACT) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    const query = currency === undefined ? '' : `?currency=${encodeURIComponent(currency)}`;
    const body = await Promise.race([
      fetchImpl(`${session.baseUrl}/tally/v1/promotions${query}`, { method: 'GET', headers: authHeaders(session.token), signal: controller.signal })
        .then(response => response.ok ? response.json() : null),
      new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); }),
    ]);
    if (!body || typeof body !== 'object' || typeof body.limit !== 'number' || typeof body.truncated !== 'boolean' ||
      !Array.isArray(body.coupons)) return null;
    const coupons = body.coupons.filter(isCoupon).map(({ code, label, type, value, currency, endsAt }: StoreCoupon) =>
      ({ code, label, type, value, currency, endsAt }));
    return { coupons, truncated: body.truncated };
  } catch {
    return null;
  } finally { clearTimeout(timer); }
}
