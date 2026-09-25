import { afterEach, describe, expect, it, vi } from 'vitest';
import { exposeE2eHook } from './e2e-debug';

describe('exposeE2eHook', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('publishes window.__medusapos<name> in an E2E debug build', () => {
    const window = {} as Record<string, unknown>;
    vi.stubGlobal('window', window);
    vi.stubEnv('EXPO_PUBLIC_E2E_DEBUG', '1');
    const hook = () => undefined;
    exposeE2eHook('Catalogue', hook);
    expect(window.__medusaposCatalogue).toBe(hook);
  });

  it('puts nothing on window without EXPO_PUBLIC_E2E_DEBUG=1', () => {
    const window = {} as Record<string, unknown>;
    vi.stubGlobal('window', window);
    vi.stubEnv('EXPO_PUBLIC_E2E_DEBUG', '');
    exposeE2eHook('Catalogue', 1);
    expect(window).toEqual({});
  });

  it('rejects a name the bundle check would not recognise', () => {
    vi.stubGlobal('window', {});
    vi.stubEnv('EXPO_PUBLIC_E2E_DEBUG', '1');
    expect(() => exposeE2eHook('__medusaposCatalogue', 1)).toThrow('medusapos-e2e-debug-hook');
  });
});
