import { useEffect, useState } from 'react';
import { defaultStorage } from './session';
import { loadCachedPricing } from './store-settings';

// Ids per request, so a large catalogue's query string stays short.
const CHUNK = 100;

/** Product collection id → title from Medusa's store API (the cashier role has no admin collection read), for the
 * Products area's Collections chip. Best-effort: a failed read (network, a non-OK status, bad JSON) returns what it has
 * so far and never throws. */
export async function fetchProductCollections(baseUrl: string, publishableKey: string, ids: readonly string[],
  fetchImpl = globalThis.fetch): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  for (let start = 0; start < ids.length; start += CHUNK) {
    const chunk = ids.slice(start, start + CHUNK);
    const query = new URLSearchParams({ fields: 'id,title', limit: String(chunk.length) });
    for (const id of chunk) query.append('id[]', id);
    try {
      const response = await fetchImpl(`${baseUrl}/store/collections?${query}`, { headers: { 'x-publishable-api-key': publishableKey } });
      if (!response.ok) return titles;
      const list = ((await response.json()) as { collections?: unknown } | null)?.collections;
      if (!Array.isArray(list)) return titles;
      for (const collection of list) {
        if (typeof collection?.id === 'string' && typeof collection.title === 'string' && collection.title !== '') {
          titles.set(collection.id, collection.title);
        }
      }
    } catch { return titles; }
  }
  return titles;
}

const EMPTY: ReadonlyMap<string, string> = new Map();

/** The titles of `ids`, read with the publishable key cached for the store; empty until the read lands, and without a
 * key. A change of store or ids reads again, and a response from before the change (or after unmount) is dropped. */
export function useProductCollections(baseUrl: string | undefined, ids: readonly string[]): ReadonlyMap<string, string> {
  const [titles, setTitles] = useState(EMPTY);
  const key = ids.join('\n');
  useEffect(() => {
    if (baseUrl === undefined || key === '') return;
    const publishableKey = loadCachedPricing(defaultStorage(), baseUrl)?.pricingContext?.publishable_key;
    if (!publishableKey) return;
    let live = true;
    void fetchProductCollections(baseUrl, publishableKey, key.split('\n')).then((read) => { if (live) setTitles(read); });
    return () => { live = false; };
  }, [baseUrl, key]);
  return titles;
}
