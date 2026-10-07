import type { OutboxState } from '@tallyui/pos';

export function refusedForPosAccess(state: OutboxState): boolean { return state.refused?.status === 403; }
