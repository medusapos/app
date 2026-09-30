// The order.create versions this plugin accepts: /info advertises them and processBatch enforces them (one source).
export const SUPPORTED_ORDER_CREATE_VERSIONS: readonly number[] = [1, 2, 3]
// The contract versions shared by all five register commands.
export const SUPPORTED_REGISTER_VERSIONS: readonly number[] = [1]

// BRIDGE: @tallyui/core 2.0.0 doesn't export TaxRounding (TallyUI #309, main only); swap for it at the 3.0.0 bump.
export type TaxRounding =
  | { granularity: 'per_order' | 'per_line_items' | 'per_rate_group_items'; mode: 'half_away_from_zero' | 'half_up' }
  | { granularity: 'custom' }
/**
 * How this store rounds tax, advertised on /info as `taxRounding` (TallyUI #309, ADR-071): once per order, half away from zero.
 * - Medusa 2.21 never rounds totals: `@medusajs/utils` `dist/totals/cart/index.js:37-116`, `dist/totals/line-item/index.js:45-92`
 *   and `dist/totals/tax/index.js:7-22` compute BigNumber decimals, kept raw at `toPrecision(20)` (`dist/totals/big-number.js:24-28,137`).
 * - A tax provider returns rates, never amounts: `ITaxProvider.getTaxLines` (`@medusajs/types` `dist/tax/provider.d.ts:166`)
 *   returns tax lines carrying `rate`, `code` and `name`, with no amount (`dist/tax/common.d.ts:440-486`).
 * - The plugin rounds once: `majorToMinor` (`workflows/tally-order-create/money.ts:15-32`, half away from zero) on
 *   `order.raw_total` (`run.ts:189`).
 * - #133 measured 0 differences in 340,230 sales against the till's per_order + half_away_from_zero (comment 5903926127).
 */
export const TAX_ROUNDING: TaxRounding = { granularity: 'per_order', mode: 'half_away_from_zero' }
