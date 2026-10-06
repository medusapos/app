/**
 * Sends anonymous demo opened, signed-in and sale events to ph.wcpos.com.
 * No cookie or storage writes: credentials: 'omit', an in-memory id per page load.
 * No consent banner needed, matching the marketing recorder (front desk ruling, 2026-10-05).
 */
import { storeConfig } from './config';

export type DemoEvent = 'demo_opened' | 'demo_signed_in' | 'demo_sale_completed';
export const DEMO_CAPTURE_URL = 'https://ph.wcpos.com/e/';
// Public PostHog project key shared with the marketing site.
const API_KEY = 'phc_BhTJzZ7fXMqcD4MiaUJQsQqPkEpu94yoSAthXFBWemvd';
// The public demo origin recorded with every event.
const SITE = 'demo.medusapos.com';
const visitId = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);

export function trackDemoEvent(event: DemoEvent): void {
  if (!storeConfig.analytics) return;
  try {
    void fetch(DEMO_CAPTURE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ api_key: API_KEY, event, distinct_id: visitId,
        properties: { site: SITE, $process_person_profile: false } }),
      credentials: 'omit',
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

export function withDemoSaleEvent<T>(record: (order: T) => Promise<void> | void): (order: T) => Promise<void> {
  return async (order) => {
    await record(order);
    trackDemoEvent('demo_sale_completed');
  };
}
