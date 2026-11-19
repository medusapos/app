import { useEffect, useState } from 'react';
import { authHeaders } from './pos-connector';

type AdminSession = { baseUrl: string; token: string };
// Ids per request, so a large catalogue's query string stays short.
const CHUNK = 100;

/** Product type id → value from Medusa's admin API, for the Products area's Type column. Best-effort: a failed read
 * (network, a non-OK status such as 401/403, bad JSON) returns what it has so far and never throws. */
export async function fetchProductTypes(session: AdminSession, ids: readonly string[],
  fetchImpl = globalThis.fetch): Promise<Map<string, string>> {
  const types = new Map<string, string>();
  for (let start = 0; start < ids.length; start += CHUNK) {
    const chunk = ids.slice(start, start + CHUNK);
    const query = new URLSearchParams({ fields: 'id,value', limit: String(chunk.length) });
    for (const id of chunk) query.append('id[]', id);
    try {
      const response = await fetchImpl(`${session.baseUrl}/admin/product-types?${query}`, { headers: authHeaders(session.token) });
      if (!response.ok) return types;
      const list = ((await response.json()) as { product_types?: unknown } | null)?.product_types;
      if (!Array.isArray(list)) return types;
      for (const type of list) {
        if (typeof type?.id === 'string' && typeof type.value === 'string' && type.value !== '') types.set(type.id, type.value);
      }
    } catch { return types; }
  }
  return types;
}

const EMPTY: ReadonlyMap<string, string> = new Map();

/** The types of `ids`, read while `enabled` (the Type column shows) and a session exists; empty until the read lands.
 * A change of store, token or ids reads again, and a response from before the change (or after unmount) is dropped. */
export function useProductTypes(session: AdminSession | null, ids: readonly string[], enabled: boolean): ReadonlyMap<string, string> {
  const [types, setTypes] = useState(EMPTY);
  const baseUrl = session?.baseUrl;
  const token = session?.token;
  const key = ids.join('\n');
  useEffect(() => {
    if (!enabled || baseUrl === undefined || token === undefined || key === '') return;
    let live = true;
    void fetchProductTypes({ baseUrl, token }, key.split('\n')).then((read) => { if (live) setTypes(read); });
    return () => { live = false; };
  }, [enabled, baseUrl, token, key]);
  return types;
}
