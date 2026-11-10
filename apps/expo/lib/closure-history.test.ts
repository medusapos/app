import { expect, it, vi } from 'vitest';
import { ClosureHistoryError, dayBefore, fetchClosureHistory } from './closure-history';
import { authHeaders } from './pos-connector';
import { NO_POS_ACCESS_MESSAGE } from './session';

const session = { baseUrl: 'https://shop.test', email: 'a@b.c', token: 't0k' };
const entry = { closureId: 'c3', number: 3, businessDay: '2026-11-09',
  openedAt: '2026-11-09T09:00:00Z', closedAt: '2026-11-09T18:00:00Z', periodSalesTotalMinor: 4500 };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it('requests the bound register before a day, with the session token', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => response({ closures: [], more: false }));
  await fetchClosureHistory(session, 'reg/1', { to: '2026-11-09' }, fetchImpl);
  expect(fetchImpl).toHaveBeenLastCalledWith(
    'https://shop.test/tally/v1/registers/reg%2F1/closures?limit=20&to=2026-11-09', { headers: authHeaders('t0k') });
  await fetchClosureHistory(session, 'reg/1', { to: '2026-11-09', before: 7 }, fetchImpl);
  expect(fetchImpl).toHaveBeenLastCalledWith(
    'https://shop.test/tally/v1/registers/reg%2F1/closures?limit=20&to=2026-11-09&before=7', { headers: authHeaders('t0k') });
});

it('returns the entries and more', async () => {
  const second = { closureId: 'c2', number: 2, openedAt: '2026-11-08T09:00:00Z',
    closedAt: '2026-11-08T18:00:00Z', periodSalesTotalMinor: 2000 };
  const fetchImpl = vi.fn<typeof fetch>(async () => response({
    closures: [entry, second].map((row) => ({ ...row, orderIds: ['o1'], counted: { cash: 4500 } })), more: true,
  }));
  const result = await fetchClosureHistory(session, 'reg/1', { to: '2026-11-09' }, fetchImpl);
  expect(result).toEqual({ closures: [entry, second], more: true });
  expect(result.closures[1]).not.toHaveProperty('businessDay');
});

it('maps 401, 403, other statuses, a network error and a bad body to its errors', async () => {
  const cases = [
    { status: 401, body: {}, code: 'unauthorized', message: 'Please sign in again.' },
    { status: 403, body: {}, code: 'forbidden', message: NO_POS_ACCESS_MESSAGE },
    { status: 500, body: {}, code: 'failed', message: "Couldn't load earlier closures." },
    { status: 200, body: { closures: 'x', more: false }, code: 'failed', message: "Couldn't load earlier closures." },
    { status: 200, body: { closures: [{ ...entry, number: '3' }], more: false },
      code: 'failed', message: "Couldn't load earlier closures." },
  ];
  for (const { status, body, code, message } of cases) {
    const fetchImpl = vi.fn<typeof fetch>(async () => response(body, status));
    const request = fetchClosureHistory(session, 'reg/1', { to: '2026-11-09' }, fetchImpl);
    await expect(request).rejects.toBeInstanceOf(ClosureHistoryError);
    await expect(request).rejects.toMatchObject({ code, message });
  }
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline'));
  await expect(fetchClosureHistory(session, 'reg/1', { to: '2026-11-09' }, fetchImpl))
    .rejects.toMatchObject({ code: 'failed', message: "Couldn't reach the backend." });
});

it('dayBefore steps back one calendar day', () => {
  expect(dayBefore('2026-11-10')).toBe('2026-11-09');
  expect(dayBefore('2026-03-01')).toBe('2026-02-28');
  expect(dayBefore('2024-03-01')).toBe('2024-02-29');
  expect(dayBefore('2026-01-01')).toBe('2025-12-31');
});
