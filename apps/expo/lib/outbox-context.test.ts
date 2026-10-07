import { describe, expect, it } from 'vitest';
import { refusedForPosAccess } from './pos-access';

describe('refusedForPosAccess', () => {
  it.each([403, 400, 422, undefined])('recognises only a 403 refusal: %s', (status) => {
    expect(refusedForPosAccess({
      pending: 1, sending: false, refused: status === undefined ? undefined : { status, reason: 'refused' },
    })).toBe(status === 403);
  });
});
