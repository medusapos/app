export const BRANDS: Record<string, string[]> = {
  Apparel: [
    "Alderloom", "Veycroft", "Marnwick", "Tarnwell", "Orriven", "Fenroan", "Belthorn",
  ],
  "Home & Kitchen": [
    "Hearthmere", "Clayhaven", "Glazewick", "Oaklune", "Wrenkiln", "Brimvale", "Mossvane",
  ],
  Pantry: [
    "Oatmere", "Bramblefen", "Kettlewyn", "Roastvale", "Saffronwick", "Grainlark", "Orchardell",
  ],
  Beauty: [
    "Petalwyn", "Dewmere", "Fernelle", "Bloomvane", "Oatlune", "Mallowick", "Rosethen",
  ],
  Stationery: [
    "Quillmere", "Foliofen", "Nibwick", "Inklune", "Paperwyn", "Scribvale", "Vellorin",
  ],
  Electronics: [
    "Voltwick", "Lumivane", "Cirqwell", "Ampmere", "Fluxwyn", "Ohmvale", "Wattfen",
  ],
}

const MODEL_DESIGNATIONS = ["No. 2", "Mk II", "Pro", "Mini", "XL", "Classic"]

export function productTitles(
  items: Array<{ department: string; adjectives: string[]; noun: string }>
): string[] {
  const used = new Set<string>()
  return items.map(({ department, adjectives, noun }, index) => {
    const brands = BRANDS[department]
    const brand = brands[index % brands.length]
    const adjective = adjectives[Math.floor(index / brands.length) % adjectives.length]
    const base = `${brand} ${adjective} ${noun}`
    let title = base
    let modelIndex = 0
    while (used.has(title)) {
      const model = MODEL_DESIGNATIONS[modelIndex] ?? `No. ${modelIndex - MODEL_DESIGNATIONS.length + 3}`
      title = `${base} ${model}`
      modelIndex++
    }
    used.add(title)
    return title
  })
}
