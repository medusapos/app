import type { OutboxHealth } from '@tallyui/pos';
import { describe, expect, it } from 'vitest';
import { healthReadiness } from '../lib/health-readiness';
import { CURRENT_PLUGIN_CONTRACT } from '../lib/plugin-contract';

const empty = { pending: 0, rejected: 0, stuck: 0 };
function outbox(overrides: Partial<OutboxHealth> = {}): OutboxHealth {
  return { sales: empty, tillUpdates: empty, attention: 0, authRequired: false, ...overrides };
}
const unanswered = 'The store did not answer. Sales are kept on this device and send when it does.';
const older = "The store's plugin is older than this app expects. Update it to use every feature.";
const signIn = 'Sign in again so waiting changes can send.';

describe('healthReadiness', () => {
  it('checking until /info has been read', () => {
    expect(healthReadiness(null, outbox({ sales: { ...empty, pending: 2 } }))).toEqual({ state: 'checking' });
  });

  it('ready when the store answers with the current contract and nothing waits', () => {
    expect(healthReadiness({ contract: CURRENT_PLUGIN_CONTRACT }, outbox())).toEqual({ state: 'ready' });
  });

  it('a plugin newer than this app is ready', () => {
    expect(healthReadiness({ contract: CURRENT_PLUGIN_CONTRACT + 1 }, outbox())).toEqual({ state: 'ready' });
  });

  it.each([
    [null, outbox(), unanswered],
    [0, outbox(), older],
    [CURRENT_PLUGIN_CONTRACT - 1, outbox(), older],
    [CURRENT_PLUGIN_CONTRACT, outbox({ authRequired: true }), signIn],
    [CURRENT_PLUGIN_CONTRACT, outbox({ attention: 1 }), '1 change needs attention.'],
    [CURRENT_PLUGIN_CONTRACT, outbox({ attention: 2 }), '2 changes need attention.'],
    [CURRENT_PLUGIN_CONTRACT, outbox({ sales: { ...empty, pending: 1 } }), '1 change waiting to send.'],
    [CURRENT_PLUGIN_CONTRACT, outbox({ sales: { ...empty, pending: 1 }, tillUpdates: { ...empty, pending: 1 } }), '2 changes waiting to send.'],
    [CURRENT_PLUGIN_CONTRACT, outbox({ tillUpdates: { ...empty, pending: 3 } }), '3 changes waiting to send.'],
  ] as const)('each cause gives its one reason', (contract, health, reason) => {
    expect(healthReadiness({ contract }, health)).toEqual({ state: 'warning', reasons: [reason] });
  });

  it('lists every reason in order when several apply', () => {
    const health = outbox({ authRequired: true, attention: 1, sales: { ...empty, pending: 2 } });
    expect(healthReadiness({ contract: null }, health)).toEqual({
      state: 'warning', reasons: [unanswered, signIn, '1 change needs attention.', '2 changes waiting to send.'],
    });
  });
});
