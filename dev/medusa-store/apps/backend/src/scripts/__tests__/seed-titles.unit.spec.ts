import { BRANDS, productTitles } from "../seed-titles"

describe("productTitles", () => {
  const examples = [
    { department: "Apparel", adjectives: ["Heavyweight", "Woven"], noun: "Tee" },
    { department: "Home & Kitchen", adjectives: ["Speckled", "Glazed"], noun: "Mug" },
    { department: "Pantry", adjectives: ["Roasted", "Organic"], noun: "Coffee Beans" },
    { department: "Beauty", adjectives: ["Botanical", "Oat"], noun: "Bar Soap" },
    { department: "Stationery", adjectives: ["Archival", "Linen"], noun: "Fountain Pen" },
    { department: "Electronics", adjectives: ["Braided", "Travel"], noun: "USB-C Cable" },
  ]

  it("returns 2000 distinct, deterministic titles with brands, descriptors and nouns", () => {
    const items = Array.from({ length: 2000 }, (_, index) => examples[index % examples.length])
    const titles = productTitles(items)

    expect(titles).toHaveLength(2000)
    expect(new Set(titles).size).toBe(2000)
    expect(productTitles(items)).toEqual(titles)
    titles.forEach((title, index) => {
      const item = items[index]
      expect(BRANDS[item.department].some((brand) => title.startsWith(`${brand} `))).toBe(true)
      expect(item.adjectives.some((adjective) => title.includes(` ${adjective} ${item.noun}`))).toBe(true)
      expect(title).toMatch(new RegExp(` ${item.noun}( (No\\. \\d+|Mk II|Pro|Mini|XL|Classic))?$`))
      expect(title).not.toContain("undefined")
    })
  })

  it("provides six to eight distinct brands for every department", () => {
    expect(Object.keys(BRANDS).sort()).toEqual(examples.map((item) => item.department).sort())
    Object.values(BRANDS).forEach((brands) => {
      expect(brands.length).toBeGreaterThanOrEqual(6)
      expect(brands.length).toBeLessThanOrEqual(8)
      expect(new Set(brands).size).toBe(brands.length)
    })
  })

  it("tries fixed model designations in order before continuing with numbers", () => {
    const item = { department: "Apparel", adjectives: ["Heavyweight"], noun: "Tee" }
    const suffixes = ["", " No. 2", " Mk II", " Pro", " Mini", " XL", " Classic", " No. 3", " No. 4"]
    const brandCount = BRANDS.Apparel.length
    const titles = productTitles(Array.from({ length: brandCount * suffixes.length }, () => item))

    expect(suffixes.map((_, index) => titles[index * brandCount])).toEqual(
      suffixes.map((suffix) => `${BRANDS.Apparel[0]} Heavyweight Tee${suffix}`)
    )
  })
})
