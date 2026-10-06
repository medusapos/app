import feeGolden from '../__fixtures__/order-create-v5-fee.json'
import shippingGolden from '../__fixtures__/order-create-v5-shipping-custom.json'
import type { OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { fiscalFiguresErrors } from '../fiscal-figures'
import { lineTaxRefusals, v5DisplayErrors, withoutV5Display } from '../v5'

it('the fee golden pair has no line-tax refusals', () => {
  expect(lineTaxRefusals(feeGolden.payload)).toEqual([])
})

it('the shipping+custom golden pair is refused once: lines[1].custom.taxStatus, tax_status_unsupported', () => {
  expect(lineTaxRefusals(shippingGolden.payload)).toEqual([{
    path: 'lines[1].custom.taxStatus', reason: 'tax_status_unsupported',
    message: "payload.lines[1].custom.taxStatus: tax_status_unsupported: this store can't keep a line tax-free (ADR 0021)",
  }])
})

it('every taxClass is tax_class_unknown and every taxStatus none is tax_status_unsupported, fees then shipping then lines', () => {
  const instructions = [{ taxStatus: 'none', taxClass: '' }, { taxStatus: 'taxable', taxClass: 'standard' }, { taxStatus: 'none' }]
  const result = lineTaxRefusals({ fees: instructions, shipping: instructions, lines: [{ clientLineId: 'catalogue' }, ...instructions.map(custom => ({ custom }))] })
  const paths = [
    'fees[0].taxStatus', 'fees[0].taxClass', 'fees[1].taxClass', 'fees[2].taxStatus',
    'shipping[0].taxStatus', 'shipping[0].taxClass', 'shipping[1].taxClass', 'shipping[2].taxStatus',
    'lines[1].custom.taxStatus', 'lines[1].custom.taxClass', 'lines[2].custom.taxClass', 'lines[3].custom.taxStatus',
  ]
  expect(result).toEqual(paths.map(path => path.endsWith('taxStatus') ? {
    path, reason: 'tax_status_unsupported', message: `payload.${path}: tax_status_unsupported: this store can't keep a line tax-free (ADR 0021)`,
  } : { path, reason: 'tax_class_unknown', message: `payload.${path}: tax_class_unknown: this store has no tax classes (ADR 0021)` }))
  expect(lineTaxRefusals({ lines: [] })).toEqual([])
})

it('display.fees and display.shipping must name payload fees and shipping, once each', () => {
  expect(v5DisplayErrors({})).toEqual([])
  for (const fixture of [feeGolden, shippingGolden]) expect(v5DisplayErrors(fixture.payload)).toEqual([])
  for (const [field, id, charge] of [
    ['fees', 'clientFeeId', feeGolden.payload.fees[0]], ['shipping', 'clientShippingId', shippingGolden.payload.shipping[0]],
  ] as const) {
    const row = { [id]: (charge as Record<string, unknown>)[id], amountMinor: 0 }
    expect(v5DisplayErrors({ [field]: [charge], display: { [field]: [row] } })).toEqual([])
    expect(v5DisplayErrors({ display: { [field]: [] } })).toEqual([`payload.display.${field}: expected payload.${field} to be present`])
    expect(v5DisplayErrors({ [field]: [charge], display: { [field]: [{ ...row, [id]: 'unknown' }] } }))
      .toEqual([`payload.display.${field}[0].${id}: expected a payload.${field}[].${id}`])
    expect(v5DisplayErrors({ [field]: [charge], display: { [field]: [row, row] } }))
      .toEqual([`payload.display.${field}[1].${id}: expected no duplicate ${id}`])
    for (const amountMinor of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, '0', null, undefined]) {
      expect(v5DisplayErrors({ [field]: [charge], display: { [field]: [{ ...row, amountMinor }] } }))
        .toEqual([`payload.display.${field}[0].amountMinor: expected a non-negative safe integer`])
    }
    expect(v5DisplayErrors({ [field]: [charge], display: { [field]: [{ ...row, extra: 1 }] } }))
      .toEqual([`payload.display.${field}[0].extra: expected no unknown key`])
    for (const value of [null, {}, 'row']) {
      expect(v5DisplayErrors({ [field]: [], display: { [field]: value } })).toEqual([`payload.display.${field}: expected an array`])
      expect(v5DisplayErrors({ [field]: [], display: { [field]: [value === null ? null : []] } }))
        .toEqual([`payload.display.${field}[0]: expected an object`])
    }
  }
})

it('withoutV5Display strips display.fees and display.shipping without mutating, and plugin fiscalFiguresErrors then passes the fee golden pair', () => {
  const payload: OrderCreatePayload = {
    ...feeGolden.payload,
    fees: feeGolden.payload.fees.map(fee => {
      if (fee.taxStatus !== 'taxable') throw new Error('Expected the golden taxable fee')
      return { ...fee, taxStatus: fee.taxStatus }
    }),
    payments: feeGolden.payload.payments.map(payment => ({ ...payment, method: 'cash' as const })),
  }
  const original = structuredClone(payload), stripped = withoutV5Display(payload)
  expect(fiscalFiguresErrors(payload)).toEqual(['payload.display.fees: expected no unknown key'])
  expect(fiscalFiguresErrors(stripped)).toEqual([])
  expect(stripped).not.toBe(payload)
  expect(stripped.display).not.toBe(payload.display)
  expect(stripped.lines).toBe(payload.lines)
  expect(stripped.fees).toBe(payload.fees)
  expect(stripped.display).not.toHaveProperty('fees')
  expect(payload).toEqual(original)
  const both = { ...shippingGolden.payload, display: { ...shippingGolden.payload.display, fees: feeGolden.payload.display.fees } }
  const copy = structuredClone(both), result = withoutV5Display(both)
  expect(result.display).not.toHaveProperty('shipping')
  expect(result.display).not.toHaveProperty('fees')
  expect(result.display.lines).toBe(both.display.lines)
  expect(both).toEqual(copy)
  const absent = { clientOrderId: 'absent' }
  expect(withoutV5Display(absent as typeof absent & { display?: object })).toEqual(absent)
  expect(withoutV5Display(absent as typeof absent & { display?: object })).not.toBe(absent)
})
