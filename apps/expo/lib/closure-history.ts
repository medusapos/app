import { authHeaders } from './pos-connector';
import { NO_POS_ACCESS_MESSAGE, type Session } from './session';

// Page size for Reports' earlier closures.
export const CLOSURE_HISTORY_PAGE = 20;
export type ClosureHistoryEntry = {
  closureId: string; number: number; businessDay?: string; openedAt: string; closedAt: string; periodSalesTotalMinor: number;
};
export class ClosureHistoryError extends Error {
  constructor(readonly code: 'unauthorized' | 'forbidden' | 'failed', message: string) { super(message); }
}

export function dayBefore(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export async function fetchClosureHistory(session: Session, registerId: string, page: { to: string; before?: number },
  fetchImpl = globalThis.fetch): Promise<{ closures: ClosureHistoryEntry[]; more: boolean }> {
  const query = new URLSearchParams({ limit: String(CLOSURE_HISTORY_PAGE), to: page.to });
  if (page.before !== undefined) query.set('before', String(page.before));
  let response: Response;
  try {
    response = await fetchImpl(`${session.baseUrl}/tally/v1/registers/${encodeURIComponent(registerId)}/closures?${query}`,
      { headers: authHeaders(session.token) });
  } catch { throw new ClosureHistoryError('failed', "Couldn't reach the backend."); }
  if (response.status === 401) throw new ClosureHistoryError('unauthorized', 'Please sign in again.');
  if (response.status === 403) throw new ClosureHistoryError('forbidden', NO_POS_ACCESS_MESSAGE);
  if (!response.ok) throw new ClosureHistoryError('failed', "Couldn't load earlier closures.");
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== 'object' || body === null || !('closures' in body) || !Array.isArray(body.closures)
    || !('more' in body) || typeof body.more !== 'boolean')
    throw new ClosureHistoryError('failed', "Couldn't load earlier closures.");
  const closures = body.closures.map((row): ClosureHistoryEntry => {
    if (typeof row !== 'object' || row === null || typeof row.closureId !== 'string' || typeof row.number !== 'number'
      || typeof row.periodSalesTotalMinor !== 'number' || typeof row.openedAt !== 'string' || typeof row.closedAt !== 'string')
      throw new ClosureHistoryError('failed', "Couldn't load earlier closures.");
    const { closureId, number, businessDay, openedAt, closedAt, periodSalesTotalMinor } = row;
    return { closureId, number, ...(businessDay === undefined ? {} : { businessDay }), openedAt, closedAt, periodSalesTotalMinor };
  });
  return { closures, more: body.more };
}
