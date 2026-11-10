import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { TALLY_REGISTER_MODULE } from '../../../../../../modules/tally-register'
import type TallyRegisterModuleService from '../../../../../../modules/tally-register/service'
import { parseClosuresQuery, toClosureHistoryRow } from '../../../closure-history'

/** For the next page, pass before=<the last row's number>. */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const parsed = parseClosuresQuery(req.query)
  if (!parsed.ok) return res.status(400).json({ message: parsed.message })
  const service = req.scope.resolve<TallyRegisterModuleService>(TALLY_REGISTER_MODULE)
  const page = await service.closureHistory(req.params.id, parsed.query)
  if (page === null) return res.status(404).json({ message: 'Unknown register' })
  return res.json({ closures: page.closures.map(toClosureHistoryRow), more: page.more })
}
