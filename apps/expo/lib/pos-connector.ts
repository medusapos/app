import { createMedusaAdminUserConnector, medusaAdminUserAuth } from '@tallyui/connector-medusa';
import type { TallyConnector } from '@tallyui/core';
import { emailReceipt } from './receipt-email';

// Product cache names (pricedCacheName) and replication identifiers derive from this; it must never change.
export const POS_CONNECTOR_ID = 'medusa';
export function createPosConnector(): TallyConnector {
  return { ...createMedusaAdminUserConnector(), emailReceipt };
}
export function authHeaders(token: string): Record<string, string> {
  return medusaAdminUserAuth.getHeaders({ token });
}
