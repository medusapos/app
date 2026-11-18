import { describe, expect, it } from 'vitest';
import { storeRegisterTitle } from '../lib/store-register-title';

describe('storeRegisterTitle', () => {
  it('names the store and bound register', () => {
    expect(storeRegisterTitle('E2E Store', 'register-1', 'Register 1')).toBe('E2E Store · Register 1');
  });
  it('uses Register when the bound register name is null', () => {
    expect(storeRegisterTitle('E2E Store', 'register-1', null)).toBe('E2E Store · Register');
  });
  it('names only the store when no register is chosen', () => {
    expect(storeRegisterTitle('E2E Store', null, null)).toBe('E2E Store');
  });
  it('names only the store while the binding is unknown', () => {
    expect(storeRegisterTitle('E2E Store', undefined, null)).toBe('E2E Store');
  });
});
