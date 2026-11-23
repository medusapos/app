import type { TaxRounding } from '@tallyui/core' with { 'resolution-mode': 'import' }

// The order.create versions this plugin accepts: /info advertises them and processBatch enforces them (one source).
export const SUPPORTED_ORDER_CREATE_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7]
// ADR 0021: Medusa cannot preserve per-line exemptions and has no tax classes.
export const LINE_TAX = { none: false, classes: false }
// Version 2 adds take-over fields to the open (ADR to follow).
// Version 3 adds approval to the closure (ADR 0023); the other commands are unchanged at 3.
export const SUPPORTED_REGISTER_VERSIONS: readonly number[] = [1, 2, 3]
// The order.refund versions this plugin accepts (TallyUI ADR-080, ADR 0026).
export const SUPPORTED_ORDER_REFUND_VERSIONS: readonly number[] = [1]
// ADR 0023: the default when the option is unset.
export const DEFAULT_APPROVAL_THRESHOLD_MINOR = 500
// The version of the contract between this plugin and the MedusaPOS app, advertised on /info as `pluginContract`.
// Bump it when the app comes to need a route, field or behaviour an older plugin lacks, and raise the app's
// MIN_PLUGIN_CONTRACT (apps/expo/lib/plugin-contract.ts) in the same change. The order.create/register lists stay
// TallyUI's per-command negotiation; this one is the app's.
// Contract 1 includes GET /tally/v1/registers/{id}/closures' `cashier` filter (#446); an older plugin ignores the key.
// Contract 2 adds POST /tally/v1/device-clear-approvals (#280).
// Contract 3 adds GET /tally/v1/orders
// Contract 4 adds allChannels=true on GET /tally/v1/orders
// Contract 5 adds order.refund v1 (ADR 0026)
export const PLUGIN_CONTRACT = 5

export function approvalThresholdMinor(options: { approvalThresholdMinor?: number }): number {
  const value = options.approvalThresholdMinor
  return Number.isSafeInteger(value) && value! >= 0 ? value! : DEFAULT_APPROVAL_THRESHOLD_MINOR
}

export function registerVersionAccepted(version: number, options: { minRegisterContract?: number }): boolean {
  return SUPPORTED_REGISTER_VERSIONS.includes(version)
    && (options.minRegisterContract === undefined || version >= options.minRegisterContract)
}

/**
 * How this store rounds tax, advertised on /info as `taxRounding` (TallyUI #309, ADR-071): once per order, half away from zero.
 * - Medusa 2.21 never rounds totals: `@medusajs/utils` `dist/totals/cart/index.js:37-116`, `dist/totals/line-item/index.js:45-92`
 *   and `dist/totals/tax/index.js:7-22` compute BigNumber decimals, kept raw at `toPrecision(20)` (`dist/totals/big-number.js:24-28,137`).
 * - A tax provider returns rates, never amounts: `ITaxProvider.getTaxLines` (`@medusajs/types` `dist/tax/provider.d.ts:166`)
 *   returns tax lines carrying `rate`, `code` and `name`, with no amount (`dist/tax/common.d.ts:440-486`).
 * - The plugin rounds once: `majorToMinor` (`workflows/tally-order-create/money.ts:15-32`, half away from zero) on
 *   `order.raw_total` (`runOrderCreate`'s `serverMinor`).
 * - #133 measured 0 differences in 340,230 sales against the till's per_order + half_away_from_zero (comment 5903926127).
 */
export const TAX_ROUNDING: TaxRounding = { granularity: 'per_order', mode: 'half_away_from_zero' }
