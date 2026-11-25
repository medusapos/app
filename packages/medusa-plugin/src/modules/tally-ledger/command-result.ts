import type { CommandResult } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { MedusaError } from '@medusajs/framework/utils'
import type { RegisterCommandResult } from '../tally-register/types'

export type RegisterSessionUnknownWarning = { code: 'register_session_unknown'; sessionId: string }

/** Validates a CommandResult (e.g. one read back from the ledger). Throws
 *  MedusaError INVALID_DATA naming the first bad field. */
export function parseCommandResult(value: unknown): CommandResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid result: expected object')
  }
  const input = value as Record<string, unknown>
  if (typeof input.id !== 'string' || input.id.length === 0) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid id')
  }
  if (input.status !== 'applied' && input.status !== 'duplicate' && input.status !== 'rejected') {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid status')
  }
  const result: CommandResult = { id: input.id, status: input.status }
  const object = (value: unknown): boolean => typeof value === 'object' && value !== null
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  if (input.serverRefs !== undefined) {
    if (typeof input.serverRefs !== 'object' || input.serverRefs === null || Array.isArray(input.serverRefs)) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid serverRefs')
    }
    const refs = input.serverRefs as Record<string, unknown>
    if (typeof refs.orderId !== 'string' || refs.orderId.length === 0) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid serverRefs.orderId')
    }
    if (refs.displayId !== undefined && typeof refs.displayId !== 'string') {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid serverRefs.displayId')
    }
    if (!Number.isSafeInteger(refs.totalMinor)) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid serverRefs.totalMinor')
    }
    result.serverRefs = { orderId: refs.orderId, totalMinor: refs.totalMinor as number }
    if (refs.displayId !== undefined) result.serverRefs.displayId = refs.displayId as string
  }
  if (input.register !== undefined) {
    if (!object(input.register)) throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid register')
    result.register = input.register as RegisterCommandResult
  }
  if (input.refund !== undefined) result.refund = parseRefund(input.refund, object)
  if (result.status === 'applied' && result.serverRefs === undefined && result.register === undefined && result.refund === undefined) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid serverRefs: required for applied')
  }
  if (input.warnings !== undefined) {
    if (!Array.isArray(input.warnings)) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid warnings')
    }
    result.warnings = input.warnings.map((warning: unknown, index) => {
      const field = `warnings[${index}]`
      if (typeof warning !== 'object' || warning === null || Array.isArray(warning)) {
        throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid ${field}`)
      }
      const item = warning as Record<string, unknown>
      if (item.code === 'total_mismatch') {
        for (const key of ['expectedMinor', 'serverMinor']) {
          if (!Number.isInteger(item[key])) {
            throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid ${field}.${key}`)
          }
        }
        return { code: item.code, expectedMinor: item.expectedMinor as number, serverMinor: item.serverMinor as number }
      }
      if (item.code === 'figures_mismatch') {
        if (!Array.isArray(item.fields) || item.fields.length === 0) throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid ${field}.fields`)
        const seen: string[] = []
        return { code: item.code, fields: item.fields.map((value: unknown, i) => {
          const path = `${field}.fields[${i}]`
          if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid ${path}`)
          const entry = value as Record<string, unknown>
          if (!['subtotalMinor', 'taxMinor', 'discountMinor'].includes(entry.field as string) || seen.includes(entry.field as string)) {
            throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid ${path}.field`)
          }
          seen.push(entry.field as string)
          if (!Number.isSafeInteger(entry.tillMinor)) throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid ${path}.tillMinor`)
          if (!Number.isSafeInteger(entry.serverMinor) || entry.serverMinor === entry.tillMinor) throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid ${path}.serverMinor`)
          return { field: entry.field as string, tillMinor: entry.tillMinor as number, serverMinor: entry.serverMinor as number }
        }) }
      }
      if (item.code === 'customer_ignored') {
        if (typeof item.customerId !== 'string' || item.customerId.length < 1 || item.customerId.length > 64) {
          throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid ${field}.customerId`)
        }
        return { code: item.code, customerId: item.customerId }
      }
      if (item.code === 'register_session_unknown') {
        if (typeof item.sessionId !== 'string' || item.sessionId.length < 1 || item.sessionId.length > 36) {
          throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid ${field}.sessionId`)
        }
        return { code: item.code, sessionId: item.sessionId } satisfies RegisterSessionUnknownWarning
      }
      if (item.code === 'insufficient_stock') {
        if (typeof item.variantId !== 'string' || item.variantId.length === 0) {
          throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid ${field}.variantId`)
        }
        if (!Number.isInteger(item.quantity) || (item.quantity as number) < 1) {
          throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid ${field}.quantity`)
        }
        return { code: item.code, variantId: item.variantId, quantity: item.quantity as number }
      }
      throw new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid ${field}.code`)
    }) as CommandResult['warnings']
  }
  if (input.error !== undefined) {
    if (typeof input.error !== 'object' || input.error === null || Array.isArray(input.error)) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid error')
    }
    const error = input.error as Record<string, unknown>
    if (typeof error.code !== 'string' || error.code.length === 0) {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid error.code')
    }
    if (typeof error.message !== 'string') {
      throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid error.message')
    }
    result.error = { code: error.code, message: error.message }
    if (error.data !== undefined) {
      if (!object(error.data)) throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid error.data')
      result.error.data = error.data as Record<string, unknown>
    }
  }
  if (result.status === 'rejected' && result.error === undefined) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid error: required for rejected')
  }
  return result
}

/** An order.refund applied result (ADR-080): byMethod and refunds each sum to totalMinor. */
function parseRefund(value: unknown, object: (value: unknown) => boolean): NonNullable<CommandResult['refund']> {
  const invalid = (field: string) => new MedusaError(MedusaError.Types.INVALID_DATA, `Invalid refund${field}`)
  if (!object(value)) throw invalid('')
  const input = value as Record<string, unknown>
  if (!Number.isSafeInteger(input.totalMinor) || (input.totalMinor as number) < 0) throw invalid('.totalMinor')
  const totalMinor = input.totalMinor as number
  if (!object(input.byMethod)) throw invalid('.byMethod')
  const byMethod: Record<string, number> = Object.create(null)
  let sum = 0
  for (const [method, amount] of Object.entries(input.byMethod as Record<string, unknown>)) {
    if (!method.length || !Number.isSafeInteger(amount)) throw invalid(`.byMethod.${method}`)
    byMethod[method] = amount as number
    sum += amount as number
  }
  if (sum !== totalMinor) throw invalid('.byMethod: expected to sum to totalMinor')
  // TallyUI#1331 / #546: an empty refunds is a stock-only return, so only with a 0 total and no byMethod keys.
  const stockOnly = totalMinor === 0 && Object.keys(byMethod).length === 0
  if (!Array.isArray(input.refunds) || (input.refunds.length === 0 && !stockOnly)) throw invalid('.refunds')
  sum = 0
  const refunds = input.refunds.map((entry: unknown, index) => {
    const item = entry as Record<string, unknown>
    if (!object(entry)) throw invalid(`.refunds[${index}]`)
    for (const key of ['id', 'paymentId', 'state']) {
      if (typeof item[key] !== 'string' || !(item[key] as string).length) throw invalid(`.refunds[${index}].${key}`)
    }
    if (!Number.isSafeInteger(item.totalMinor)) throw invalid(`.refunds[${index}].totalMinor`)
    sum += item.totalMinor as number
    return { id: item.id as string, paymentId: item.paymentId as string, totalMinor: item.totalMinor as number, state: item.state as string }
  })
  if (sum !== totalMinor) throw invalid('.refunds: expected to sum to totalMinor')
  return { totalMinor, byMethod: { ...byMethod }, refunds } as NonNullable<CommandResult['refund']>
}
