import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, MedusaError } from '@medusajs/framework/utils'
import type { CommandEnvelope, CommandResult } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { TALLY_LEDGER_MODULE } from '../../modules/tally-ledger'
import type TallyLedgerModuleService from '../../modules/tally-ledger/service'
import { parseCommandResult } from '../../modules/tally-ledger/command-result'
import { TALLY_REGISTER_MODULE } from '../../modules/tally-register'
import type TallyRegisterModuleService from '../../modules/tally-register/service'
import type { RegisterCommandResult, RegisterOutcome, RegisterSessionOpenPayload, RegisterSessionTransitionPayload,
  RegisterMovementRecordPayload, RegisterMovementVoidPayload, RegisterClosureSubmitPayload } from '../../modules/tally-register/types'
import type { ExecuteOutcome } from '../tally-order-create/execute'
import type { CommandErrorWithData } from '../tally-order-create/fiscal-figures'
import { commandFingerprint } from '../tally-order-create/fingerprint'
import { registerPayloadErrors } from './payload-shape'
import { loadSessionFigures } from './figures'

// BRIDGE (TallyUI c2a-1)
type RegisterResult = CommandResult & { register?: RegisterCommandResult; error?: CommandErrorWithData }
const conflictMessages = {
  register_session_already_open: 'This register already has an open session.',
  register_session_closed: 'This register session is closed.',
  register_closure_exists: 'This session already has a closure.',
  register_closure_number_invalid: 'This closure number is not the next register number.',
}

/** Read-only replay before the version and shape checks (ADR 0003, 0004): a recorded id answers as recorded. Never claims. */
export async function replayRegisterCommand(container: MedusaContainer, command: CommandEnvelope<unknown>): Promise<ExecuteOutcome | null> {
  const { id } = command
  try {
    const [row] = await container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE).listTallyCommands({ id })
    if (!row) return null
    if (row.fingerprint !== commandFingerprint(command)) return { kind: 'result', result: { id, status: 'rejected', error: {
      code: 'idempotency_mismatch', message: `Command ${id} was already used for a different payload.`,
    } } }
    if (row.status === 'in_progress') return null
    if (row.status === 'needs_admin') return { kind: 'in_progress', id }
    const result = parseCommandResult(row.result)
    return { kind: 'result', result: row.status === 'applied' ? { ...result, status: 'duplicate' } : result }
  } catch (error) {
    return { kind: 'transient', id, message: error.message }
  }
}

export async function executeRegisterCommand(container: MedusaContainer, command: CommandEnvelope<unknown>): Promise<ExecuteOutcome> {
  const { id, payload } = command
  const errors = registerPayloadErrors(command.type, payload)
  if (errors.length) return { kind: 'result', result: { id, status: 'rejected', error: { code: 'invalid_payload', message: errors.join('; ') } } }
  const ledger = container.resolve<TallyLedgerModuleService>(TALLY_LEDGER_MODULE)
  try {
    const fingerprint = commandFingerprint(command)
    let claim: Awaited<ReturnType<TallyLedgerModuleService['claim']>>
    try {
      claim = await ledger.claim({ id, type: command.type, fingerprint })
    } catch (error) {
      if (MedusaError.isMedusaError(error) && error.type === MedusaError.Types.CONFLICT) return { kind: 'in_progress', id }
      throw error
    }
    if (!claim.claimed) {
      if (claim.command.fingerprint !== fingerprint) {
        return { kind: 'result', result: { id, status: 'rejected', error: {
          code: 'idempotency_mismatch', message: `Command ${id} was already used for a different payload.`,
        } } }
      }
      if (claim.command.status === 'in_progress' || claim.command.status === 'needs_admin') return { kind: 'in_progress', id }
      const result = parseCommandResult(claim.command.result)
      return { kind: 'result', result: claim.command.status === 'applied' ? { ...result, status: 'duplicate' } : result }
    }
    let completed = false
    try {
      const service = container.resolve<TallyRegisterModuleService>(TALLY_REGISTER_MODULE)
      let outcome: RegisterOutcome
      // The claim check and service transaction aren't atomic, same as order.create; ADR 0001.
      try {
        await ledger.assertClaim(id, claim.claimToken)
      } catch (error) {
        if (MedusaError.isMedusaError(error) && error.type === MedusaError.Types.CONFLICT) return { kind: 'in_progress', id }
        throw error
      }
      switch (command.type as string) {
        case 'register.session.open': outcome = await service.openSession(payload as RegisterSessionOpenPayload); break
        case 'register.session.transition': outcome = await service.transition(payload as RegisterSessionTransitionPayload); break
        case 'register.movement.record': outcome = await service.recordMovement(payload as RegisterMovementRecordPayload); break
        case 'register.movement.void': outcome = await service.voidMovement(payload as RegisterMovementVoidPayload); break
        case 'register.closure.submit': outcome = await service.submitClosure(payload as RegisterClosureSubmitPayload); break
        default: throw new Error('Unknown register command type')
      }
      if (outcome.kind === 'ok') {
        const register = outcome.register
        const figures = await loadSessionFigures(container, register.session?.id ?? (payload as RegisterClosureSubmitPayload).sessionId)
        if (figures) {
          if (register.session) Object.assign(register.session, { expected: figures.expected, salesCount: figures.salesCount })
          if (register.closure) Object.assign(register.closure, { expected: figures.expected, variance: figures.variance })
        }
      }
      const result: RegisterResult = outcome.kind === 'ok' ? { id, status: 'applied', register: outcome.register }
        : { id, status: 'rejected', error: outcome.kind === 'conflict'
          ? { code: outcome.code, message: conflictMessages[outcome.code], data: outcome.data }
          : { code: 'invalid_payload', message: outcome.message } }
      // ADR 0004: invalid_payload must be re-evaluated against current state on resend.
      if (outcome.kind === 'invalid') return { kind: 'result', result }
      await ledger.complete(id, claim.claimToken, result)
      completed = true
      return { kind: 'result', result }
    } finally {
      if (!completed) {
        try {
          await ledger.release(id, claim.claimToken)
        } catch (error) {
          container.resolve(ContainerRegistrationKeys.LOGGER).error(`Could not release command ${id}.`, error)
        }
      }
    }
  } catch (error) {
    return { kind: 'transient', id, message: error.message }
  }
}
