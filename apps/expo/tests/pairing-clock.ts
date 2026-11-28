import { act } from '@testing-library/react';
import type { DisplaySignalling } from '@tallyui/core';
import { PENDING_POLL_MS } from '@tallyui/pos';
import { type MockInstance, vi } from 'vitest';

export async function advancePastExpiry(expiresAt: string, pending: MockInstance<DisplaySignalling['pending']>) {
  const target = Date.parse(expiresAt) + 1;
  while (Date.now() < target) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(PENDING_POLL_MS, target - Date.now()));
      await Promise.allSettled(pending.mock.results.map(result => result.value));
    });
  }
}
