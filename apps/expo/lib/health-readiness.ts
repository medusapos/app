import type { OutboxHealth } from '@tallyui/pos';
import { CURRENT_PLUGIN_CONTRACT } from './plugin-contract';

export type HealthReadiness = { state: 'checking' } | { state: 'ready' } | { state: 'warning'; reasons: string[] };

export function healthReadiness(plugin: { contract: number | null } | null, outbox: OutboxHealth): HealthReadiness {
  if (plugin === null) return { state: 'checking' };

  const reasons: string[] = [];
  if (plugin.contract === null) {
    reasons.push('The store did not answer. Sales are kept on this device and send when it does.');
  } else if (plugin.contract < CURRENT_PLUGIN_CONTRACT) {
    reasons.push("The store's plugin is older than this app expects. Update it to use every feature.");
  }
  if (outbox.authRequired) reasons.push('Sign in again so waiting changes can send.');
  if (outbox.attention > 0) {
    reasons.push(outbox.attention === 1 ? '1 change needs attention.' : `${outbox.attention} changes need attention.`);
  }
  const pending = outbox.sales.pending + outbox.tillUpdates.pending;
  if (pending > 0) reasons.push(`${pending} ${pending === 1 ? 'change' : 'changes'} waiting to send.`);
  return reasons.length ? { state: 'warning', reasons } : { state: 'ready' };
}
