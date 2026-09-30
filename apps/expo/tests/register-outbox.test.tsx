// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { RegisterCommandEnvelope, ServerCapabilities } from '@tallyui/core';
import { sessionOpenCommand } from '@tallyui/pos';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeOrderStores, openOrderStore, registerCollections } from '../lib/order-store';
import { OutboxProvider, useOutboxContext } from '../lib/outbox-context';
import { useRegister } from '../lib/register-context';
import { REGISTER_ID_KEY, saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';

let sequence = 0;
let baseUrl: string;
let token: string;
let context: ReturnType<typeof useRegister>;
let outbox: ReturnType<typeof useOutboxContext>;
let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
let responseGate: Promise<void>;

function Probe() {
  context = useRegister();
  outbox = useOutboxContext();
  return null;
}
// OutboxProvider mounts the real RegisterProvider over its real order store.
const providers = () => <SessionProvider><OutboxProvider><Probe /></OutboxProvider></SessionProvider>;
const commands = () => registerCollections(outbox.orders!).commands;
const sent = () => fetchImpl.mock.calls.flatMap(([, init]) =>
  (JSON.parse(String(init?.body)).commands as RegisterCommandEnvelope[]));
const applied: typeof fetch = async (_url, init) => {
  await responseGate;
  const batch = JSON.parse(String(init?.body)).commands as RegisterCommandEnvelope[];
  return new Response(JSON.stringify({ results: batch.map((command) => ({ id: command.id, status: 'applied' })) }));
};

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  localStorage.setItem(REGISTER_ID_KEY, 'test-device');
  baseUrl = `https://register-outbox-${++sequence}.test`;
  token = `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature`;
  responseGate = Promise.resolve();
  fetchImpl = vi.fn<typeof fetch>(applied);
  vi.stubGlobal('fetch', fetchImpl);
});
afterEach(async () => {
  cleanup();
  await closeOrderStores();
  vi.unstubAllGlobals();
});

async function mount(capabilities: ServerCapabilities = { orderCreate: 3, register: 1 }) {
  saveSession(localStorage, { baseUrl, email: 'admin@store.test', token, capabilities });
  const view = render(providers());
  await waitFor(() => expect(context.boundRegisterId).toBeNull());
  return view;
}
async function open() {
  await act(async () => { await context.bind('register-1'); });
  await waitFor(() => expect(context.boundRegisterId).toBe('register-1'));
  await act(async () => { await context.register.actions.openSession({ expectedFloatMinor: null, countedFloatMinor: 10000 }); });
  await waitFor(() => expect(context.register.session?.status).toBe('open'));
  return context.register.session!.id;
}
async function expectApplied(commandId: string) {
  await waitFor(async () => {
    expect((await commands().findOne({ selector: { commandId } }).exec())?.syncStatus).toBe('applied');
    expect(context.registerOutbox.state).toMatchObject({ pending: 0, sending: false });
  });
}

it("sends a register.session.open to the store's commands endpoint when the store advertises register 1", async () => {
  let answer!: () => void;
  responseGate = new Promise((resolve) => { answer = resolve; });
  await mount();
  const sessionId = await open();
  await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
  expect(fetchImpl).toHaveBeenCalledWith(`${baseUrl}/tally/v1/commands`, expect.objectContaining({
    method: 'POST', headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
  }));
  expect(sent()).toEqual([expect.objectContaining({ type: 'register.session.open', deviceId: 'test-device',
    payload: expect.objectContaining({ sessionId, registerId: 'register-1' }) })]);
  await waitFor(() => expect(context.registerOutbox.state.pending).toBe(1));
  await act(async () => { answer(); });
  await expectApplied(sent()[0].id);
});

it('queues and sends nothing for a store without register', async () => {
  await mount({ orderCreate: 3 });
  await open();
  // Give asynchronous reconciliation and collection observers time to expose any unwanted command.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  expect(await commands().find().exec()).toHaveLength(0);
  expect(sent().filter((command) => command.type.startsWith('register.'))).toHaveLength(0);
  expect(context.registerOutbox.state).toEqual({ pending: 0, sending: false });
});

it('sends a command left pending when the app reopens', async () => {
  fetchImpl.mockRejectedValue(new TypeError('offline'));
  const first = await mount();
  const sessionId = await open();
  await waitFor(() => expect(context.registerOutbox.state).toMatchObject({ pending: 1, sending: false, lastRetryReason: 'network' }));
  const [pending] = await commands().find().exec();
  expect(pending.syncStatus).toBe('pending');
  first.unmount();
  await closeOrderStores();
  fetchImpl.mockClear().mockImplementation(applied);
  // Restore the saved session and reopen storage; no action or explicit flush triggers the send.
  render(providers());
  await waitFor(() => expect(sent()).toEqual([expect.objectContaining({ id: pending.commandId,
    type: 'register.session.open', payload: expect.objectContaining({ sessionId }) })]));
  await expectApplied(pending.commandId);
});

it('runs one register outbox per store: a re-render sends each command once', async () => {
  let answer!: () => void;
  responseGate = new Promise((resolve) => { answer = resolve; });
  const view = await mount();
  await open();
  await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
  const [{ commandId }] = await commands().find().exec();
  await act(async () => { view.rerender(providers()); });
  await act(async () => { answer(); });
  await expectApplied(commandId);
  expect(sent().filter((command) => command.id === commandId)).toHaveLength(1);
});

it('sends no waiting register command to a store that does not advertise register', async () => {
  const store = await openOrderStore(baseUrl);
  const at = new Date().toISOString();
  const command = sessionOpenCommand({ id: 'session-waiting', register_id: 'register-1', status: 'open',
    opened_at_gmt: at, counted_float_minor: 10000, store_key: baseUrl });
  await registerCollections(store.orders).commands.insert({ ...command, registerId: 'register-1', seq: 1,
    commandId: 'waiting-command', createdAt: at, updatedAt: at, syncStatus: 'pending' });

  await mount({ orderCreate: 3 });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  expect(sent().filter((entry) => entry.type.startsWith('register.'))).toHaveLength(0);
  expect((await commands().findOne(command.key).exec())?.syncStatus).toBe('pending');
});
