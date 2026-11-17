import { describe, expect, it } from 'vitest';
import { COUNTRIES, countryName } from './countries';

describe('COUNTRIES', () => {
  it('lists the 249 ISO 3166-1 alpha-2 codes once each, upper case', () => {
    expect(COUNTRIES).toHaveLength(249);
    expect(new Set(COUNTRIES.map(({ code }) => code)).size).toBe(249);
    for (const { code } of COUNTRIES) expect(code).toMatch(/^[A-Z]{2}$/);
  });
  it('is sorted by name', () => {
    const names = COUNTRIES.map(({ name }) => name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
  it('looks names up by code in any case', () => {
    expect(countryName('gb')).toBe('United Kingdom');
    expect(countryName('US')).toBe('United States');
    expect(countryName('ZZ')).toBeUndefined();
  });
});
