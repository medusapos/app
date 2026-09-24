import type { SearchTypes } from "@medusajs/framework/types";
import "@medusajs/framework/modules-sdk";
import productIndex from "../search/product";

describe("product search ingestion", () => {
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
