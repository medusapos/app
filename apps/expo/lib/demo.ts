import type { StoreSettingsChoice, StoreSettingsChoices } from '@tallyui/core';
import { storeConfig } from './config';

// Ordinary Medusa admin users on the demo backend, public on purpose;
// the manager is the second login that approves a register close (ADR 0018).
export const DEMO_ACCOUNTS = [
  { label: 'Enter the demo', email: 'cashier@demo.medusapos.com', password: 'demo1234', testID: 'demo-enter-cashier' },
  { label: 'Enter as manager', email: 'manager@demo.medusapos.com', password: 'demo1234', testID: 'demo-enter-manager' },
] as const;

// The region the demo till is set up in.
export const DEMO_REGION_NAME = 'Europe';

// Only features available in the public demo today, with links to learn more.
export const DEMO_WHAT_TO_TRY = [
  'Ring up a sale and take cash or card',
  'Split a payment: part card, the rest cash (Split payment at checkout)',
  'Attach a customer to a sale: search one, or add a new one',
  'Park a sale, then resume it from Parked sales',
  "Change a line's price in the cart",
  'Add a fee, shipping or a custom item to a sale (Add charge in the cart)',
  'Close the register with a cash count',
] as const;
export const DEMO_ABOUT_URL = 'https://medusapos.com';
export const DEMO_QUICK_START_URL = 'https://medusapos.com/docs/quick-start';
export const DEMO_REPO_URL = 'https://github.com/medusapos/app';

export function isDemoAccount(email: string, demo = storeConfig.demo): boolean {
  return demo && DEMO_ACCOUNTS.some((account) => account.email === email.trim().toLowerCase());
}

export function demoTillChoice(choices: StoreSettingsChoices, initial: StoreSettingsChoice | undefined): StoreSettingsChoice {
  const region = choices.regions?.find((region) => region.name === DEMO_REGION_NAME)?.id
    ?? initial?.region ?? choices.regions?.[0]?.id;
  const channel = initial?.channel ?? choices.channels?.[0]?.id;
  return { ...(region !== undefined && { region }), ...(channel !== undefined && { channel }) };
}
