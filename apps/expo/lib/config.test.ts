import { describe, expect, it } from 'vitest';
import { isDemoMode } from './config';

describe('isDemoMode', () => {
  it.each([undefined, 'app.medusapos.com', 'localhost', 'demo.medusapos.com.evil.example'])(
    'enables an explicit demo build on %s', (hostname) => {
      expect(isDemoMode('1', hostname)).toBe(true);
    },
  );

  it('enables the demo origin without a build flag', () => {
    expect(isDemoMode(undefined, 'demo.medusapos.com')).toBe(true);
  });

  it.each([undefined, 'app.medusapos.com', 'localhost', 'demo.medusapos.com.evil.example'])(
    'does not enable demo mode on %s without a flag', (hostname) => {
      expect(isDemoMode(undefined, hostname)).toBe(false);
    },
  );

  it('does not enable demo mode for flag 0', () => {
    expect(isDemoMode('0', 'app.medusapos.com')).toBe(false);
  });
});
