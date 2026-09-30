import type { CommandError, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { currencyDecimals } from './money'

export type CommandErrorWithData = CommandError
export type OrderCreatePayloadV3 = OrderCreatePayload

export function fiscalFiguresErrors(payload: OrderCreatePayloadV3): string[] {
  const errors: string[] = []
  const check = (valid: boolean, path: string, expected: string) => {
    if (!valid && errors.length < 10) errors.push(`payload.${path}: expected ${expected}`)
  }
  const object = (value: unknown, path: string, keys: string[]): value is Record<string, unknown> => {
    const valid = typeof value === 'object' && value !== null && !Array.isArray(value)
    check(valid, path, 'an object')
    if (valid) for (const key of Object.keys(value)) check(keys.includes(key), `${path}.${key}`, 'no unknown key')
    return valid
  }
  const money = (value: Record<string, unknown>, path: string, keys: string[]) => {
    for (const key of keys) check(Number.isSafeInteger(value[key]), `${path}.${key}`, 'a safe integer')
  }
  const { display, taxByRate } = payload
  if (object(display, 'display', ['currency', 'exponent', 'taxInclusive', 'subtotalMinor', 'discountMinor', 'taxMinor', 'totalMinor', 'orderDiscountMinor', 'lines'])) {
    check(typeof display.currency === 'string', 'display.currency', 'a string')
    check(Number.isInteger(display.exponent) && display.exponent >= 0, 'display.exponent', 'an integer >= 0')
    check(typeof display.taxInclusive === 'boolean', 'display.taxInclusive', 'a boolean')
    money(display, 'display', ['subtotalMinor', 'discountMinor', 'taxMinor', 'totalMinor', 'orderDiscountMinor'])
    check(Array.isArray(display.lines), 'display.lines', 'an array')
    if (Array.isArray(display.lines)) display.lines.forEach((line, index) => {
      const path = `display.lines[${index}]`
      if (!object(line, path, ['clientLineId', 'amountMinor', 'discounts'])) return
      check(typeof line.clientLineId === 'string', `${path}.clientLineId`, 'a string')
      money(line, path, ['amountMinor'])
      check(Array.isArray(line.discounts), `${path}.discounts`, 'an array')
      if (Array.isArray(line.discounts)) line.discounts.forEach((discount, index) => {
        const discountPath = `${path}.discounts[${index}]`
        if (!object(discount, discountPath, ['discountId', 'label', 'amountMinor'])) return
        check(typeof discount.discountId === 'string', `${discountPath}.discountId`, 'a string')
        if (discount.label !== undefined) check(typeof discount.label === 'string', `${discountPath}.label`, 'a string')
        money(discount, discountPath, ['amountMinor'])
      })
    })
  }
  check(Array.isArray(taxByRate), 'taxByRate', 'an array')
  if (Array.isArray(taxByRate)) taxByRate.forEach((rate, index) => {
    const path = `taxByRate[${index}]`
    if (!object(rate, path, ['ratePpm', 'code', 'netMinor', 'taxMinor', 'grossMinor'])) return
    check(Number.isInteger(rate.ratePpm), `${path}.ratePpm`, 'an integer')
    if (rate.code !== undefined) check(typeof rate.code === 'string', `${path}.code`, 'a string')
    money(rate, path, ['netMinor', 'taxMinor', 'grossMinor'])
  })
  if (errors.length || !display || !Array.isArray(taxByRate)) return errors
  check(display.currency === payload.currency, 'display.currency', 'payload.currency')
  check(display.totalMinor === payload.totalMinor, 'display.totalMinor', 'payload.totalMinor')
  check(display.taxMinor === payload.taxMinor, 'display.taxMinor', 'payload.taxMinor')
  check(taxByRate.length > 0 || payload.taxMinor === 0, 'taxByRate', 'a non-empty array when payload.taxMinor is nonzero')
  check(Number.isSafeInteger(payload.taxMinor) && taxByRate.reduce((sum, rate) => sum + BigInt(rate.taxMinor), 0n) === BigInt(payload.taxMinor), 'taxByRate', 'the sum of taxMinor to equal payload.taxMinor')
  taxByRate.forEach((rate, index) => check(BigInt(rate.grossMinor) === BigInt(rate.netMinor) + BigInt(rate.taxMinor), `taxByRate[${index}].grossMinor`, 'netMinor + taxMinor'))
  const ids = new Set(Array.isArray(payload.lines) ? payload.lines.map(line => line?.clientLineId) : [])
  const seen = new Set<string>()
  display.lines.forEach((line, index) => {
    check(ids.has(line.clientLineId), `display.lines[${index}].clientLineId`, 'a payload.lines[].clientLineId')
    check(!seen.has(line.clientLineId), `display.lines[${index}].clientLineId`, 'no duplicate clientLineId')
    seen.add(line.clientLineId)
  })
  try {
    check(display.exponent === currencyDecimals(payload.currency), 'display.exponent', 'the currency decimals')
  } catch {
    // Leave unsupported currencies to the planner's unsupported_currency rejection.
  }
  return errors
}
