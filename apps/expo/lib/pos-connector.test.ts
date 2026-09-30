import { expect, it } from 'vitest';
import { authHeaders, createPosConnector, POS_CONNECTOR_ID } from './pos-connector';

it('declares the admin user Bearer credential type and login fields', () => {
  const connector = createPosConnector();
  expect(connector.auth.type).toBe('Medusa admin user (Bearer JWT)');
  expect(connector.auth.fields.map((field) => field.key)).toEqual(['url', 'email', 'password']);
});

it('gets Bearer headers from the connector and helper', () => {
  expect(createPosConnector().auth.getHeaders({ token: 'jwt' })).toEqual({ Authorization: 'Bearer jwt' });
  expect(authHeaders('jwt')).toEqual({ Authorization: 'Bearer jwt' });
});

it('builds a connector with its own reconcile feed on every call', () => {
  const a = createPosConnector();
  const b = createPosConnector();
  expect(a).not.toBe(b);
  expect(a.replication!.products).not.toBe(b.replication!.products);
  expect(a.reconcile!.ids!.enqueue).not.toBe(b.reconcile!.ids!.enqueue);
  expect(a.schemas).toBe(b.schemas);
  expect(a.traits).toBe(b.traits);
});

it('its id is POS_CONNECTOR_ID', () => {
  expect(createPosConnector().id).toBe(POS_CONNECTOR_ID);
  expect(POS_CONNECTOR_ID).toBe('medusa');
});
