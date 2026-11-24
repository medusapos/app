import { createMedusaAdminUserConnector, medusaAdminUserAuth, medusaOrderFilters } from '@tallyui/connector-medusa';
import type { OrderFilterField, ServerCapabilities, TallyConnector } from '@tallyui/core';
import { emailReceipt } from './receipt-email';

// Product cache names (pricedCacheName) and replication identifiers derive from this; it must never change.
export const POS_CONNECTOR_ID = 'medusa';
export function createPosConnector(): TallyConnector {
  return { ...createMedusaAdminUserConnector(), emailReceipt };
}
// The filters listOrders honours for this store: register only from plugin contract 3 (the plugin's orders route).
export function storeOrderFilters(capabilities: ServerCapabilities | undefined): readonly OrderFilterField[] {
  return medusaOrderFilters(capabilities);
}
export function authHeaders(token: string): Record<string, string> {
  return medusaAdminUserAuth.getHeaders({ token });
}
