// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { RegisterCommandEnvelope, ServerCapabilities } from '@tallyui/core';
import { sessionOpenCommand } from '@tallyui/pos';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeOrderStores, openOrderStore, registerCollections } from '../lib/order-store';
import { OutboxProvider, useOutboxContext } from '../lib/outbox-context';
import { getDeviceName, useRegister } from '../lib/register-context';
import { NO_POS_ACCESS_MESSAGE, REGISTER_ID_KEY, saveSession } from '../lib/session';
import { SessionProvider, useSession } from '../lib/session-context';

let sequence = 0;
let baseUrl: string;
let token: string;
let context: ReturnType<typeof useRegister>;
let outbox: ReturnType<typeof useOutboxContext>;
let session: ReturnType<typeof useSession>;
let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
let responseGate: Promise<void>;

function Probe() {
  context = useRegister();
  outbox = useOutboxContext();
  session = useSession();
  return null;
}
// OutboxProvider mounts the real RegisterProvider over its real order store.
const providers = () => <SessionProvider><OutboxProvider><Probe /></OutboxProvider></SessionProvider>;
const commands = () => registerCollections(outbox.orders!).commands;
const commandCalls = () => fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/tally/v1/commands'));
const sent = () => commandCalls().flatMap(([, init]) =>
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

it('signs out with the no-POS-access notice when the store refuses a register command with 403', async () => {
  await mount();
  fetchImpl.mockImplementation(async (url, init) => {
    if (new URL(String(url)).pathname === '/tally/v1/commands' && init?.method === 'POST') {
      return new Response(JSON.stringify({ type: 'forbidden', message: 'Forbidden' }), { status: 403 });
    }
    return applied(url, init);
  });
  await act(async () => { await context.bind('register-1'); });
  await waitFor(() => expect(context.boundRegisterId).toBe('register-1'));
  try {
    await act(async () => { await context.register.actions.openSession({ expectedFloatMinor: null, countedFloatMinor: 10000 }); });
  } catch {}
  await waitFor(() => {
    expect(session.session).toBeNull();
    expect(session.signOutNotice).toBe(NO_POS_ACCESS_MESSAGE);
  });
});

it('adopts a refused v2 open and unblocks later commands after choosing another register', async () => {
  fetchImpl.mockImplementationOnce(async (_url, init) => {
    const batch = JSON.parse(String(init?.body)).commands as RegisterCommandEnvelope[];
    return new Response(JSON.stringify({ results: batch.map(({ id }) => ({ id, status: 'rejected',
      error: { code: 'register_session_already_open', message: 'Already open',
        data: { sessionId: 'other-session', openedBy: 'other@store.test', deviceName: 'Counter till', status: 'open' } },
    })) }));
  });
  await mount({ orderCreate: 3, register: 2 });
  await act(async () => { await context.bind('register-1'); });
  await waitFor(() => expect(context.boundRegisterId).toBe('register-1'));
  await act(async () => { await context.register.actions.openSession({ expectedFloatMinor: null, countedFloatMinor: 10000 }); });
  await waitFor(() => {
    expect(context.register.session?.status).toBe('conflict');
    expect(context.register.conflict).toMatchObject({ sessionId: 'other-session', openedBy: 'other@store.test',
      deviceName: 'Counter till', takingOver: false });
  });
  const sessionId = context.register.session!.id;
  expect(sent()[0]).toMatchObject({ type: 'register.session.open', version: 2,
    payload: { sessionId, deviceName: getDeviceName() } });
  await act(async () => { await context.register.actions.chooseAnotherRegister(); });
  await waitFor(() => {
    expect(context.register.session).toBeNull();
    expect(context.registerOutbox.state.pending).toBe(0);
  });
  expect((await registerCollections(outbox.orders!).sessions.findOne(sessionId).exec())?.status).toBe('abandoned');
  await act(async () => { await context.unbind(); });
  await waitFor(() => expect(context.boundRegisterId).toBeNull());
  const freshId = await open();
  await waitFor(() => expect(sent()).toHaveLength(2));
  expect(sent()[1]).toMatchObject({ type: 'register.session.open', payload: { sessionId: freshId } });
  await expectApplied(sent()[1].id);
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

it('a session token change neither restarts the register outbox nor keeps the old token', async () => {
  let answer!: () => void;
  responseGate = new Promise((resolve) => { answer = resolve; });
  const renewed = `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400, renewed: true }))}.signature`;
  // The sign-in again: Medusa's emailpass login, its capabilities read (register 1 still) and the cashier's profile.
  fetchImpl.mockImplementation(async (url, init) => {
    const { pathname } = new URL(String(url));
    if (pathname === '/auth/user/emailpass') return new Response(JSON.stringify({ token: renewed }));
    if (pathname === '/tally/v1/info') return new Response(JSON.stringify({ contracts: { 'order.create': [3], register: [1] } }));
    if (pathname === '/admin/users/me') return new Response('{}', { status: 404 });
    return applied(url, init);
  });
  await mount();
  await open();
  await waitFor(() => expect(sent()).toHaveLength(1));
  const [opened] = sent();
  await act(async () => { await session.signIn(baseUrl, 'admin@store.test', 'password'); });
  expect(session.session?.token).toBe(renewed);
  const afterSignIn = commandCalls().length;
  await act(async () => { answer(); });
  await expectApplied(opened.id);
  await act(async () => {
    await context.register.actions.recordMovement({ type: 'paid_in', amountMinor: 500, reason: 'Change top-up' });
  });
  await waitFor(() => expect(sent().filter((command) => command.id !== opened.id)).toHaveLength(1));
  const [next] = sent().filter((command) => command.id !== opened.id);
  await expectApplied(next.id);

  expect(sent().filter((command) => command.id === opened.id)).toHaveLength(1);
  const carrying = commandCalls().find(([, init]) => String(init?.body).includes(next.id));
  expect(carrying?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${renewed}` });
  expect(commandCalls().slice(afterSignIn).map(([, init]) => (init?.headers as Record<string, string>).Authorization))
    .not.toContain(`Bearer ${token}`);
});
