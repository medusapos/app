import { Platform } from 'react-native';

// Medusa serves its Admin under the store's base URL at this path (Medusa's default `admin.path`).
const MEDUSA_ADMIN_BASE_PATH = '/app';

// Medusa Admin (`@medusajs/dashboard`) routes, each under the Admin's `/app` base. The one place these paths live.
export const MEDUSA_ADMIN_PAGES = {
  home: '',
  store: '/settings/store',
  regions: '/settings/regions',
  taxRegions: '/settings/tax-regions',
  locations: '/settings/locations',
  salesChannels: '/settings/sales-channels',
} as const;

export type MedusaAdminPage = keyof typeof MEDUSA_ADMIN_PAGES;

/** The Medusa Admin URL of one page, for the store at `baseUrl`. */
export function medusaAdminUrl(baseUrl: string, page: MedusaAdminPage = 'home'): string {
  return `${baseUrl}${MEDUSA_ADMIN_BASE_PATH}${MEDUSA_ADMIN_PAGES[page]}`;
}

/** Opens a Medusa Admin URL: a new browser tab on web, the system browser on native. */
export function openMedusaAdmin(url: string): void {
  if (Platform.OS === 'web') window.open(url, '_blank', 'noopener,noreferrer');
  // Imported on demand, as the user sheet always did: a static import loads expo-modules-core with every screen that
  // imports this module, and that fails under vitest wherever expo-linking is not mocked.
  else void import('expo-linking').then((Linking) => Linking.openURL(url))
    .catch((error) => console.warn('Failed to open admin URL:', error));
}
