import { createMedusaAdminUserConnector, medusaAdminUserAuth } from '@tallyui/connector-medusa';
import type { TallyConnector } from '@tallyui/core';

// Product cache names (pricedCacheName) and replication identifiers derive from this; it must never change.
export const POS_CONNECTOR_ID = 'medusa';
export function createPosConnector(): TallyConnector {
  return createMedusaAdminUserConnector();
}
export function authHeaders(token: string): Record<string, string> {
  return medusaAdminUserAuth.getHeaders({ token });
}
