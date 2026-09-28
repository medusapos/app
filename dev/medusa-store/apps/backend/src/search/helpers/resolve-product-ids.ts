import { logger } from "@medusajs/framework/logger"
import type {
  RemoteQueryFunction,
  SearchTypes,
} from "@medusajs/framework/types";

const RESOLVE_BATCH_SIZE = 200;

// Core emits either a single `{ id }` or a batch of them.
function payloadIds(data: unknown): string[] {
  return (Array.isArray(data) ? data : [data])
    .map((entry) => (entry as { id?: string } | undefined)?.id)
    .filter((id): id is string => Boolean(id));
}

/**
 * The products behind rows of another entity, read through `query.graph`.
 * Deleted rows are soft-deleted, so they're still readable with `withDeleted`,
 * which is how a deleted variant or category still leads back to its products.
 */
async function relatedProductIds(
  query: RemoteQueryFunction,
  entity: string,
  fields: string[],
  ids: string[],
  pick: (row: Record<string, any>) => (string | null | undefined)[],
  withDeleted: boolean,
  event: { name: string },
): Promise<string[]> {
  const { data } = await query.graph({
    entity,
    fields,
    filters: { id: ids },
    withDeleted,
  });

  const rows = data.filter(Boolean) as Record<string, any>[]
  const productIds = rows
    .flatMap(pick)
    .filter((id): id is string => Boolean(id));
  if (rows.length < ids.length) {
    const missingIds = ids.filter((id) => !rows.some((row) => row.id === id))
    logger.warn(
      `[search] product index: ${event.name} returned ${rows.length} of ${ids.length} rows (${missingIds.join(", ")} missing); those products weren't re-indexed`,
    )
  } else if (!productIds.length) {
    logger.debug(
      `[search] product index: ${event.name} ${ids.join(", ")} links to no products`,
    )
  }
  return productIds
}

/**
 * Deleting a sales channel removes its product links, so the products can no
 * longer be found through `query.graph`. The index still holds the channel on
 * each document, which is what's searched here.
 */
async function productIdsInSalesChannels(
  query: RemoteQueryFunction,
  salesChannelIds: string[],
): Promise<string[]> {
  const ids: string[] = [];
  let skip = 0;

  while (true) {
    const { search_result: result } = await query.search({
      entity: "product",
      fields: ["id"],
      filters: { sales_channel_ids: salesChannelIds },
      pagination: { skip, take: RESOLVE_BATCH_SIZE },
    });

    ids.push(...result.hits.map((hit) => hit.id));

    if (result.hits.length < RESOLVE_BATCH_SIZE) {
      return ids;
    }

    skip += RESOLVE_BATCH_SIZE;
  }
}

/**
 * The products an event affects. A product event carries them directly; an
 * event about a variant, option, tag, category or sales channel is mapped to
 * the products behind it.
 */
export async function resolveProductIds(
  event: { name: string; data: unknown },
  { container }: SearchTypes.SearchIngestionContext,
): Promise<string[]> {
  const { query } = container
  const ids = payloadIds(event.data);

  if (!ids.length) {
    return [];
  }

  const [entity] = event.name.split(".");
  const deleted = event.name.endsWith(".deleted");

  switch (entity) {
    case "product":
      return ids;
    case "product-variant":
      return relatedProductIds(
        query,
        "product_variant",
        ["id", "product_id"],
        ids,
        (row) => [row.product_id],
        deleted,
        event,
      );
    case "product-option":
      return relatedProductIds(
        query,
        "product_option",
        ["id", "products.id"],
        ids,
        (row) => (row.products ?? []).map((product: any) => product?.id),
        deleted,
        event,
      );
    case "product-option-value":
      return relatedProductIds(
        query,
        "product_option_value",
        ["id", "option.products.id"],
        ids,
        (row) => (row.option?.products ?? []).map((product: any) => product?.id),
        deleted,
        event,
      );
    case "product-tag":
      return relatedProductIds(
        query,
        "product_tag",
        ["id", "products.id"],
        ids,
        (row) => (row.products ?? []).map((product: any) => product?.id),
        deleted,
        event,
      );
    case "product-category":
      return relatedProductIds(
        query,
        "product_category",
        ["id", "products.id"],
        ids,
        (row) => (row.products ?? []).map((product: any) => product?.id),
        deleted,
        event,
      );
    case "sales-channel":
      return productIdsInSalesChannels(query, ids);
    default:
      return [];
  }
}
