import { describe, expect, it } from 'vitest';
import { DEMO_ACCOUNTS, demoTillChoice, isDemoAccount } from './demo';

describe('isDemoAccount', () => {
  it.each(DEMO_ACCOUNTS)('recognizes $email only in a demo build', ({ email }) => {
    expect(isDemoAccount(email, true)).toBe(true);
    expect(isDemoAccount(` ${email.toUpperCase()} `, true)).toBe(true);
    expect(isDemoAccount(email, false)).toBe(false);
  });

  it('does not recognize other accounts', () => {
    expect(isDemoAccount('e2e@tally.test', true)).toBe(false);
  });
});

describe('demoTillChoice', () => {
  const regions = [{ id: 'germany', name: 'Germany' }, { id: 'europe', name: 'Europe' }];
  const channels = [{ id: 'first', name: 'First channel' }];

  it('prefers Europe over the initial and first regions', () => {
    expect(demoTillChoice({ regions }, { region: 'initial' })).toEqual({ region: 'europe' });
  });

  it('falls back to the initial region, then the first region', () => {
    expect(demoTillChoice({ regions: regions.slice(0, 1) }, { region: 'initial' })).toEqual({ region: 'initial' });
    expect(demoTillChoice({ regions: regions.slice(0, 1) }, undefined)).toEqual({ region: 'germany' });
  });

  it('prefers the initial channel, then the first channel', () => {
    expect(demoTillChoice({ channels }, { channel: 'initial' })).toEqual({ channel: 'initial' });
    expect(demoTillChoice({ channels }, undefined)).toEqual({ channel: 'first' });
  });

  it('omits missing values and never supplies a country', () => {
    expect(demoTillChoice({}, undefined)).toEqual({});
    expect(demoTillChoice({ countries: ['dk'] }, { country: 'dk' })).toEqual({});
  });
});
