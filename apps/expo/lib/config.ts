/**
 * Medusa POS store connection for this build, from EXPO_PUBLIC_* variables (see
 * .env.example). Expo inlines these at bundle time, so the API key is
 * visible to anyone with the bundle: acceptable for a localhost dev store
 * only. A real register signs in as a user instead.
 */
export const storeConfig = {
  baseUrl: process.env.EXPO_PUBLIC_MEDUSA_URL ?? 'http://localhost:9000',
  apiKey: process.env.EXPO_PUBLIC_MEDUSA_API_KEY ?? '',
  /** ISO 4217 code prices are shown in when a product has several. */
  currency: process.env.EXPO_PUBLIC_STORE_CURRENCY ?? 'EUR',
};
