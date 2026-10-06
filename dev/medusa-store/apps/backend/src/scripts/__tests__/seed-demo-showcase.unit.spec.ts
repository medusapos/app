import { SHOWCASE_CATEGORIES, SHOWCASE_CUSTOMERS, SHOWCASE_ORDERS, SHOWCASE_PRODUCTS } from "../seed-demo-showcase"

describe("showcase catalogue", () => {
  it('has 24–28 showcase products across 5–6 categories (its own plus the starter apparel ones it uses), each published with a unique handle', () => {
    expect(SHOWCASE_PRODUCTS.length).toBeGreaterThanOrEqual(24)
    expect(SHOWCASE_PRODUCTS.length).toBeLessThanOrEqual(28)
    const categories = new Set(SHOWCASE_PRODUCTS.map(product => product.category))
    expect(categories.size).toBeGreaterThanOrEqual(5)
    expect(categories.size).toBeLessThanOrEqual(6)
    expect(categories).toEqual(new Set(SHOWCASE_CATEGORIES))
    expect(new Set(SHOWCASE_PRODUCTS.map(product => product.handle)).size).toBe(SHOWCASE_PRODUCTS.length)
    for (const product of SHOWCASE_PRODUCTS) {
      expect(product.handle).toBeTruthy()
      expect(product.status).toBe("published")
    }
  })

  it('every variant has a unique SKU, a unique valid EAN-13 barcode and a positive EUR price', () => {
    const variants = SHOWCASE_PRODUCTS.flatMap(product => product.variants)
    expect(new Set(variants.map(variant => variant.sku)).size).toBe(variants.length)
    expect(new Set(variants.map(variant => variant.barcode)).size).toBe(variants.length)
    for (const variant of variants) {
      expect(variant.sku).toBeTruthy()
      expect(variant.barcode).toMatch(/^\d{13}$/)
      const digits = [...variant.barcode].map(Number)
      const weightedTotal = digits.reduce((total, digit, index) => total + digit * (index % 2 ? 3 : 1), 0)
      expect(weightedTotal % 10).toBe(0)
      const price = variant.prices.find(price => price.currency_code === "eur")
      expect(price?.amount).toBeGreaterThan(0)
      expect([0, 50, 95]).toContain(Math.round(price!.amount * 100) % 100)
    }
  })

  it('at least four products have several variants, and exactly one has no stock', () => {
    const sized = SHOWCASE_PRODUCTS.filter(product => product.variants.length > 1)
    expect(sized.length).toBeGreaterThanOrEqual(4)
    for (const product of sized) {
      expect([2, 3]).toContain(product.variants.length)
      expect(product.options[0].title).toBe("Size")
    }
    expect(SHOWCASE_PRODUCTS.filter(product => product.variants.every(variant => variant.stock === 0))).toHaveLength(1)
    for (const product of SHOWCASE_PRODUCTS) {
      expect(product.variants.length).toBeGreaterThan(0)
      for (const variant of product.variants) expect(variant.stock).toBeGreaterThanOrEqual(0)
    }
  })

  it('8 customers with unique example.com emails and names', () => {
    expect(SHOWCASE_CUSTOMERS).toHaveLength(8)
    expect(new Set(SHOWCASE_CUSTOMERS.map(customer => customer.email)).size).toBe(8)
    expect(new Set(SHOWCASE_CUSTOMERS.map(customer => `${customer.first_name} ${customer.last_name}`)).size).toBe(8)
    for (const customer of SHOWCASE_CUSTOMERS) {
      expect(customer.email).toMatch(/^[^@]+@example\.com$/)
      expect(customer.first_name).toBeTruthy()
      expect(customer.last_name).toBeTruthy()
    }
  })

  it('4 historic orders, each for a showcase customer, with lines naming existing showcase SKUs', () => {
    expect(SHOWCASE_ORDERS).toHaveLength(4)
    expect(new Set(SHOWCASE_ORDERS.map(order => order.key)).size).toBe(4)
    const skus = new Set(SHOWCASE_PRODUCTS.flatMap(product => product.variants.map(variant => variant.sku)))
    for (const order of SHOWCASE_ORDERS) {
      expect(SHOWCASE_CUSTOMERS.some(customer => customer.email === order.email)).toBe(true)
      expect(new Date(order.created_at).getTime()).toBeLessThan(Date.now())
      expect(order.lines.length).toBeGreaterThan(0)
      for (const line of order.lines) {
        expect(skus.has(line.sku)).toBe(true)
        expect(line.quantity).toBeGreaterThan(0)
      }
    }
  })
})
