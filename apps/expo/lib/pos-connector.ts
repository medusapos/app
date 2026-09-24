import type { TallyConnector } from '@tallyui/core';
import { medusaConnector } from '@tallyui/connector-medusa';

/**
 * The POS holds a signed-in admin user's JWT (emailpass login), never a secret API key,
 * so it sends Bearer; the stock connector only models secret keys over Basic.
 * Drop this override once @tallyui/connector-medusa ships a Bearer credential type
 * (TallyUI post-MVP item 5).
 */
export const posConnector: TallyConnector = {
  ...medusaConnector,
  auth: {
    type: 'Medusa admin user (Bearer JWT)',
    fields: [
      { key: 'url', label: 'Backend URL', type: 'url', placeholder: 'https://my-medusa-backend.com', required: true },
      { key: 'email', label: 'Email', type: 'text', required: true },
      { key: 'password', label: 'Password', type: 'password', required: true },
    ],
    getHeaders: (credentials) => ({ Authorization: `Bearer ${credentials.token}` }),
  },
};
export function authHeaders(token: string): Record<string, string> {
  return posConnector.auth.getHeaders({ token });
}
