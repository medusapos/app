// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS_PATH } from '@tallyui/core';
import { createOrderBuilder, finalizeOrder, type PosOrder } from '@tallyui/pos';
import { OutboxProvider, useOutboxContext } from '../lib/outbox-context';
import { saveSession, type Session } from '../lib/session';
import { SessionProvider } from '../lib/session-context';
import { SignInAgain } from '../components/sign-in-again';

let outbox: ReturnType<typeof useOutboxContext>;
let session: Session;
let sequence = 0;
const fetchStub = vi.fn<typeof fetch>();
const newToken = 'signed-in-again';
function Harness() {
  outbox = useOutboxContext();
  return <button onClick={() => { void outbox.record(sale()); }}>Sell another</button>;
}
function sale(): PosOrder {
  const builder = createOrderBuilder({ currency: 'EUR', taxContext: { pricesIncludeTax: false, getTaxRatePpm: () => 0 } });
  builder.addLine({ productId: 'shirt', variantId: 'blue', name: 'Blue shirt', unitPrice: { amount: 1200, currency: 'EUR' } });
  builder.addPayment({ method: 'cash', amountMinor: 1200 });
  return finalizeOrder(builder.getSnapshot(), { registerId: 'register-1' });
}
const sends = () => fetchStub.mock.calls.filter(([url]) => String(url).endsWith(COMMANDS_PATH));
async function mount(signedIn = true) {
  if (signedIn) saveSession(localStorage, session);
  render(<SessionProvider><OutboxProvider><SignInAgain /><Harness /></OutboxProvider></SessionProvider>);
  if (signedIn) await waitFor(() => expect(outbox.orders).not.toBeNull());
}
async function pause() {
  await mount();
  await act(async () => { await outbox.record(sale()); });
  await waitFor(() => expect(outbox.state.authRequired).toBe(true), { timeout: 5000 });
  expect(sends()).toHaveLength(3);
  expect(outbox.state.nextAttemptAt).toBeUndefined();
}
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
  session = { baseUrl: `https://sign-in-again-${++sequence}.test`, email: 'cashier@test.com',
    token: `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.signature` };
  fetchStub.mockReset();
  fetchStub.mockImplementation(async (url, init) => {
    if (String(url).endsWith(COMMANDS_PATH)) {
      if (new Headers(init?.headers).get('Authorization') !== `Bearer ${newToken}`) return new Response(null, { status: 401 });
      const { commands } = JSON.parse(init!.body as string) as { commands: { id: string }[] };
      return new Response(JSON.stringify({ results: commands.map(({ id }) => ({ id, status: 'applied',
        serverRefs: { orderId: `server-${id}`, displayId: '42', totalMinor: 1200 } })) }));
    }
    if (String(url).endsWith('/auth/user/emailpass')) {
      const { password } = JSON.parse(init!.body as string);
      return password === 'correct' ? new Response(JSON.stringify({ token: newToken })) : new Response(null, { status: 401 });
    }
    if (String(url).endsWith('/admin/users/me')) return new Response(JSON.stringify({ user: {} }));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchStub);
});
afterEach(async () => {
  const db = outbox.orders?.database;
  cleanup();
  if (db) await waitFor(() => expect(db.closed).toBe(true));
  vi.unstubAllGlobals();
});

describe('Sign in again with the real session and outbox', () => {
  it('prompts after three 401s, allows selling, then flushes with the new token', async () => {
    await pause();
    const collection = outbox.orders;
    const strip = screen.getByText('1 sale saved, waiting to send ·');
    expect(strip.parentElement?.parentElement?.getAttribute('data-print')).toBe('hide');
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Sign in again' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sell another' }));
    await waitFor(() => expect(outbox.state).toMatchObject({ pending: 2, sending: false, authRequired: true }));
    expect(screen.getByText('2 sales saved, waiting to send ·')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('heading', { name: 'Sign in again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByLabelText('Password').getAttribute('type')).toBe('password');
    expect(screen.getByText(`Your sign-in has expired, so 2 sales are waiting to be sent. Enter the password for ${session.email} to send them.`)).toBeTruthy();
    let respond!: (response: Response) => void;
    fetchStub.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('button', { name: 'Sign in' }).getAttribute('aria-disabled')).toBe('true');
    await act(async () => { respond(new Response(JSON.stringify({ token: newToken }))); });
    await waitFor(() => expect(outbox.recent.map((order) => order.syncStatus)).toEqual(['applied', 'applied']));
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(outbox.orders).toBe(collection);
    expect(screen.queryByRole('heading', { name: 'Sign in again' })).toBeNull();
    const login = fetchStub.mock.calls.find(([url]) => String(url).endsWith('/auth/user/emailpass'))!;
    expect(login[0]).toBe(`${session.baseUrl}/auth/user/emailpass`);
    expect(JSON.parse(login[1]!.body as string)).toEqual({ email: session.email, password: 'correct' });
    expect(sends().at(-1)?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${newToken}` });
    expect(JSON.parse(localStorage.getItem('medusapos.session')!).token).toBe(newToken);
  }, 10000);

  it('shows a wrong-password error, clears the password and stays paused without flushing', async () => {
    await pause();
    const flush = vi.spyOn(outbox, 'flush');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Incorrect email or password.'));
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'Sign in' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Sign in again' })).toBeTruthy();
    expect(flush).not.toHaveBeenCalled();
    expect(sends()).toHaveLength(3);
    expect(outbox.state.authRequired).toBe(true);
    expect(outbox.recent[0].syncStatus).toBe('pending');
  }, 10000);

  it('submits with Enter, but not with an empty password or while signing in', async () => {
    await pause();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const password = screen.getByLabelText('Password');
    const logins = () => fetchStub.mock.calls.filter(([url]) => String(url).endsWith('/auth/user/emailpass'));
    fireEvent.keyDown(password, { key: 'Enter' });
    expect(logins()).toHaveLength(0);
    let respond!: (response: Response) => void;
    fetchStub.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    fireEvent.change(password, { target: { value: 'correct' } });
    fireEvent.keyDown(password, { key: 'Enter' });
    await waitFor(() => expect(logins()).toHaveLength(1));
    fireEvent.change(password, { target: { value: 'correct' } });
    fireEvent.keyDown(password, { key: 'Enter' });
    expect(logins()).toHaveLength(1);
    await act(async () => { respond(new Response(JSON.stringify({ token: newToken }))); });
    await waitFor(() => expect(outbox.recent[0].syncStatus).toBe('applied'));
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  }, 10000);

  it('does not show while authRequired is false, including a pending 401 retry', async () => {
    await mount();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    await act(async () => { await outbox.record(sale()); });
    await waitFor(() => expect(outbox.state.lastRetryReason).toBe('unauthorized'));
    expect(outbox.state.authRequired).not.toBe(true);
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('does not show without a session and flush is a no-op', async () => {
    await mount(false);
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    await act(async () => { await outbox.flush(); });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
