import { FIRST_SCREEN_PRODUCTS, FIRST_SCREEN_STOCK_FLOOR, firstScreenTopUps } from "../seed-demo-presentation"

const variant = (id: string, manage_inventory = true, sku = id) => ({
  sku, manage_inventory, inventory_items: [{ inventory_item_id: id }],
})
const product = (title: string, variants = [variant(title)]) => ({ title, variants })
const level = (id: string, stocked_quantity: number, reserved_quantity = 0) => ({
  inventory_item_id: id, stocked_quantity, reserved_quantity,
})
const planned = (id: string, stocked_quantity = 25, exists = false) => ({
  inventory_item_id: id, stocked_quantity, exists,
})

describe("first-screen stock top-ups", () => {
  it("uses localeCompare title order to select the first N without mutating inputs", () => {
    const products = [product("Zebra"), product("apple"), product("Banana"), product("Apricot")]
    const before = JSON.parse(JSON.stringify(products))
    const levels = [level("apple", 0)]
    const expected = [...products].sort((a, b) => a.title.localeCompare(b.title)).slice(0, 2)
    expect(expected.map(item => item.title)).toEqual(["apple", "Apricot"])
    expect(firstScreenTopUps(products, levels, 2)).toEqual(
      expected.map(item => planned(item.title, 25, item.title === "apple")),
    )
    expect(products).toEqual(before)
    expect(levels).toEqual([level("apple", 0)])
  })

  it("skips an entire product with any E2E- SKU without consuming a slot", () => {
    const products = [
      product("A fixture", [variant("ordinary"), variant("fixture", false, "E2E-SMOKE")]),
      product("B shop"), product("C shop"), product("D shop"),
    ]
    expect(firstScreenTopUps(products, [], 2)).toEqual([planned("B shop"), planned("C shop")])
  })

  it("leaves unmanaged variants and items at or above the available floor alone", () => {
    const products = [product("A", [variant("unmanaged", false), variant("at"), variant("above"), variant("low")])]
    const levels = [level("unmanaged", 0), level("at", 28, 3), level("above", 40, 5), level("low", 24)]
    expect(firstScreenTopUps(products, levels)).toEqual([planned("low", 25, true)])
    expect(firstScreenTopUps([product("B", [variant("unmanaged-missing", false)])], [])).toEqual([])
  })

  it("adds reserved units to the floor when updating an existing level", () => {
    expect(firstScreenTopUps([product("A")], [level("A", 26, 4)])).toEqual([planned("A", 29, true)])
  })

  it("plans a missing level as a create at the floor", () => {
    expect(firstScreenTopUps([product("A")], [])).toEqual([planned("A")])
  })

  it("plans every linked item of managed variants and deduplicates shared items", () => {
    const products = [
      product("A", [{ ...variant("shared"), inventory_items: [{ inventory_item_id: "shared" }, { inventory_item_id: "second" }] }]),
      product("B", [variant("shared"), variant("third")]),
    ]
    expect(firstScreenTopUps(products, [])).toEqual([planned("shared"), planned("second"), planned("third")])
  })

  it("plans nothing after its updates and creates have been applied", () => {
    const products = [product("A"), product("B"), product("C")]
    const levels = [level("A", 10, 3), level("C", 30)]
    const plan = firstScreenTopUps(products, levels)
    expect(plan).toEqual([planned("A", 28, true), planned("B")])
    const applied = new Map(levels.map(item => [item.inventory_item_id, item]))
    for (const item of plan) {
      applied.set(item.inventory_item_id, level(
        item.inventory_item_id, item.stocked_quantity, applied.get(item.inventory_item_id)?.reserved_quantity ?? 0,
      ))
    }
    expect(firstScreenTopUps(products, [...applied.values()])).toEqual([])
  })

  it("defaults to 48 products and 25 available units", () => {
    expect(FIRST_SCREEN_PRODUCTS).toBe(48)
    expect(FIRST_SCREEN_STOCK_FLOOR).toBe(25)
    const products = Array.from({ length: 49 }, (_, index) => product(`Product ${String(index).padStart(2, "0")}`))
    expect(firstScreenTopUps(products, [])).toEqual(products.slice(0, 48).map(item => planned(item.title)))
  })
})
