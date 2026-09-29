import { MedusaError } from '@medusajs/framework/utils'

// Only the plugin's own checks before any write throw this, so rejecting instead of retrying is safe.
// Medusa's own INVALID_DATA can be a retryable race, so it is never classified by type.
export class StoreConfigurationError extends MedusaError {
  constructor(message: string, readonly code: 'store_configuration' | 'unsupported_currency' = 'store_configuration') {
    super(MedusaError.Types.INVALID_DATA, message)
  }
}

export function isStoreConfigurationError(error: unknown): error is StoreConfigurationError {
  return error instanceof StoreConfigurationError
}
