import { expect, it } from 'vitest';
import { medusaConnector } from '@tallyui/connector-medusa';
import { authHeaders, posConnector } from './pos-connector';

it('declares the admin user Bearer credential type and login fields', () => {
  expect(posConnector.auth.type).toBe('Medusa admin user (Bearer JWT)');
  expect(posConnector.auth.fields.map((field) => field.key)).toEqual(['url', 'email', 'password']);
});

it('gets Bearer headers from the connector and helper', () => {
  expect(posConnector.auth.getHeaders({ token: 'jwt' })).toEqual({ Authorization: 'Bearer jwt' });
  expect(authHeaders('jwt')).toEqual({ Authorization: 'Bearer jwt' });
});

it('preserves the stock connector identity, schemas, traits, and replication', () => {
  expect(posConnector.id).toBe(medusaConnector.id);
  expect(posConnector.name).toBe(medusaConnector.name);
  expect(posConnector.schemas).toBe(medusaConnector.schemas);
  expect(posConnector.traits).toBe(medusaConnector.traits);
  expect(posConnector.replication).toBe(medusaConnector.replication);
});
