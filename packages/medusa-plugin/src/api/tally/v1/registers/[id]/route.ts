import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { TALLY_REGISTER_MODULE } from '../../../../../modules/tally-register'
import type TallyRegisterModuleService from '../../../../../modules/tally-register/service'
import { loadSessionFigures, loadSessionRejected } from '../../../../../workflows/tally-register-command/figures'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const service = req.scope.resolve<TallyRegisterModuleService>(TALLY_REGISTER_MODULE)
  const state = await service.registerState(req.params.id)
  if (!state) return res.status(404).json({ message: 'Unknown register' })
  if (state.session) {
    const figures = await loadSessionFigures(req.scope, state.session.id)
    if (figures) Object.assign(state.session, { expected: figures.expected, salesCount: figures.salesCount })
    const rejected = await loadSessionRejected(req.scope, state.session.id)
    // An absent rejected value means zero (ruling on #123).
    if (rejected && rejected.count > 0) Object.assign(state.session, { rejected })
  }
  return res.json(state)
}
