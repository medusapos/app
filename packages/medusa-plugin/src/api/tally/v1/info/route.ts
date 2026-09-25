import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'

/** The contract versions this plugin accepts, read by TallyUI's Medusa connector at sign-in (ADR-062). */
export async function GET(_req: MedusaRequest, res: MedusaResponse) {
  return res.json({ contracts: { 'order.create': [1, 2] } })
}
