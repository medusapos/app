/**
 * Seed a product-type tax rule and a de-by province rate for the dev store's de tax region.
 * Run after seed-tax-rates.ts. Existing rows are left unchanged, so this is safe to re-run.
 *
 *   npx medusa exec ./src/scripts/seed-tax-rules.ts
 */
import {
  createProductTypesWorkflow,
  createTaxRatesWorkflow,
  createTaxRegionsWorkflow,
} from '@medusajs/medusa/core-flows'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import type { ExecArgs } from '@medusajs/framework/types'
import { planTaxRules, REDUCED_RATE_PRODUCT_TYPE } from './tax-rates'

export default async function seedTaxRules({ container }: ExecArgs) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const productModule = container.resolve(Modules.PRODUCT)

  let [productType] = await productModule.listProductTypes({ value: REDUCED_RATE_PRODUCT_TYPE })
  if (!productType) {
    const { result } = await createProductTypesWorkflow(container).run({
      input: { product_types: [{ value: REDUCED_RATE_PRODUCT_TYPE }] },
    })
    productType = result[0]
  }

  const { data: regions } = await query.graph({
    entity: 'tax_region',
    fields: [
      'id', 'country_code', 'province_code', 'parent_id',
      'tax_rates.id', 'tax_rates.code', 'tax_rates.is_default',
    ],
  })
  const plan = planTaxRules(regions, productType.id)
  const created: string[] = []
  if (plan.reducedRate) {
    await createTaxRatesWorkflow(container).run({ input: [plan.reducedRate] })
    created.push('reduced DE rate')
  }
  if (plan.provinceRegion) {
    await createTaxRegionsWorkflow(container).run({ input: [plan.provinceRegion] })
    created.push('de-by region')
  }
  if (plan.provinceRate) {
    await createTaxRatesWorkflow(container).run({ input: [plan.provinceRate] })
    created.push('de-by rate')
  }
  logger.info(created.length ? `Created: ${created.join(', ')}.` : 'No tax rules were missing.')
}
