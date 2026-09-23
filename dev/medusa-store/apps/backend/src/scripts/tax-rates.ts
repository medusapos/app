/** Standard VAT rates (percent) for the dev store's Europe region countries. */
export const STANDARD_VAT_RATES: Record<string, number> = {
  gb: 20, de: 19, dk: 25, se: 25, fr: 20, es: 21, it: 22,
}

export type TaxRegionRow = {
  id: string
  country_code: string
  province_code?: string | null
  parent_id?: string | null
  tax_rates?: Array<{ id: string; is_default?: boolean | null } | null> | null
}

export type DefaultTaxRateInput = {
  tax_region_id: string
  rate: number
  code: string
  name: string
  is_default: true
}

export function missingDefaultTaxRates(regions: TaxRegionRow[]): DefaultTaxRateInput[] {
  const input: DefaultTaxRateInput[] = []
  for (const region of regions) {
    const countryCode = region.country_code.toLowerCase()
    if (region.parent_id || region.province_code ||
      !Object.keys(STANDARD_VAT_RATES).includes(countryCode) ||
      region.tax_rates?.some((rate) => rate?.is_default === true)) {
      continue
    }
    input.push({
      tax_region_id: region.id,
      rate: STANDARD_VAT_RATES[countryCode],
      code: `vat-${countryCode}`,
      name: `${countryCode.toUpperCase()} VAT`,
      is_default: true,
    })
  }
  return input
}
