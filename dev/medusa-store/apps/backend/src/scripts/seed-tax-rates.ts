/**
 * Seed missing default VAT rates for the dev store's Europe tax regions.
 * Existing default rates are left unchanged, so this is safe to re-run.
 *
 *   npx medusa exec ./src/scripts/seed-tax-rates.ts
 */
import { createTaxRatesWorkflow } from '@medusajs/medusa/core-flows'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import type { ExecArgs } from '@medusajs/framework/types'
import { missingDefaultTaxRates } from './tax-rates'

export default async function seedTaxRates({ container }: ExecArgs) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const { data: regions } = await query.graph({
    entity: 'tax_region',
    fields: [
      'id', 'country_code', 'province_code', 'parent_id',
      'tax_rates.id', 'tax_rates.is_default',
    ],
  })
  const input = missingDefaultTaxRates(regions)
  if (input.length) {
    await createTaxRatesWorkflow(container).run({ input })
  }
  logger.info(input.length ? `Created ${input.length} default VAT rates.` : 'No default VAT rates were missing.')
}
