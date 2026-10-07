// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RegisterCommandEnvelope } from '@tallyui/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RegisterGate, TillRegisterBar } from '../components/register';
import { closeOrderStores, registerCollections } from '../lib/order-store';
import { OutboxProvider, useOutboxContext } from '../lib/outbox-context';
import { getDeviceName, useRegister } from '../lib/register-context';
import { REGISTER_ID_KEY, saveSession } from '../lib/session';
import { SessionProvider } from '../lib/session-context';

vi.mock('expo-localization', () => ({ getCalendars: () => [{ uses24hourClock: null }], getLocales: () => [{ languageTag: 'en-GB' }] }));

let sequence = 0;
let baseUrl: string;
let context: ReturnType<typeof useRegister>;
let outbox: ReturnType<typeof useOutboxContext>;
let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
let responseGate: Promise<void>;
let rejection: string | null;
let refusalData: Record<string, string>;
const onGate = vi.fn();
const onPanel = vi.fn();
const focus = { key: 0, handled: { current: 0 } };
const sent = () => fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/tally/v1/commands'))
  .flatMap(([, init]) => JSON.parse(String(init?.body)).commands as RegisterCommandEnvelope[]);

function Probe() {
  context = useRegister();
  outbox = useOutboxContext();
  return <>
    <TillRegisterBar online onGate={onGate} onOpenPanel={onPanel} />
    <RegisterGate currency="EUR" online refused={null} cartEmpty focus={focus}>
      <span data-testid="cart-child">Cart</span>
    </RegisterGate>
  </>;
}

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  localStorage.setItem(REGISTER_ID_KEY, 'conflict-device');
  baseUrl = `https://register-conflict-${++sequence}.test`;
  rejection = 'register_session_already_open';
  refusalData = { sessionId: 'other-session', openedBy: 'other@store.test', deviceName: 'Counter till', status: 'open' };
  responseGate = Promise.resolve();
  onGate.mockClear();
  onPanel.mockClear();
  fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    await responseGate;
    const batch = JSON.parse(String(init?.body)).commands as RegisterCommandEnvelope[];
    return new Response(JSON.stringify({ results: batch.map(({ id }) => rejection
      ? { id, status: 'rejected', error: { code: rejection, message: 'Store refused the command', data: refusalData } }
      : { id, status: 'applied' }) }));
  });
  vi.stubGlobal('fetch', fetchImpl);
});
afterEach(async () => {
  cleanup();
  await closeOrderStores();
  vi.unstubAllGlobals();
});

async function mount(register = 2) {
  saveSession(localStorage, { baseUrl, email: 'admin@store.test',
    token: `header.${btoa(JSON.stringify({ exp: Date.now() / 1000 + 86400 }))}.signature`,
    capabilities: { orderCreate: 3, register } });
  render(<SessionProvider><OutboxProvider><Probe /></OutboxProvider></SessionProvider>);
  await screen.findByTestId('register-picker');
  await act(async () => { fireEvent.click(screen.getByTestId('register-picker-row-register-1')); });
  const amount = await screen.findByTestId('open-register-amount');
  fireEvent.change(amount, { target: { value: '100.00' } });
  await act(async () => { fireEvent.click(screen.getByTestId('open-register-button')); });
  await waitFor(() => expect(context.register.session?.status).toBe(rejection ? 'conflict' : 'open'));
}

it.each(['web', 'ios', 'android'] as const)('supplies a bounded human device name for %s', (os) => {
  const name = getDeviceName(os);
  expect(name.trim().length).toBeGreaterThan(0);
  expect(name.length).toBeLessThanOrEqual(64);
});

it('shows a v2 conflict above the cart, refuses payment and routes the register button to the gate', async () => {
  await mount();
  const card = screen.getByTestId('register-conflict-card');
  expect(card.textContent).toContain('This register is open on another till.');
  expect(card.textContent).toContain('other@store.test');
  expect(card.textContent).toContain('Counter till');
  expect(screen.getByRole('button', { name: 'Take over' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Choose another register' })).toBeTruthy();
  expect(card.compareDocumentPosition(screen.getByTestId('cart-child')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  for (const id of ['open-register-button', 'register-column', 'register-count', 'register-column-finish-close-button']) {
    expect(screen.queryByTestId(id)).toBeNull();
  }
  await expect(context.register.requireSaleSession()).rejects.toThrow();
  fireEvent.click(screen.getByTestId('register-bar-open-panel'));
  expect(onGate).toHaveBeenCalledOnce();
  expect(onPanel).not.toHaveBeenCalled();
});

it('offers only Choose another register when the store advertises register 1', async () => {
  await mount(1);
  expect(screen.getByTestId('register-conflict-card')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Choose another register' })).toBeTruthy();
});

it('abandons the conflict and unbinds the till when choosing another register', async () => {
  await mount();
  const sessionId = context.register.session!.id;
  fireEvent.click(screen.getByTestId('register-conflict-choose'));
  expect(screen.getByTestId('register-conflict-choose').getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByTestId('register-conflict-take-over').getAttribute('aria-disabled')).toBe('true');
  await screen.findByTestId('register-picker');
  expect(context.boundRegisterId).toBeNull();
  expect(context.register.session).toBeNull();
  expect(screen.queryByTestId('register-conflict-card')).toBeNull();
  expect(screen.getByTestId('cart-child')).toBeTruthy();
  expect((await registerCollections(outbox.orders!).sessions.findOne(sessionId).exec())?.status).toBe('abandoned');
});

it('sends supersedes and waits without buttons until the store applies the take-over open', async () => {
  await mount();
  rejection = null;
  let answer!: () => void;
  responseGate = new Promise((resolve) => { answer = resolve; });
  fireEvent.click(screen.getByTestId('register-conflict-take-over'));
  expect(screen.getByTestId('register-conflict-take-over').getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByTestId('register-conflict-choose').getAttribute('aria-disabled')).toBe('true');
  await screen.findByTestId('register-conflict-waiting');
  expect(context.register.session?.status).toBe('conflict');
  expect(screen.queryByTestId('register-conflict-take-over')).toBeNull();
  expect(screen.queryByTestId('register-conflict-choose')).toBeNull();
  await waitFor(() => expect(sent()).toHaveLength(2));
  expect(sent()[1]).toMatchObject({ type: 'register.session.open', version: 2,
    payload: { supersedes: 'other-session', deviceName: getDeviceName() } });
  await act(async () => { answer(); });
  await waitFor(() => expect(context.register.session?.status).toBe('open'));
  expect(screen.queryByTestId('register-conflict-card')).toBeNull();
  expect(screen.getByTestId('register-column')).toBeTruthy();
});

it('shows a thrown action error as an alert', async () => {
  delete refusalData.sessionId;
  await mount();
  await act(async () => { fireEvent.click(screen.getByTestId('register-conflict-take-over')); });
  expect((await screen.findByRole('alert')).textContent).toBe('The register changed. Try again.');
  expect(screen.getByTestId('register-conflict-choose')).toBeTruthy();
});

it('shows the open card after a later command is rejected as superseded', async () => {
  rejection = null;
  await mount();
  const sessionId = context.register.session!.id;
  await waitFor(() => expect(context.registerOutbox.state).toMatchObject({ pending: 0, sending: false }));
  rejection = 'register_session_superseded';
  await act(async () => { await context.register.actions.startCounting(); });
  await screen.findByTestId('open-register-card');
  expect(context.register.session).toBeNull();
  expect(screen.queryByTestId('register-conflict-card')).toBeNull();
  expect(screen.queryByTestId('register-count')).toBeNull();
  expect(screen.getByTestId('cart-child')).toBeTruthy();
  expect((await registerCollections(outbox.orders!).sessions.findOne(sessionId).exec())?.status).toBe('superseded');
});
