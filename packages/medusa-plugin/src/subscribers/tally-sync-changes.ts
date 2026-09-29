import type { SubscriberArgs, SubscriberConfig } from '@medusajs/framework'
import type { Logger } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { TALLY_LEDGER_MODULE } from '../modules/tally-ledger'
import type TallyLedgerModuleService from '../modules/tally-ledger/service'
import { TALLY_SYNC_MODULE } from '../modules/tally-sync'
import type TallySyncModuleService from '../modules/tally-sync/service'
import { resolveProductChanges } from '../modules/tally-sync/resolve-products'

export default async function tallySyncChanges({ event: { name, data }, container }: SubscriberArgs<{ id: string }>) {
  let logger: Logger | undefined
  try {
    logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const ledger = container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE)
    if (!ledger.getPluginOptions().experimentalSync) return
    const changes = await resolveProductChanges(container.resolve(ContainerRegistrationKeys.PG_CONNECTION), name, data.id)
    if (!changes.length) {
      logger.debug(`tally_sync: no products resolved for ${name} (${data.id})`)
      return
    }
    await container.resolve<TallySyncModuleService>(TALLY_SYNC_MODULE).record(changes.map(({ productId, op }) => ({
      collection: 'products', objectId: productId, op,
    })))
  } catch (error) {
    logger?.error(`tally_sync: failed to record ${name}: ${error}`)
  }
}

export const config: SubscriberConfig = {
  event: [
    'product.product.created', 'product.product.updated', 'product.product.restored', 'product.product.deleted',
    'product.product-variant.created', 'product.product-variant.updated',
    'product.product-variant.deleted', 'product.product-variant.restored',
    'product.product-option.created', 'product.product-option.updated', 'product.product-option.deleted',
    'product.product-option-value.created', 'product.product-option-value.updated', 'product.product-option-value.deleted',
    'product.product-product-option.created', 'product.product-product-option.deleted',
    'product.product-product-option-value.created', 'product.product-product-option-value.deleted',
    'pricing.price.created', 'pricing.price.updated', 'pricing.price.deleted',
    'inventory.inventory-level.created', 'inventory.inventory-level.updated', 'inventory.inventory-level.deleted',
    'inventory.inventory-item.updated', 'inventory.inventory-item.deleted',
    'LinkProductSalesChannel.attached', 'LinkProductSalesChannel.detached',
    'LinkProductVariantPriceSet.attached', 'LinkProductVariantPriceSet.detached',
    'LinkProductVariantInventoryItem.attached', 'LinkProductVariantInventoryItem.detached',
  ],
}
