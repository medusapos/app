import type { TallyConnector } from '@tallyui/core';
import { vi } from 'vitest';

export const capabilities = vi.fn<NonNullable<TallyConnector['capabilities']>>();
export const storeSettings = vi.fn<NonNullable<TallyConnector['storeSettings']>>();

export async function mockPosConnector(importOriginal: () => Promise<typeof import('../lib/pos-connector')>) {
  const actual = await importOriginal();
  return { ...actual, createPosConnector: () => ({ ...actual.createPosConnector(), capabilities, storeSettings }) };
}
