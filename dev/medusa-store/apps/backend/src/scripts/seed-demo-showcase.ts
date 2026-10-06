import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules, ProductStatus } from "@medusajs/framework/utils"
import {
  createCustomersWorkflow, createInventoryLevelsWorkflow, createOrderWorkflow,
  createProductCategoriesWorkflow, createProductsWorkflow,
} from "@medusajs/medusa/core-flows"

export const SHOWCASE_CATEGORIES = ["Shirts", "Sweatshirts", "Pants", "Coffee & Tea", "Bakery", "Home & Gifts"]
const IMAGE_ROOT = "https://medusa-public-images.s3.eu-west-1.amazonaws.com"
// Shelf prices in EUR, including VAT. Stock is per size; images only depict matching products.
const CATALOGUE: [string, string, string, number, number, string[], string?][] = [
  ["black-tee", "Everyday Black Tee", "Shirts", 19.95, 12, ["S", "M", "L"], "tee-black-front.png"],
  ["white-tee", "Everyday White Tee", "Shirts", 19.95, 12, ["S", "M", "L"], "tee-white-front.png"],
  ["sweatshirt", "Weekend Sweatshirt", "Sweatshirts", 45, 8, ["S", "M", "L"], "sweatshirt-vintage-front.png"],
  ["joggers", "Grey Lounge Joggers", "Pants", 39.50, 8, ["S", "M", "L"], "sweatpants-gray-front.png"],
  ["shorts", "Weekend Shorts", "Pants", 29.95, 8, ["S", "M", "L"], "shorts-vintage-front.png"],
  ["house-beans", "House Coffee Beans · 250 g", "Coffee & Tea", 9.50, 30, ["Default"]],
  ["espresso-beans", "Espresso Coffee Beans · 250 g", "Coffee & Tea", 10.95, 24, ["Default"]],
  ["decaf-coffee", "Decaf Ground Coffee · 250 g", "Coffee & Tea", 10.50, 18, ["Default"]],
  ["earl-grey", "Earl Grey Tea · 100 g", "Coffee & Tea", 7.95, 20, ["Default"]],
  ["green-tea", "Jasmine Green Tea · 100 g", "Coffee & Tea", 8.50, 20, ["Default"]],
  ["mint-tea", "Peppermint Tea · 50 g", "Coffee & Tea", 6.50, 16, ["Default"]],
  ["croissant", "Butter Croissant", "Bakery", 2.50, 24, ["Default"]],
  ["cinnamon-bun", "Cinnamon Bun", "Bakery", 3.50, 18, ["Default"]],
  ["sourdough", "Sourdough Loaf", "Bakery", 5.95, 10, ["Default"]],
  ["rye-loaf", "Seeded Rye Loaf", "Bakery", 4.95, 10, ["Default"]],
  ["cookie", "Chocolate Chunk Cookie", "Bakery", 2, 30, ["Default"]],
  ["lemon-cake", "Lemon Cake Slice", "Bakery", 3.95, 0, ["Default"]],
  ["mug", "Morning Coffee Mug", "Home & Gifts", 12, 20, ["Default"], "coffee-mug.png"],
  ["tea-towel", "Linen Tea Towel", "Home & Gifts", 9.95, 16, ["Default"]],
  ["candle", "Cedar Candle", "Home & Gifts", 18.50, 12, ["Default"]],
  ["notebook", "Pocket Notebook", "Home & Gifts", 6.50, 24, ["Default"]],
  ["pencils", "Graphite Pencils · Set of 3", "Home & Gifts", 4.50, 20, ["Default"]],
  ["greeting-card", "Botanical Greeting Card", "Home & Gifts", 3.50, 24, ["Default"]],
  ["tote", "Market Cotton Tote", "Home & Gifts", 14.95, 18, ["Default"]],
  ["coasters", "Cork Coasters · Set of 4", "Home & Gifts", 8, 16, ["Default"]],
  ["soap", "Oat Hand Soap", "Home & Gifts", 5.50, 20, ["Default"]],
]

export const SHOWCASE_PRODUCTS = CATALOGUE.map(([handle, title, category, price, stock, sizes, image], index) => ({
  title, handle: `showcase-${handle}`, category, status: ProductStatus.PUBLISHED,
  thumbnail: image ? `${IMAGE_ROOT}/${image}` : undefined,
  images: image ? [{ url: `${IMAGE_ROOT}/${image}` }] : [],
  options: [{ title: sizes.length > 1 ? "Size" : "Variant", values: sizes }],
  variants: sizes.map((size, variantIndex) => {
    const body = `21${String(index + 1).padStart(5, "0")}${String(variantIndex).padStart(5, "0")}`
    const sum = [...body].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0)
    return {
      title: size, sku: `SHOW-${handle.toUpperCase()}-${size.toUpperCase()}`,
      barcode: body + (10 - sum % 10) % 10, stock,
      manage_inventory: true, allow_backorder: false,
      options: { [sizes.length > 1 ? "Size" : "Variant"]: size },
      prices: [{ currency_code: "eur", amount: price }],
    }
  }),
}))

// Invented demonstration identities, with reserved example.com addresses.
export const SHOWCASE_CUSTOMERS = [
  { first_name: "Ada", last_name: "Meadowbrook", email: "ada.meadowbrook@example.com" },
  { first_name: "Milo", last_name: "Fernvale", email: "milo.fernvale@example.com" },
  { first_name: "Nora", last_name: "Willowmere", email: "nora.willowmere@example.com" },
  { first_name: "Theo", last_name: "Cloverfield", email: "theo.cloverfield@example.com" },
  { first_name: "Lina", last_name: "Birchhaven", email: "lina.birchhaven@example.com" },
  { first_name: "Otis", last_name: "Mapleglen", email: "otis.mapleglen@example.com" },
  { first_name: "Esme", last_name: "Pebbleford", email: "esme.pebbleford@example.com" },
  { first_name: "Finn", last_name: "Mossgrove", email: "finn.mossgrove@example.com" },
]
export const SHOWCASE_ORDERS = [
  { key: "showcase-1", email: "ada.meadowbrook@example.com", created_at: "2026-09-20T10:00:00Z", lines: [{ sku: "SHOW-HOUSE-BEANS-DEFAULT", quantity: 1 }, { sku: "SHOW-CROISSANT-DEFAULT", quantity: 2 }] },
  { key: "showcase-2", email: "milo.fernvale@example.com", created_at: "2026-09-23T14:30:00Z", lines: [{ sku: "SHOW-BLACK-TEE-M", quantity: 1 }] },
  { key: "showcase-3", email: "nora.willowmere@example.com", created_at: "2026-09-27T11:15:00Z", lines: [{ sku: "SHOW-MUG-DEFAULT", quantity: 1 }, { sku: "SHOW-EARL-GREY-DEFAULT", quantity: 1 }] },
  { key: "showcase-4", email: "theo.cloverfield@example.com", created_at: "2026-10-01T16:00:00Z", lines: [{ sku: "SHOW-NOTEBOOK-DEFAULT", quantity: 2 }, { sku: "SHOW-COOKIE-DEFAULT", quantity: 2 }] },
]

export default async function seedDemoShowcase({ container }: ExecArgs) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const [store] = await container.resolve(Modules.STORE).listStores()
  const [profile] = await container.resolve(Modules.FULFILLMENT).listShippingProfiles({ type: "default" })
  const [region] = await container.resolve(Modules.REGION).listRegions({ name: "Europe" })
  const { data: [channel] } = await query.graph({
    entity: "sales_channel", fields: ["id", "stock_locations.id"], filters: { id: store.default_sales_channel_id! },
  })
  const locationId = channel.stock_locations![0]!.id
  const productService = container.resolve(Modules.PRODUCT)
  let categories = await productService.listProductCategories({}, { take: 100 })
  const missingCategories = SHOWCASE_CATEGORIES.filter(name => !categories.some(category => category.name === name))
  if (missingCategories.length) {
    await createProductCategoriesWorkflow(container).run({ input: {
      product_categories: missingCategories.map(name => ({ name, is_active: true })),
    } })
    categories = await productService.listProductCategories({}, { take: 100 })
  }
  const existingProducts = await productService.listProducts({ handle: SHOWCASE_PRODUCTS.map(product => product.handle) }, { take: 100 })
  const missingProducts = SHOWCASE_PRODUCTS.filter(product => !existingProducts.some(existing => existing.handle === product.handle))
  if (missingProducts.length) await createProductsWorkflow(container).run({ input: {
    products: missingProducts.map(({ category, variants, ...product }) => ({
      ...product, shipping_profile_id: profile.id, sales_channels: [{ id: channel.id }],
      category_ids: [categories.find(existing => existing.name === category)!.id],
      variants: variants.map(({ stock, ...variant }) => variant),
    })),
  } })
  const stockPlan = new Map(SHOWCASE_PRODUCTS.flatMap(product => product.variants.map(variant => [variant.sku, variant.stock] as const)))
  const inventory = container.resolve(Modules.INVENTORY)
  const items = await inventory.listInventoryItems({ sku: [...stockPlan.keys()] }, { take: 100 })
  const levels = await inventory.listInventoryLevels({ location_id: locationId }, { take: 1000 })
  const missingLevels = items.filter(item => !levels.some(level => level.inventory_item_id === item.id))
  if (missingLevels.length) await createInventoryLevelsWorkflow(container).run({ input: {
    inventory_levels: missingLevels.map(item => ({
      inventory_item_id: item.id, location_id: locationId, stocked_quantity: stockPlan.get(item.sku!)!,
    })),
  } })
  const customerService = container.resolve(Modules.CUSTOMER)
  let customers = await customerService.listCustomers({ email: SHOWCASE_CUSTOMERS.map(customer => customer.email) })
  const missingCustomers = SHOWCASE_CUSTOMERS.filter(customer => !customers.some(existing => existing.email === customer.email))
  if (missingCustomers.length) {
    await createCustomersWorkflow(container).run({ input: { customersData: missingCustomers } })
    customers = await customerService.listCustomers({ email: SHOWCASE_CUSTOMERS.map(customer => customer.email) })
  }
  const { data: variants } = await query.graph({
    entity: "product_variant", fields: ["id", "sku", "product.title"], filters: { sku: [...stockPlan.keys()] },
  })
  const { data: orders } = await query.graph({ entity: "order", fields: ["metadata"] })
  for (const order of SHOWCASE_ORDERS) {
    if (orders.some(existing => existing.metadata?.showcase_order === order.key)) continue
    await createOrderWorkflow(container).run({ input: {
      region_id: region.id, sales_channel_id: channel.id, currency_code: "eur", status: "completed",
      customer_id: customers.find(customer => customer.email === order.email)!.id, email: order.email,
      created_at: new Date(order.created_at), metadata: { showcase_order: order.key },
      items: order.lines.map(line => {
        const variant = variants.find(existing => existing.sku === line.sku)!
        const data = SHOWCASE_PRODUCTS.flatMap(product => product.variants).find(existing => existing.sku === line.sku)!
        return { variant_id: variant.id, title: variant.product!.title, quantity: line.quantity, unit_price: data.prices[0].amount, is_tax_inclusive: true }
      }),
    } as never })
  }
  container.resolve(ContainerRegistrationKeys.LOGGER).info("Showcase ready: 26 products, 8 customers, 4 historic orders.")
}
