/**
 * Public defaults from EXPO_PUBLIC_* variables (see .env.example).
 * Expo inlines these at bundle time; nothing secret is configured here.
 */
export const storeConfig = {
  /** Only the login form's backend URL prefill. */
  defaultBaseUrl: process.env.EXPO_PUBLIC_MEDUSA_URL ?? 'http://localhost:9000',
  /** ISO 4217 code prices are shown in when a product has several. */
  currency: process.env.EXPO_PUBLIC_STORE_CURRENCY ?? 'EUR',
};
