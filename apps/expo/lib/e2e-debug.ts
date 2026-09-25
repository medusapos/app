/**
 * The only code that puts anything on `window` for E2E: `exposeE2eHook('Catalogue', v)` sets
 * `window.__medusaposCatalogue`, and the `__medusapos` prefix appears in no other app source.
 * The guard lives here, not only at call sites, because Metro does not tree-shake reliably: in a
 * production export the inlined EXPO_PUBLIC_E2E_DEBUG folds the branch away. The branch carries the
 * marker 'medusapos-e2e-debug-hook', which scripts/check-web-bundle.sh fails any web export on.
 */
export function exposeE2eHook(name: string, value: unknown): void {
  if (process.env.EXPO_PUBLIC_E2E_DEBUG === '1' && typeof window !== 'undefined') {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error(`medusapos-e2e-debug-hook: bad hook name ${name}`);
    (window as unknown as Record<string, unknown>)[`__medusapos${name}`] = value;
  }
}
