import type { Knex } from '@medusajs/framework/mikro-orm/knex'

export async function resolveProductChanges(knex: Knex, eventName: string, id: string): Promise<{
  productId: string; op: 'upsert' | 'delete'
}[]> {
  if (/^product\.product\.(created|updated|restored|deleted)$/.test(eventName)) {
    return [{ productId: id, op: eventName.endsWith('.deleted') ? 'delete' : 'upsert' }]
  }

  // Keep soft-deleted rows visible: deletion and detach events arrive after the write.
  let query: Knex.QueryBuilder
  if (/^product\.product-variant\.(created|updated|deleted|restored)$/.test(eventName)) {
    query = knex('product_variant').select('product_id').where('id', id)
  } else if (/^product\.product-option\.(created|updated|deleted)$/.test(eventName)) {
    query = knex('product_product_option').select('product_id').where('product_option_id', id)
  } else if (/^product\.product-option-value\.(created|updated|deleted)$/.test(eventName)) {
    query = knex('product_option_value as value')
      .join('product_product_option as option', 'option.product_option_id', 'value.option_id')
      .select('option.product_id').where('value.id', id)
  } else if (/^product\.product-product-option\.(created|deleted)$/.test(eventName)) {
    query = knex('product_product_option').select('product_id').where('id', id)
  } else if (/^product\.product-product-option-value\.(created|deleted)$/.test(eventName)) {
    query = knex('product_product_option_value as value')
      .join('product_product_option as option', 'option.id', 'value.product_product_option_id')
      .select('option.product_id').where('value.id', id)
  } else if (/^pricing\.price\.(created|updated|deleted)$/.test(eventName)) {
    query = knex('price')
      .join('product_variant_price_set as link', 'link.price_set_id', 'price.price_set_id')
      .join('product_variant as variant', 'variant.id', 'link.variant_id')
      .select('variant.product_id').where('price.id', id)
  } else if (/^inventory\.inventory-level\.(created|updated|deleted)$/.test(eventName)) {
    query = knex('inventory_level as level')
      .join('product_variant_inventory_item as link', 'link.inventory_item_id', 'level.inventory_item_id')
      .join('product_variant as variant', 'variant.id', 'link.variant_id')
      .select('variant.product_id').where('level.id', id)
  } else if (/^inventory\.inventory-item\.(updated|deleted)$/.test(eventName)) {
    query = knex('product_variant_inventory_item as link')
      .join('product_variant as variant', 'variant.id', 'link.variant_id')
      .select('variant.product_id').where('link.inventory_item_id', id)
  } else if (/^LinkProductSalesChannel\.(attached|detached)$/.test(eventName)) {
    query = knex('product_sales_channel').select('product_id').where('id', id)
  } else if (/^LinkProductVariantPriceSet\.(attached|detached)$/.test(eventName)) {
    query = knex('product_variant_price_set as link')
      .join('product_variant as variant', 'variant.id', 'link.variant_id')
      .select('variant.product_id').where('link.id', id)
  } else if (/^LinkProductVariantInventoryItem\.(attached|detached)$/.test(eventName)) {
    query = knex('product_variant_inventory_item as link')
      .join('product_variant as variant', 'variant.id', 'link.variant_id')
      .select('variant.product_id').where('link.id', id)
  } else {
    return []
  }
  const rows: { product_id: string }[] = await query.distinct()
  return rows.map(row => ({ productId: row.product_id, op: 'upsert' }))
}
