/**
 * Public defaults from EXPO_PUBLIC_* variables (see .env.example).
 * Expo inlines these at bundle time; nothing secret is configured here.
 */
// Public demo origin; app.medusapos.com is the merchant app.
export const DEMO_HOST = 'demo.medusapos.com';

export function isDemoMode(flag: string | undefined, hostname: string | undefined): boolean {
  return flag === '1' || hostname === DEMO_HOST;
}

export const storeConfig = {
  /** Demo mode on the demo origin or with EXPO_PUBLIC_DEMO=1 (e.g. e2e). */
  demo: isDemoMode(process.env.EXPO_PUBLIC_DEMO, globalThis.location?.hostname),
  /** Demo analytics (lib/demo-analytics.ts) only on the public demo origin itself, never with EXPO_PUBLIC_DEMO alone (local, e2e). */
  analytics: globalThis.location?.hostname === DEMO_HOST,
  /** Only the login form's backend URL prefill. */
  defaultBaseUrl: process.env.EXPO_PUBLIC_MEDUSA_URL ?? 'http://localhost:9000',
  /** ISO 4217 code prices are shown in when a product has several. */
  currency: process.env.EXPO_PUBLIC_STORE_CURRENCY ?? 'EUR',
};
