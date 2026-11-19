import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { listCashiers } from '../cashiers'

/** The store's admin users, for the Reports cashier menu; needs only the POS policy, not /admin/users rights. */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  return res.json({ cashiers: await listCashiers(req.scope.resolve(Modules.USER)) })
}
