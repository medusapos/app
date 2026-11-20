/** Standard VAT rates (percent) for the dev store's Europe region countries. */
export const STANDARD_VAT_RATES: Record<string, number> = {
  gb: 20, de: 19, dk: 25, se: 25, fr: 20, es: 21, it: 22,
}

export type TaxRegionRow = {
  id: string
  country_code: string
  province_code?: string | null
  parent_id?: string | null
  tax_rates?: Array<{ id: string; code?: string | null; is_default?: boolean | null } | null> | null
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

/** Product type the reduced-rate rule applies to. */
export const REDUCED_RATE_PRODUCT_TYPE = 'Food'
/** Non-default DE rate, applied to products of the reduced-rate product type. */
export const DE_REDUCED_RATE = { rate: 7, code: 'vat-de-reduced', name: 'DE reduced VAT (Food)' }
/** Province default rate for de-by. */
// Synthetic: differs from DE's 19 so that a province rate visibly overrides the country rate.
export const DE_BY_RATE = { rate: 18, code: 'vat-de-by', name: 'DE-BY VAT' }

export type TaxRulePlan = {
  reducedRate: {
    tax_region_id: string; rate: number; code: string; name: string; is_default: false
    rules: Array<{ reference: string; reference_id: string }>
  } | null
  provinceRegion: {
    country_code: string; province_code: string; parent_id: string
    default_tax_rate: { rate: number; code: string; name: string }
  } | null
  provinceRate: DefaultTaxRateInput | null
}

export function planTaxRules(regions: TaxRegionRow[], productTypeId: string): TaxRulePlan {
  const country = regions.find((r) =>
    r.country_code.toLowerCase() === 'de' && !r.parent_id && !r.province_code)
  if (!country) {
    throw new Error('No de country tax region found; run seed-tax-rates first.')
  }
  const province = regions.find((r) => r.province_code?.toLowerCase() === 'de-by')
  const hasReduced = country.tax_rates?.some((rate) => rate?.code === DE_REDUCED_RATE.code)
  return {
    reducedRate: hasReduced ? null : {
      tax_region_id: country.id, ...DE_REDUCED_RATE, is_default: false,
      rules: [{ reference: 'product_type', reference_id: productTypeId }],
    },
    provinceRegion: province ? null : {
      country_code: 'de', province_code: 'de-by', parent_id: country.id,
      default_tax_rate: { ...DE_BY_RATE },
    },
    provinceRate: province && !province.tax_rates?.some((rate) => rate?.is_default === true)
      ? { tax_region_id: province.id, ...DE_BY_RATE, is_default: true }
      : null,
  }
}
