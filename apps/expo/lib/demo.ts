import type { StoreSettingsChoice, StoreSettingsChoices } from '@tallyui/core';
import { storeConfig } from './config';

// Ordinary Medusa admin users on the demo backend, public on purpose;
// the manager is the second login that approves a register close (ADR 0018).
export const DEMO_ACCOUNTS = [
  { label: 'Enter the demo', email: 'cashier@demo.medusapos.com', password: 'demo1234' },
  { label: 'Enter as manager', email: 'manager@demo.medusapos.com', password: 'demo1234' },
] as const;

// The region the demo till is set up in.
export const DEMO_REGION_NAME = 'Europe';

export function isDemoAccount(email: string, demo = storeConfig.demo): boolean {
  return demo && DEMO_ACCOUNTS.some((account) => account.email === email.trim().toLowerCase());
}

export function demoTillChoice(choices: StoreSettingsChoices, initial: StoreSettingsChoice | undefined): StoreSettingsChoice {
  const region = choices.regions?.find((region) => region.name === DEMO_REGION_NAME)?.id
    ?? initial?.region ?? choices.regions?.[0]?.id;
  const channel = initial?.channel ?? choices.channels?.[0]?.id;
  return { ...(region !== undefined && { region }), ...(channel !== undefined && { channel }) };
}
