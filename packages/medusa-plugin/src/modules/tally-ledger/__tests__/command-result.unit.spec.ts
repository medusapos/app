import { MedusaError } from '@medusajs/framework/utils'
import { parseCommandResult } from '../command-result'

const serverRefs = { orderId: 'order_123', displayId: '123', totalMinor: 1200 }
const warnings = [
  { code: 'total_mismatch', expectedMinor: 1100, serverMinor: 1200 },
  { code: 'insufficient_stock', variantId: 'variant_123', quantity: 1 },
]
const applied = { id: 'command_123', status: 'applied', serverRefs, warnings }
const rejected = { id: 'command_123', status: 'rejected', error: { code: 'invalid', message: '' } }

it.each([applied, rejected, { id: 'command_123', status: 'duplicate', serverRefs }])(
  'parses a valid $status result', value => {
    expect(parseCommandResult(value)).toEqual(value)
  }
)

it('accepts absent optional fields and an empty displayId', () => {
  expect(parseCommandResult({ id: 'c', status: 'duplicate' })).toEqual({ id: 'c', status: 'duplicate' })
  expect(parseCommandResult({ ...applied, serverRefs: { ...serverRefs, displayId: '' } }).serverRefs?.displayId).toBe('')
  const { displayId, ...refs } = serverRefs
  expect(parseCommandResult({ ...applied, serverRefs: refs }).serverRefs).toEqual(refs)
})

it.each([
  ['result', null],
  ['result', []],
  ['result', 'text'],
  ['id', { ...applied, id: '' }],
  ['id', { ...applied, id: 1 }],
  ['status', { ...applied, status: 'in_progress' }],
  ['serverRefs', { ...applied, serverRefs: undefined }],
  ['serverRefs', { ...applied, serverRefs: null }],
  ['serverRefs', { ...applied, serverRefs: [] }],
  ['serverRefs.orderId', { ...applied, serverRefs: { totalMinor: 1 } }],
  ['serverRefs.orderId', { ...applied, serverRefs: { ...serverRefs, orderId: '' } }],
  ['serverRefs.displayId', { ...applied, serverRefs: { ...serverRefs, displayId: 1 } }],
  ['serverRefs.totalMinor', { ...applied, serverRefs: { ...serverRefs, totalMinor: 1.5 } }],
  ['serverRefs.totalMinor', { ...applied, serverRefs: { ...serverRefs, totalMinor: Number.MAX_SAFE_INTEGER + 1 } }],
  ['warnings', { ...applied, warnings: {} }],
  ['warnings[0]', { ...applied, warnings: [null] }],
  ['warnings[0]', { ...applied, warnings: [[]] }],
  ['warnings[0].code', { ...applied, warnings: [{ code: 'unknown' }] }],
  ['warnings[0].expectedMinor', { ...applied, warnings: [{ ...warnings[0], expectedMinor: 1.5 }] }],
  ['warnings[0].serverMinor', { ...applied, warnings: [{ ...warnings[0], serverMinor: '1' }] }],
  ['warnings[0].variantId', { ...applied, warnings: [{ ...warnings[1], variantId: '' }] }],
  ['warnings[0].quantity', { ...applied, warnings: [{ ...warnings[1], quantity: 1.5 }] }],
  ['warnings[0].quantity', { ...applied, warnings: [{ ...warnings[1], quantity: 0 }] }],
  ['error', { ...rejected, error: undefined }],
  ['error', { ...rejected, error: null }],
  ['error', { ...rejected, error: [] }],
  ['error.code', { ...rejected, error: { code: '', message: '' } }],
  ['error.message', { ...rejected, error: { code: 'invalid', message: 1 } }],
])('rejects an invalid %s', (field, value) => {
  expect(() => parseCommandResult(value)).toThrow(expect.objectContaining({
    type: MedusaError.Types.INVALID_DATA, message: expect.stringContaining(field as string),
  }))
})

it('names the first bad field', () => {
  expect(() => parseCommandResult({ id: '', status: 'unknown' })).toThrow('Invalid id')
})

it('drops unknown keys at every level without mutating the input', () => {
  const value = {
    ...applied, extra: true,
    serverRefs: { ...serverRefs, extra: true },
    warnings: warnings.map(warning => ({ ...warning, extra: true })),
    error: { ...rejected.error, extra: true },
  }
  expect(parseCommandResult(value)).toEqual({ ...applied, error: rejected.error })
  expect(value.serverRefs.extra).toBe(true)
  expect(value.warnings.every(warning => warning.extra)).toBe(true)
})
