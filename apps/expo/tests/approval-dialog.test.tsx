// @vitest-environment jsdom
// The "Manager approval" dialog on its own (ADR 0018, #89 review): a hung approval never locks the till.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PortalHost } from '@tallyui/primitives';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalDialog, APPROVE_OFFLINE } from '../components/register-close';
import { APPROVAL_TIMEOUT_MS } from '../lib/approval';

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-GB' }] }));

const baseUrl = 'https://approval.test';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const me = { user: { id: 'user_mgr', first_name: 'Mia', last_name: 'Manager' } };

/** Medusa's sign-in answered by `signIn` (which ignores the request's signal, as the worst network does). */
function stubMedusa(signIn: () => Promise<Response>) {
  const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/auth/user/emailpass') return signIn();
    if (path === '/admin/users/me') return json(me);
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const never = () => new Promise<Response>(() => {});

let onResult: ReturnType<typeof vi.fn<(result: unknown) => void>>;
let stored: Map<string, string>;
beforeEach(() => {
  onResult = vi.fn();
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
    removeItem: (key: string) => { stored.delete(key); },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function mountAndApprove(online = true) {
  await act(async () => { render(<><ApprovalDialog baseUrl={baseUrl} online={online} onResult={onResult} /><PortalHost /></>); });
  fireEvent.change(screen.getByTestId('approval-email'), { target: { value: 'mia@store.test' } });
  fireEvent.change(screen.getByTestId('approval-password'), { target: { value: 'manager-secret' } });
  await act(async () => { fireEvent.click(screen.getByTestId('approval-approve')); });
}

describe('the Manager approval dialog', () => {
  it('while a request hangs, Cancel still works: it aborts the request and resolves null at once, exactly once', async () => {
    const fetch = stubMedusa(never);
    await mountAndApprove();
    expect(screen.getByTestId('approval-approve').textContent).toBe('Checking…');
    expect(screen.getByTestId('approval-cancel').getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => { fireEvent.click(screen.getByTestId('approval-cancel')); });
    expect(onResult.mock.calls).toEqual([[null]]);
    const signIn = fetch.mock.calls.find(([url]) => String(url).endsWith('/auth/user/emailpass'))!;
    expect(signIn[1]?.signal?.aborted).toBe(true);
    await act(async () => { fireEvent.click(screen.getByTestId('approval-cancel')); });
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('Escape cancels as Cancel does, aborting the request in flight', async () => {
    const fetch = stubMedusa(never);
    await mountAndApprove();
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(onResult.mock.calls).toEqual([[null]]);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('after APPROVAL_TIMEOUT_MS of no answer it shows the offline copy with only Cancel', async () => {
    vi.useFakeTimers();
    stubMedusa(never);
    await mountAndApprove();
    await act(async () => { await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS); });
    expect(screen.getByTestId('approval-offline').textContent).toBe(APPROVE_OFFLINE);
    expect(screen.queryByTestId('approval-approve')).toBeNull();
    expect(onResult).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByTestId('approval-cancel')); });
    expect(onResult.mock.calls).toEqual([[null]]);
  });

  it('a success that arrives after Cancel is ignored: no approval, and the approver is not kept', async () => {
    let answer!: (response: Response) => void;
    stubMedusa(() => new Promise<Response>((resolve) => { answer = resolve; }));
    await mountAndApprove();
    await act(async () => { fireEvent.click(screen.getByTestId('approval-cancel')); });
    await act(async () => { answer(json({ token: 'late-token' })); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(onResult.mock.calls).toEqual([[null]]);
    expect([...stored.keys()]).toEqual([]);
  });

  it('keeps browsers from filling in a saved password: new-password on the password, off on the email', async () => {
    await act(async () => { render(<><ApprovalDialog baseUrl={baseUrl} online onResult={onResult} /><PortalHost /></>); });
    expect(screen.getByTestId('approval-password').getAttribute('autocomplete')).toBe('new-password');
    expect(screen.getByTestId('approval-email').getAttribute('autocomplete')).toBe('off');
  });
});
