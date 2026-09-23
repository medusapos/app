import type { CommandResult } from '@tallyui/core'
import { MedusaError } from '@medusajs/framework/utils'

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
  if (result.status === 'applied' && result.serverRefs === undefined) {
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
    })
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
  }
  if (result.status === 'rejected' && result.error === undefined) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'Invalid error: required for rejected')
  }
  return result
}
