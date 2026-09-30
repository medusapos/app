import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'

// InMemoryLockingProvider.identifier (@medusajs/locking dist/providers/in-memory.js:146).
const IN_MEMORY_PROVIDER = 'in-memory'
export const IN_MEMORY_LOCKING_WARNING = 'Medusa POS: the locking module uses its in-memory provider. That is safe for one Medusa instance only; with more than one, concurrent sales can lose stock updates. Configure the Redis locking provider (@medusajs/medusa/locking-redis) before scaling out.'

/** Warns when stock locks serialise only inside one process; never stops the app. */
export default async function tallyLockingCheck(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  try {
    // The module keeps the loader's default provider id (@medusajs/locking dist/services/locking-module.js:9).
    const { defaultProviderId } = container.resolve(Modules.LOCKING) as unknown as { defaultProviderId: string }
    if (defaultProviderId === IN_MEMORY_PROVIDER)logger.warn(IN_MEMORY_LOCKING_WARNING)
  } catch (error) {
    logger.debug(`Medusa POS: could not detect the locking provider: ${(error as Error).message}`)
  }
}

// Plugins have no startup hook that can reach the locking module, so this job runs once, a second after start.
export const config = { name: 'tally-locking-check', schedule: { interval: 1000, numberOfExecutions: 1 } }
