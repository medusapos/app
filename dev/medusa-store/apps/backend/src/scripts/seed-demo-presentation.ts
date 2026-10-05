import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { updateRegionsWorkflow, updateStoresWorkflow } from "@medusajs/medusa/core-flows"

// Matches the /demo page's wording.
export const DEMO_STORE_NAME = 'Medusa POS demo store'

export default async function seedDemoPresentation({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const [store] = await container.resolve(Modules.STORE).listStores()
  if (!store) throw new Error("Missing store for demo presentation")
  const [region] = await container.resolve(Modules.REGION).listRegions({ name: "Europe" })
  if (!region) throw new Error("Missing Europe region for demo presentation")

  await updateStoresWorkflow(container).run({ input: {
    selector: { id: store.id }, update: { name: DEMO_STORE_NAME },
  } })
  await updateRegionsWorkflow(container).run({ input: {
    selector: { id: region.id }, update: { is_tax_inclusive: true },
  } })
  logger.info(`Renamed store to "${DEMO_STORE_NAME}" and set Europe prices to include VAT.`)
}
