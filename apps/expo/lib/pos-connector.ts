import { medusaAdminUserConnector, medusaAdminUserAuth } from '@tallyui/connector-medusa';

export const posConnector = medusaAdminUserConnector;
export function authHeaders(token: string): Record<string, string> {
  return medusaAdminUserAuth.getHeaders({ token });
}
