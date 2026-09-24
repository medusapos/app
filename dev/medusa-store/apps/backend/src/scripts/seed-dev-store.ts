/**
 * TallyUI dev-store seed: a realistic mixed-retail catalogue for POS testing.
 *
 *   npx medusa exec ./src/scripts/seed-dev-store.ts
 *
 * Creates ~2,000 products across a two-level category tree, collections, shared
 * options, EUR + USD prices, an active sale price list, SKUs and EAN-13
 * barcodes, inventory levels, ~2,000 customers and a few hundred orders.
 *
 * Deterministic: every record is derived from its index through a seeded PRNG,
 * so a rebuild from scratch (scripts/reset.sh) yields the same catalogue.
 * Re-running on an existing store only fills in what is missing (products by
 * handle, customers by email, orders up to ORDER_COUNT).
 *
 * Runs after the template's initial-data-seed migration script, which creates
 * the store, region, sales channel, stock location and shared Size/Color
 * options this script builds on.
 */
import {
  createCollectionsWorkflow,
  createCustomersWorkflow,
  createInventoryLevelsWorkflow,
  createOrderWorkflow,
  createPriceListsWorkflow,
  createProductCategoriesWorkflow,
  createProductOptionsWorkflow,
  createProductsWorkflow,
} from '@medusajs/medusa/core-flows'
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
  ProductStatus,
} from '@medusajs/framework/utils'
import type { ExecArgs, PriceDTO } from '@medusajs/framework/types'
import { productTitles } from "./seed-titles"

const PRODUCT_COUNT = 2000
const CUSTOMER_COUNT = 2000
const ORDER_COUNT = 300
const HANDLE_PREFIX = 'tally'
/** Roughly one product in eight is in the sale price list. */
const SALE_RATE = 0.125
const PRODUCT_BATCH = 50
const CUSTOMER_BATCH = 200
/** Products per awaited search-ingestion call. */
const INGEST_CHUNK_SIZE = 100

/** Deterministic PRNG (mulberry32). */
function makeRandom(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A PRNG per record, so skipping existing records never shifts the others. */
const randomFor = (kind: number, index: number) => makeRandom(kind * 1_000_003 + index)

/** EAN-13 with a valid check digit, from a 12-digit body. */
function ean13(body: string) {
  const sum = body
    .split('')
    .reduce((acc, digit, i) => acc + Number(digit) * (i % 2 === 0 ? 1 : 3), 0)
  return body + ((10 - (sum % 10)) % 10)
}

// ---- Catalogue shape --------------------------------------------------------

type OptionSpec = { title: string; values: string[] }

/** Shared options beyond the template's Size and Color. */
const EXTRA_OPTIONS: OptionSpec[] = [
  { title: 'Shoe Size', values: ['38', '39', '40', '41', '42', '43', '44', '45'] },
  { title: 'Weight', values: ['250g', '500g', '1kg'] },
  { title: 'Scent', values: ['Lavender', 'Cedar', 'Citrus', 'Unscented'] },
  { title: 'Length', values: ['1m', '2m', '3m'] },
  { title: 'Finish', values: ['Matte', 'Gloss', 'Natural'] },
]

type ProductType = {
  noun: string
  /** Shared option titles; empty means a single-variant (simple) product. */
  options: string[][]
  /** Price range in major units (EUR). */
  price: [number, number]
  /** Photos that actually show this kind of product; none means no image. */
  images?: string[]
}

type Department = {
  name: string
  children: { name: string; types: ProductType[] }[]
  adjectives: string[]
}

const MEDUSA_IMG = 'https://medusa-public-images.s3.eu-west-1.amazonaws.com'

const DEPARTMENTS: Department[] = [
  {
    name: 'Apparel',
    adjectives: ['Classic', 'Relaxed', 'Heritage', 'Everyday', 'Organic', 'Heavyweight', 'Vintage'],
    children: [
      { name: 'Tops', types: [
        { noun: 'Tee', options: [['Size', 'Color'], ['Size']], price: [15, 35], images: [`${MEDUSA_IMG}/tee-black-front.png`, `${MEDUSA_IMG}/tee-white-front.png`] },
        { noun: 'Hoodie', options: [['Size', 'Color']], price: [45, 85], images: [`${MEDUSA_IMG}/sweatshirt-vintage-front.png`] },
        { noun: 'Sweatshirt', options: [['Size']], price: [40, 70], images: [`${MEDUSA_IMG}/sweatshirt-vintage-front.png`] },
      ] },
      { name: 'Bottoms', types: [
        { noun: 'Joggers', options: [['Size']], price: [35, 65], images: [`${MEDUSA_IMG}/sweatpants-gray-front.png`] },
        { noun: 'Shorts', options: [['Size'], ['Size', 'Color']], price: [25, 45], images: [`${MEDUSA_IMG}/shorts-vintage-front.png`] },
      ] },
      { name: 'Accessories', types: [
        { noun: 'Cap', options: [[], ['Color']], price: [18, 30] },
        { noun: 'Beanie', options: [[]], price: [15, 25] },
        { noun: 'Socks (3 pack)', options: [['Size']], price: [9, 16] },
      ] },
      { name: 'Footwear', types: [
        { noun: 'Sneaker', options: [['Shoe Size']], price: [60, 140] },
        { noun: 'Sandal', options: [['Shoe Size']], price: [30, 70] },
      ] },
    ],
  },
  {
    name: 'Home & Kitchen',
    adjectives: ['Stoneware', 'Handmade', 'Nordic', 'Speckled', 'Enamel', 'Oak', 'Recycled'],
    children: [
      { name: 'Drinkware', types: [
        { noun: 'Mug', options: [[], ['Finish']], price: [9, 24], images: [`${MEDUSA_IMG}/coffee-mug.png`] },
        { noun: 'Tumbler', options: [[]], price: [12, 28] },
      ] },
      { name: 'Candles', types: [
        { noun: 'Candle', options: [['Scent']], price: [14, 38] },
      ] },
      { name: 'Cookware', types: [
        { noun: 'Skillet', options: [[]], price: [35, 120] },
        { noun: 'Cutting Board', options: [[], ['Finish']], price: [20, 65] },
      ] },
    ],
  },
  {
    name: 'Pantry',
    adjectives: ['Single-Origin', 'Organic', 'Small-Batch', 'House', 'Fairtrade', 'Smoked'],
    children: [
      { name: 'Coffee', types: [
        { noun: 'Coffee Beans', options: [['Weight']], price: [8, 22] },
        { noun: 'Ground Coffee', options: [['Weight'], []], price: [7, 18] },
      ] },
      { name: 'Tea', types: [{ noun: 'Loose Leaf Tea', options: [[], ['Weight']], price: [6, 16] }] },
      { name: 'Snacks', types: [
        { noun: 'Chocolate Bar', options: [[]], price: [2, 6] },
        { noun: 'Granola', options: [[], ['Weight']], price: [5, 11] },
        { noun: 'Crackers', options: [[]], price: [3, 7] },
      ] },
    ],
  },
  {
    name: 'Beauty',
    adjectives: ['Botanical', 'Sea Salt', 'Oat', 'Charcoal', 'Rosewater', 'Shea'],
    children: [
      { name: 'Bath', types: [
        { noun: 'Bar Soap', options: [['Scent'], []], price: [5, 12] },
        { noun: 'Bath Salts', options: [['Scent']], price: [9, 19] },
      ] },
      { name: 'Skincare', types: [
        { noun: 'Hand Cream', options: [[], ['Scent']], price: [8, 24] },
        { noun: 'Lip Balm', options: [[]], price: [3, 8] },
      ] },
    ],
  },
  {
    name: 'Stationery',
    adjectives: ['Dot Grid', 'Recycled', 'Linen', 'Pocket', 'Archival', 'Kraft'],
    children: [
      { name: 'Paper', types: [
        { noun: 'Notebook', options: [[], ['Color']], price: [6, 24] },
        { noun: 'Greeting Card', options: [[]], price: [3, 6] },
      ] },
      { name: 'Writing', types: [
        { noun: 'Gel Pen', options: [[], ['Color']], price: [2, 5] },
        { noun: 'Fountain Pen', options: [[]], price: [25, 90] },
      ] },
    ],
  },
  {
    name: 'Electronics',
    adjectives: ['Braided', 'Compact', 'Fast-Charge', 'Travel', 'Pro', 'Wireless'],
    children: [
      { name: 'Cables', types: [{ noun: 'USB-C Cable', options: [['Length']], price: [8, 25] }] },
      { name: 'Power', types: [
        { noun: 'Charger', options: [[]], price: [19, 59] },
        { noun: 'Power Bank', options: [[], ['Color']], price: [25, 79] },
      ] },
      { name: 'Audio', types: [{ noun: 'Earbuds', options: [[], ['Color']], price: [29, 149] }] },
    ],
  },
]

const DEFAULT_OPTION = { title: 'Default option', values: ['Default option value'] }
const DEFAULT_VARIANT_OPTIONS = { 'Default option': 'Default option value' }

const COLLECTIONS = ['New Arrivals', 'Staff Picks', 'Gift Ideas', 'Bestsellers', 'Local Makers', 'Clearance']
/** Rate to derive USD from EUR prices. */
const USD_PER_EUR = 1.1

const FIRST_NAMES = [
  'Olivia', 'Liam', 'Emma', 'Noah', 'Ava', 'Oliver', 'Sophia', 'Elijah', 'Mia', 'Lucas',
  'Amelia', 'Mateo', 'Harper', 'Levi', 'Aisha', 'Kenji', 'Priya', 'Tomás', 'Freya', 'Kofi',
  'Ingrid', 'Rafael', 'Mei', 'Omar', 'Chloé', 'Sven', 'Zara', 'Diego', 'Hana', 'Niamh',
]
const LAST_NAMES = [
  'Smith', 'Müller', 'García', 'Rossi', 'Jensen', 'Dubois', 'Nguyen', 'Kowalski', 'Andersson',
  'Murphy', 'Okafor', 'Tanaka', 'Silva', 'Novak', 'Schmidt', 'Hansen', 'Moreau', 'Bianchi',
  'Fernández', 'Lindqvist', 'Walsh', 'Kim', 'Patel', 'Cohen', 'Berg',
]
const CITIES: [string, string, string][] = [
  ['dk', 'Copenhagen', '1050'], ['de', 'Berlin', '10115'], ['fr', 'Lyon', '69001'],
  ['es', 'Valencia', '46001'], ['it', 'Milan', '20121'], ['se', 'Malmö', '21120'],
  ['gb', 'Manchester', 'M1 1AE'],
]
const STREETS = ['High Street', 'Market Square', 'Station Road', 'Harbour Lane', 'Mill Road', 'Church Street']

// ---- Script -----------------------------------------------------------------

export default async function seedDevStore({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: salesChannels } = await query.graph({ entity: 'sales_channel', fields: ['id'] })
  const { data: shippingProfiles } = await query.graph({ entity: 'shipping_profile', fields: ['id'] })
  const { data: stockLocations } = await query.graph({ entity: 'stock_location', fields: ['id'] })
  const { data: regions } = await query.graph({ entity: 'region', fields: ['id', 'currency_code'] })
  const salesChannel = salesChannels[0]
  const shippingProfile = shippingProfiles[0]
  const stockLocation = stockLocations[0]
  const region = regions[0]
  if (!salesChannel || !shippingProfile || !stockLocation || !region) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'Missing sales channel, shipping profile, stock location or region. Run `medusa db:migrate` first.'
    )
  }

  // ---- Shared options ------------------------------------------------------

  const loadOptions = async () => {
    const { data } = await query.graph({
      entity: 'product_option',
      fields: ['id', 'title', 'values.value'],
      filters: { is_exclusive: false },
    })
    return new Map(
      data.map((o) => [
        o.title as string,
        { id: o.id as string, values: (o.values ?? []).map((v) => v!.value as string) },
      ])
    )
  }
  let options = await loadOptions()
  const missingOptions = EXTRA_OPTIONS.filter((o) => !options.has(o.title))
  if (missingOptions.length) {
    await createProductOptionsWorkflow(container).run({ input: { product_options: missingOptions } })
    options = await loadOptions()
  }

  // ---- Category tree -------------------------------------------------------

  const loadCategories = async () => {
    const { data } = await query.graph({ entity: 'product_category', fields: ['id', 'name'] })
    return new Map(data.map((c) => [c.name as string, c.id as string]))
  }
  let categories = await loadCategories()
  const missingParents = DEPARTMENTS.filter((d) => !categories.has(d.name))
  if (missingParents.length) {
    await createProductCategoriesWorkflow(container).run({
      input: { product_categories: missingParents.map((d) => ({ name: d.name, is_active: true })) },
    })
    categories = await loadCategories()
  }
  const missingChildren = DEPARTMENTS.flatMap((d) =>
    d.children
      .filter((c) => !categories.has(c.name))
      .map((c) => ({ name: c.name, is_active: true, parent_category_id: categories.get(d.name)! }))
  )
  if (missingChildren.length) {
    await createProductCategoriesWorkflow(container).run({ input: { product_categories: missingChildren } })
    categories = await loadCategories()
  }

  // ---- Collections ---------------------------------------------------------

  const loadCollections = async () => {
    const { data } = await query.graph({ entity: 'product_collection', fields: ['id', 'title'] })
    return new Map(data.map((c) => [c.title as string, c.id as string]))
  }
  let collections = await loadCollections()
  const missingCollections = COLLECTIONS.filter((t) => !collections.has(t))
  if (missingCollections.length) {
    await createCollectionsWorkflow(container).run({
      input: { collections: missingCollections.map((title) => ({ title })) },
    })
    collections = await loadCollections()
  }

  // ---- Products ------------------------------------------------------------

  const { data: existingProducts } = await query.graph({ entity: 'product', fields: ['handle'] })
  const takenHandles = new Set(existingProducts.map((p) => p.handle))

  const leaves = DEPARTMENTS.flatMap((dept) =>
    dept.children.flatMap((child) => child.types.map((type) => ({ dept, child, type })))
  )
  const titles = productTitles(Array.from({ length: PRODUCT_COUNT }, (_, i) => {
    const { dept, type } = leaves[i % leaves.length]
    return { department: dept.name, adjectives: dept.adjectives, noun: type.noun }
  }))

  /** Stock plan per SKU, applied once the inventory items exist. */
  const stockPlan = new Map<string, number>()
  const products: Record<string, unknown>[] = []

  for (let index = 0; index < PRODUCT_COUNT; index++) {
    const random = randomFor(1, index)
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]
    const { dept, child, type } = leaves[index % leaves.length]
    const handle = `${HANDLE_PREFIX}-${String(index + 1).padStart(4, '0')}`
    if (takenHandles.has(handle)) continue

    const title = titles[index]
    const optionTitles = pick(type.options)
    const base = type.price[0] + Math.floor(random() * (type.price[1] - type.price[0] + 1))
    const eur = base - 0.01
    const usd = Math.round(base * USD_PER_EUR) - 0.01

    // Stock profile: mostly stocked, some low/zero, some untracked, some backorder.
    const roll = random()
    const manageInventory = roll >= 0.08
    const allowBackorder = roll >= 0.08 && roll < 0.12
    const stockFor = () => {
      const r = random()
      if (r < 0.07) return 0
      if (r < 0.2) return 1 + Math.floor(random() * 4)
      return 5 + Math.floor(random() * 120)
    }

    let combos: Record<string, string>[] = [{}]
    for (const optionTitle of optionTitles) {
      const option = options.get(optionTitle)!
      combos = combos.flatMap((combo) => option.values.map((v) => ({ ...combo, [optionTitle]: v })))
    }

    const sku = `TLY-${String(index + 1).padStart(5, '0')}`
    const image = type.images?.length && random() < 0.85 ? pick(type.images) : undefined
    const collectionTitle = random() < 0.6 ? pick(COLLECTIONS) : undefined

    products.push({
      title,
      handle,
      description: `${title} from our ${child.name.toLowerCase()} range. Seeded dev-store data, not a real product.`,
      status: random() < 0.97 ? ProductStatus.PUBLISHED : ProductStatus.DRAFT,
      thumbnail: image,
      images: image ? [{ url: image }] : [],
      weight: 50 + Math.floor(random() * 900),
      shipping_profile_id: shippingProfile.id,
      collection_id: collectionTitle ? collections.get(collectionTitle) : undefined,
      category_ids: [categories.get(child.name)!],
      sales_channels: [{ id: salesChannel.id }],
      // Medusa requires at least one option; simple products get its usual
      // product-scoped "Default option".
      options: optionTitles.length
        ? optionTitles.map((t) => ({ id: options.get(t)!.id }))
        : [DEFAULT_OPTION],
      variants: combos.map((combo, v) => {
        const values = Object.values(combo)
        const variantSku = values.length
          ? `${sku}-${values.join('-').toUpperCase().replace(/[^A-Z0-9]+/g, '')}`
          : sku
        if (manageInventory) stockPlan.set(variantSku, stockFor())
        return {
          title: values.length ? values.join(' / ') : 'Default',
          sku: variantSku,
          barcode: ean13(`20${String(index + 1).padStart(5, '0')}${String(v).padStart(5, '0')}`),
          manage_inventory: manageInventory,
          allow_backorder: allowBackorder,
          options: values.length ? combo : DEFAULT_VARIANT_OPTIONS,
          prices: [
            { amount: eur, currency_code: 'eur' },
            { amount: usd, currency_code: 'usd' },
          ],
        }
      }),
    })
  }

  // A known fixture like WooCommerce's `woo-belt`: simple, untracked, always sellable.
  if (!takenHandles.has(`${HANDLE_PREFIX}-fixture-mug`)) {
    products.push({
      title: 'Fixture Mug',
      handle: `${HANDLE_PREFIX}-fixture-mug`,
      description: 'Stable E2E fixture: simple product, inventory not managed. Do not edit.',
      status: ProductStatus.PUBLISHED,
      thumbnail: `${MEDUSA_IMG}/coffee-mug.png`,
      images: [{ url: `${MEDUSA_IMG}/coffee-mug.png` }],
      shipping_profile_id: shippingProfile.id,
      category_ids: [categories.get('Drinkware')!],
      sales_channels: [{ id: salesChannel.id }],
      options: [DEFAULT_OPTION],
      variants: [{
        title: 'Default',
        sku: 'TLY-FIXTURE-MUG',
        options: DEFAULT_VARIANT_OPTIONS,
        barcode: ean13('200000000000'),
        manage_inventory: false,
        prices: [{ amount: 12, currency_code: 'eur' }, { amount: 13, currency_code: 'usd' }],
      }],
    })
  }

  for (let start = 0; start < products.length; start += PRODUCT_BATCH) {
    await createProductsWorkflow(container).run({
      input: { products: products.slice(start, start + PRODUCT_BATCH) as never },
    })
    logger.info(`Products: ${Math.min(start + PRODUCT_BATCH, products.length)}/${products.length}`)
  }

  // ---- Inventory levels ----------------------------------------------------

  if (stockPlan.size) {
    const { data: variants } = await query.graph({
      entity: 'product_variant',
      fields: ['sku', 'inventory_items.inventory_item_id'],
      filters: { sku: [...stockPlan.keys()] },
    })
    const levels = variants.flatMap((variant) =>
      (variant.inventory_items ?? []).map((link) => ({
        location_id: stockLocation.id,
        inventory_item_id: link!.inventory_item_id as string,
        stocked_quantity: stockPlan.get(variant.sku as string) ?? 0,
      }))
    )
    for (let start = 0; start < levels.length; start += 500) {
      await createInventoryLevelsWorkflow(container).run({
        input: { inventory_levels: levels.slice(start, start + 500) },
      })
    }
    logger.info(`Inventory levels: ${levels.length}`)
  }

  // ---- Sale price list -----------------------------------------------------

  const { data: priceLists } = await query.graph({ entity: 'price_list', fields: ['id', 'title'] })
  if (!priceLists.some((p) => p.title === 'Dev Store Sale')) {
    const { data: saleVariants } = await query.graph({
      entity: 'product_variant',
      fields: ['id', 'sku', 'prices.amount', 'prices.currency_code', 'product.handle'],
      filters: { sku: { $like: 'TLY-%' } },
    })
    const saleHandles = new Set<string>()
    for (let index = 0; index < PRODUCT_COUNT; index++) {
      if (randomFor(2, index)() < SALE_RATE) {
        saleHandles.add(`${HANDLE_PREFIX}-${String(index + 1).padStart(4, '0')}`)
      }
    }
    // Generated ProductVariant types omit the runtime `prices` link alias.
    // Type only the price fields requested by these queries at their reads.
    const prices = saleVariants
      .filter((v) => saleHandles.has(v.product?.handle as string))
      .flatMap((v) =>
        ((v as typeof v & {
          prices?: (Pick<PriceDTO, "amount" | "currency_code"> | null)[] | null
        }).prices ?? []).map((p) => ({
          variant_id: v.id as string,
          currency_code: p!.currency_code as string,
          // 20% off, rounded to a .99 ending.
          amount: Math.max(0.99, Math.floor(Number(p!.amount) * 0.8) - 0.01),
        }))
      )
    await createPriceListsWorkflow(container).run({
      input: {
        price_lists_data: [{
          title: 'Dev Store Sale',
          description: '20% off roughly one product in eight.',
          type: 'sale',
          status: 'active',
          prices,
          // `type` is accepted at runtime but missing from the 2.21.0 DTO type.
        } as never],
      },
    })
    logger.info(`Sale price list: ${prices.length} prices over ${saleHandles.size} products`)
  }

  // ---- Customers -----------------------------------------------------------

  const { data: existingCustomers } = await query.graph({ entity: 'customer', fields: ['email'] })
  const takenEmails = new Set(existingCustomers.map((c) => c.email))
  const customers: Record<string, unknown>[] = []
  for (let index = 0; index < CUSTOMER_COUNT; index++) {
    const random = randomFor(3, index)
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]
    const first = pick(FIRST_NAMES)
    const last = pick(LAST_NAMES)
    const email = `customer${String(index + 1).padStart(4, '0')}@tally.test`
    if (takenEmails.has(email)) continue
    const [country, city, postal] = pick(CITIES)
    const hasAddress = random() < 0.7
    customers.push({
      first_name: first,
      last_name: last,
      email,
      phone: random() < 0.6 ? `+45 ${20000000 + Math.floor(random() * 79999999)}` : undefined,
      company_name: random() < 0.1 ? `${last} & Co` : undefined,
      addresses: hasAddress
        ? [{
            first_name: first,
            last_name: last,
            address_1: `${1 + Math.floor(random() * 180)} ${pick(STREETS)}`,
            city,
            postal_code: postal,
            country_code: country,
            is_default_shipping: true,
            is_default_billing: true,
          }]
        : [],
    })
  }
  for (let start = 0; start < customers.length; start += CUSTOMER_BATCH) {
    await createCustomersWorkflow(container).run({
      input: { customersData: customers.slice(start, start + CUSTOMER_BATCH) as never },
    })
    logger.info(`Customers: ${Math.min(start + CUSTOMER_BATCH, customers.length)}/${customers.length}`)
  }

  // ---- Historical orders ---------------------------------------------------

  const { data: existingOrders } = await query.graph({ entity: 'order', fields: ['id'] })
  if (existingOrders.length < ORDER_COUNT) {
    // Only untracked or well-stocked variants, so inventory validation passes.
    const { data: sellable } = await query.graph({
      entity: 'product_variant',
      fields: [
        'id', 'sku', 'manage_inventory', 'prices.amount', 'prices.currency_code',
        'product.title', 'product.status',
        'inventory_items.inventory.location_levels.stocked_quantity',
      ],
      filters: { sku: { $like: 'TLY-%' } },
    })
    const stocked = (v: (typeof sellable)[number]) =>
      Math.min(
        ...(v.inventory_items ?? []).map((link) =>
          Number(link?.inventory?.location_levels?.[0]?.stocked_quantity ?? 0)
        )
      )
    const pool = sellable
      .filter((v) => v.product?.status === ProductStatus.PUBLISHED)
      .filter((v) => !v.manage_inventory || stocked(v) >= 20)
      .sort((a, b) => String(a.sku).localeCompare(String(b.sku)))
    const { data: orderCustomers } = await query.graph({
      entity: 'customer',
      fields: ['id', 'email', 'first_name', 'last_name'],
      filters: { email: { $like: '%@tally.test' } },
    })
    orderCustomers.sort((a, b) => String(a.email).localeCompare(String(b.email)))

    for (let index = existingOrders.length; index < ORDER_COUNT; index++) {
      const random = randomFor(4, index)
      const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]
      const customer = random() < 0.75 ? pick(orderCustomers) : undefined
      const lines = 1 + Math.floor(random() * 4)
      const items = Array.from({ length: lines }, () => {
        const variant = pick(pool)
        const price = (variant as typeof variant & {
          prices?: (Pick<PriceDTO, "amount" | "currency_code"> | null)[] | null
        }).prices?.find((p) => p?.currency_code === region.currency_code)
        return {
          variant_id: variant.id as string,
          title: variant.product?.title as string,
          quantity: 1 + Math.floor(random() * 3),
          unit_price: Number(price?.amount ?? 10),
        }
      })
      const [country, city, postal] = pick(CITIES)
      await createOrderWorkflow(container).run({
        input: {
          region_id: region.id,
          sales_channel_id: salesChannel.id,
          currency_code: region.currency_code,
          customer_id: customer?.id,
          email: customer?.email ?? `walkin${index + 1}@tally.test`,
          status: 'completed',
          items,
          shipping_address: {
            first_name: customer?.first_name ?? 'Walk-in',
            last_name: customer?.last_name ?? 'Customer',
            address_1: `${1 + Math.floor(random() * 180)} ${pick(STREETS)}`,
            city,
            postal_code: postal,
            country_code: country,
          },
        } as never,
      })
      if ((index + 1) % 50 === 0) logger.info(`Orders: ${index + 1}/${ORDER_COUNT}`)
    }
  }

  // ---- Search index --------------------------------------------------------

  // `medusa exec` can exit before async product.created handlers finish, so
  // replay ingestion. On a fresh database the index has no active version
  // until the server first boots, and the server fills it then.
  const search = container.resolve(Modules.SEARCH)
  const { data: allProducts } = await query.graph({ entity: 'product', fields: ['id'] })
  try {
    for (let start = 0; start < allProducts.length; start += INGEST_CHUNK_SIZE) {
      await search.ingest({
        name: 'product.created',
        data: allProducts.slice(start, start + INGEST_CHUNK_SIZE).map((p) => ({ id: p.id })),
      } as never)
    }
  } catch (error) {
    if (!String((error as Error).message).includes('no active version')) throw error
    logger.info('Search index not active yet; the server seeds it on first boot.')
  }

  logger.info(`Done: ${allProducts.length} products in the store.`)
}
