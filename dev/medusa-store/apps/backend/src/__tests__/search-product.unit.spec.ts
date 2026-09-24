import type { SearchTypes } from "@medusajs/framework/types";
import "@medusajs/framework/modules-sdk";
import productIndex from "../search/product";

describe("product search ingestion", () => {
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
