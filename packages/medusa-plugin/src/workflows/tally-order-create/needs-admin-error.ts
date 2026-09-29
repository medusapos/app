// A plain Error, not a MedusaError, so no type check can classify it as anything else.
// Resume throws it for an order state the recipe never creates, e.g. an admin's refund.
export class NeedsAdminError extends Error {
  constructor(readonly orderId: string, readonly detail: string) {
    super(`Order ${orderId} needs an admin: ${detail}`)
    this.name = 'NeedsAdminError'
  }
}

export function isNeedsAdminError(error: unknown): error is NeedsAdminError {
  return error instanceof NeedsAdminError
}
