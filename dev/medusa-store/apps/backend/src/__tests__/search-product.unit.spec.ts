import { logger } from "@medusajs/framework/logger"
import type { SearchTypes } from "@medusajs/framework/types";
import "@medusajs/framework/modules-sdk";
import productIndex from "../search/product";
import { resolveProductIds } from "../search/helpers/resolve-product-ids"

describe("product search ingestion", () => {
  beforeEach(() => {
    jest.spyOn(logger, "warn").mockImplementation(() => {})
    jest.spyOn(logger, "debug").mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([
    { name: "product-variant.created", ids: ["variant_1", "variant_2"] },
  ])("resolveProductIds skips rows query.graph does not return ($name)", async ({ name, ids }) => {
    const graph = jest.fn(async () => ({
      data: [undefined, { product_id: "prod_2" }],
    }))
    const context = {
      container: { query: { graph } },
      index: { entity: "product", primary_key: "id" },
    } as unknown as SearchTypes.SearchIngestionContext

    await expect(resolveProductIds(
      { name, data: ids.map((id) => ({ id })) },
      context,
    )).resolves.toEqual(["prod_2"])
  })

  it.each([
    {
      title: "product-option events select products.id and resolve every linked product",
      name: "product-option.updated", field: "products.id",
      row: { id: "opt_1", products: [{ id: "prod_1" }, { id: "prod_2" }] },
    },
    {
      title: "product-option-value events select option.products.id",
      name: "product-option-value.updated", field: "option.products.id",
      row: { id: "optval_1", option: { products: [{ id: "prod_1" }, { id: "prod_2" }] } },
    },
    {
      title: "a product-tag event selects products.id",
      name: "product-tag.updated", field: "products.id",
      row: { id: "tag_1", products: [{ id: "prod_1" }, { id: "prod_2" }] },
    },
  ])("$title", async ({ name, field, row }) => {
    const graph = jest.fn(async () => ({ data: [row] }))
    const context = {
      container: { query: { graph } },
    } as unknown as SearchTypes.SearchIngestionContext

    await expect(resolveProductIds({ name, data: { id: row.id } }, context))
      .resolves.toEqual(["prod_1", "prod_2"])
    expect(graph).toHaveBeenCalledWith(expect.objectContaining({
      fields: expect.arrayContaining(["id", field]),
      filters: { id: [row.id] },
    }))
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalled()
  })

  it.each([
    {
      title: "a missing row warns with the missing ids",
      name: "product-option.updated", level: "warn" as const, other: "debug" as const,
      ids: ["opt_1", "opt_2"],
      row: { id: "opt_2", products: [{ id: "prod_2" }] },
      products: ["prod_2"],
      message: "[search] product index: product-option.updated returned 1 of 2 rows (opt_1 missing); those products weren't re-indexed",
    },
    {
      title: "rows with no products log at debug, not warn",
      name: "product-option.deleted", level: "debug" as const, other: "warn" as const,
      ids: ["opt_1"],
      row: { id: "opt_1", products: [] },
      products: [],
      message: "[search] product index: product-option.deleted opt_1 links to no products",
    },
  ])("$title", async ({ name, level, other, ids, row, products, message }) => {
    const graph = jest.fn(async () => ({ data: [row] }))
    const context = {
      container: { query: { graph } },
    } as unknown as SearchTypes.SearchIngestionContext

    await expect(resolveProductIds({ name, data: ids.map((id) => ({ id })) }, context))
      .resolves.toEqual(products)
    expect(logger[level]).toHaveBeenCalledTimes(1)
    expect(logger[level]).toHaveBeenCalledWith(
      message,
    )
    expect(logger[other]).not.toHaveBeenCalled()
  })

  it("a .deleted event queries with withDeleted true", async () => {
    const graph = jest.fn(async () => ({ data: [{ id: "opt_1", products: [] }] }))
    const context = {
      container: { query: { graph } },
    } as unknown as SearchTypes.SearchIngestionContext

    await resolveProductIds({ name: "product-option.deleted", data: { id: "opt_1" } }, context)
    expect(graph).toHaveBeenCalledWith(expect.objectContaining({ withDeleted: true }))
  })

  it("an undefined row never throws", async () => {
    const graph = jest.fn(async () => ({
      data: [undefined, { id: "opt_2", products: [{ id: "prod_2" }] }],
    }))
    const context = {
      container: { query: { graph } },
    } as unknown as SearchTypes.SearchIngestionContext

    await expect(resolveProductIds(
      { name: "product-option.updated", data: [{ id: "opt_1" }, { id: "opt_2" }] }, context,
    )).resolves.toEqual(["prod_2"])
  })

  it("consumes product deletion without loading prices", async () => {
    const ids = ["prod_1", "prod_2"]
    const graph = jest.fn()
    const context = {
      container: { query: { graph } },
      index: { entity: "product", primary_key: "id" },
    } as unknown as SearchTypes.SearchSeedContext

    const mutations = await productIndex.consume!(
      { name: "product.deleted", data: ids.map((id) => ({ id })) },
      context,
    )

    expect(mutations).toEqual([{ action: "delete", filters: { id: ids } }])
    expect(graph).not.toHaveBeenCalled()
  })

  it("seeds two pages with one pricing read per currency per page", async () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({
      id: `prod_${String(index).padStart(3, "0")}`,
      title: `Product ${index}`,
    }))
    const graph = jest.fn(async (input: {
      context?: unknown
      filters: { id?: string[] | { $gt: string } }
      pagination?: { take: number }
    }) => {
      if ("context" in input) {
        const ids = input.filters.id as string[]
        return {
          data: rows.filter((row) => ids.includes(row.id)).map((row) => ({
            id: row.id,
            variants: [{
              calculated_price: { calculated_amount: 10, original_amount: 15 },
            }],
          })),
        }
      }
      const cursor = (input.filters.id as { $gt: string } | undefined)?.$gt
      return {
        data: rows
          .filter((row) => cursor === undefined || row.id > cursor)
          .slice(0, input.pagination!.take),
      }
    })
    const context = {
      container: { query: { graph } },
      index: { entity: "product", primary_key: "id" },
    } as unknown as SearchTypes.SearchSeedContext
    const batches: SearchTypes.SearchMutation[][] = []

    for await (const batch of productIndex.seed(context)) {
      batches.push(batch)
    }

    const pages = [rows.slice(0, 200), rows.slice(200)]
    expect(batches).toEqual(pages.map((page) => [{
      action: "upsert",
      documents: page.map((row) => expect.objectContaining({
        ...row,
        min_price_eur: 10,
        min_price_usd: 10,
      })),
    }]))
    expect(graph).toHaveBeenCalledTimes(6)
    pages.forEach((page, pageIndex) => {
      expect(graph).toHaveBeenNthCalledWith(
        pageIndex * 3 + 1,
        expect.objectContaining({
          filters: pageIndex === 0 ? {} : { id: { $gt: rows[199].id } },
          pagination: { take: 200, order: { id: "ASC" } },
        }),
      )
      for (const call of [2, 3]) {
        expect(graph).toHaveBeenNthCalledWith(
          pageIndex * 3 + call,
          expect.objectContaining({
            filters: { id: page.map((row) => row.id) },
            context: expect.anything(),
          }),
        )
      }
    })
  })

  it("seeds and consumes the same priced documents in batches", async () => {
    const rows = [
      { id: "prod_1", title: "First product" },
      { id: "prod_2", title: "Second product" },
    ];
    const ids = rows.map((row) => row.id);
    const graph = jest.fn(async (input: { context?: unknown }) => ({
      data:
        "context" in input
          ? rows.map((row, index) => ({
              id: row.id,
              variants: [
                {
                  calculated_price: {
                    calculated_amount: (index + 1) * 10,
                    original_amount: (index + 1) * 15,
                  },
                },
              ],
            }))
          : rows,
    }));
    // The real graph helpers only need query.graph and these index properties.
    const context = {
      container: { query: { graph } },
      index: { entity: "product", primary_key: "id" },
    } as unknown as SearchTypes.SearchSeedContext;
    const batches: SearchTypes.SearchMutation[][] = [];

    for await (const batch of productIndex.seed(context)) {
      batches.push(batch);
    }

    expect(batches).toEqual([
      [
        {
          action: "upsert",
          documents: [
            expect.objectContaining({
              id: "prod_1",
              title: "First product",
              min_price_eur: 10,
            }),
            expect.objectContaining({
              id: "prod_2",
              title: "Second product",
              min_price_eur: 20,
            }),
          ],
        },
      ],
    ]);
    // One row read and one pricing read per currency for the whole batch.
    expect(graph).toHaveBeenCalledTimes(3);
    for (const [input] of graph.mock.calls.slice(1)) {
      expect(input).toEqual(
        expect.objectContaining({
          filters: { id: ids },
          context: expect.anything(),
        }),
      );
    }
    graph.mockClear();

    const mutations = await productIndex.consume!(
      {
        name: "product.updated",
        data: ids.map((id) => ({ id })),
      },
      context,
    );

    expect(mutations).toEqual(batches[0]);
    expect(graph).toHaveBeenCalledTimes(3);
    expect(graph).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ filters: { id: ids } }),
    );
    for (const [input] of graph.mock.calls.slice(1)) {
      expect(input).toEqual(
        expect.objectContaining({
          filters: { id: ids },
          context: expect.anything(),
        }),
      );
    }
  });
});
