// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEDUSA_ADMIN_PAGES, medusaAdminUrl, openMedusaAdmin, type MedusaAdminPage } from './medusa-admin';

vi.mock('expo-linking', () => ({ openURL: vi.fn().mockResolvedValue(true) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('medusaAdminUrl', () => {
  it('opens the Admin home under /app by default', () => {
    expect(medusaAdminUrl('https://store.test')).toBe('https://store.test/app');
  });

  it.each<[MedusaAdminPage, string]>([
    ['home', 'https://store.test/app'],
    ['store', 'https://store.test/app/settings/store'],
    ['regions', 'https://store.test/app/settings/regions'],
    ['taxRegions', 'https://store.test/app/settings/tax-regions'],
    ['locations', 'https://store.test/app/settings/locations'],
    ['salesChannels', 'https://store.test/app/settings/sales-channels'],
  ])('%s opens %s', (page, url) => {
    expect(medusaAdminUrl('https://store.test', page)).toBe(url);
  });

  it('has a row above for every page', () => {
    expect(Object.keys(MEDUSA_ADMIN_PAGES).sort()).toEqual(['home', 'locations', 'regions', 'salesChannels', 'store', 'taxRegions']);
  });
});

describe('openMedusaAdmin', () => {
  it('opens a new tab on web, without an opener or referrer', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    openMedusaAdmin('https://store.test/app/settings/store');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://store.test/app/settings/store', '_blank', 'noopener,noreferrer');
  });
});
