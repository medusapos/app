import { vi } from 'vitest';
import type { Session } from '../lib/session';
import type { useSession } from '../lib/session-context';

/** `useSession()`'s value for tests that mock `../lib/session-context`: this session, every handler a fresh `vi.fn()`. */
export function sessionFixture(
  session: Session | null,
  overrides: Partial<ReturnType<typeof useSession>> = {},
): ReturnType<typeof useSession> {
  return {
    session,
    signIn: vi.fn(),
    signOut: vi.fn(),
    reportUnauthorized: vi.fn(),
    reportNoPosAccess: vi.fn(),
    signOutNotice: null,
    mergeCapabilities: vi.fn(),
    setSaleHold: vi.fn(),
    setSavesHold: vi.fn(),
    signOutDeferred: false,
    ...overrides,
  };
}
