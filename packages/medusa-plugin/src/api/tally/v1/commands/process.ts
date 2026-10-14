import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import type { CommandEnvelope, CommandResult, CommandBatchResponse, OrderCreatePayload } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { executeOrderCreate, replayOrderCreate } from '../../../../workflows/tally-order-create/execute'
import { executeRegisterCommand, replayRegisterCommand } from '../../../../workflows/tally-register-command/execute'
import type { TallyPluginOptions } from '../../../../workflows/tally-order-create/run'
import { fiscalFiguresErrors, type CommandErrorWithData, type OrderCreatePayloadV3 } from '../../../../workflows/tally-order-create/fiscal-figures'
import { envelopeErrors, payloadNulErrors, payloadShapeErrors } from '../../../../workflows/tally-order-create/payload-shape'
import { clientTimeStageErrors, clientTimeUpperBound } from '../../../../workflows/client-time'
import { lineTaxRefusals, v5DisplayErrors, withoutV5Display } from '../../../../workflows/tally-order-create/v5'
import { registerVersionAccepted, SUPPORTED_ORDER_CREATE_VERSIONS, SUPPORTED_REGISTER_VERSIONS } from '../versions'

export type BatchOutcome =
  | { status: 200; body: CommandBatchResponse }
  | { status: 409; body: { code: 'in_progress'; id: string } }
  | { status: 503; body: { code: 'transient'; id: string; message: string } }

// Most commands one batch may carry; a till splits a larger batch (shared with Vendure POS).
export const MAX_COMMANDS = 50
// Largest JSON body the endpoint parses: MAX_COMMANDS commands of up to ~20 kB each.
export const MAX_BODY_BYTES = 1024 * 1024

/** Validates every envelope before any command is claimed. */
export function validateBatch(body: unknown):
  | { ok: true; commands: CommandEnvelope<unknown>[] }
  | { ok: false; status: 400; message: string }
  | { ok: false; status: 413; code: 'batch_too_large'; maxCommands: number; message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, message: 'Expected body object with commands array' }
  }
  const { commands } = body as Record<string, unknown>
  if (!Array.isArray(commands)) return { ok: false, status: 400, message: 'Expected commands array' }
  if (commands.length > MAX_COMMANDS) return { ok: false, status: 413, code: 'batch_too_large', maxCommands: MAX_COMMANDS,
    message: `At most ${MAX_COMMANDS} commands are allowed` }
  if (commands.length === 0) return { ok: false, status: 400, message: 'commands must not be empty' }
  for (const [index, command] of commands.entries()) {
    if (typeof command !== 'object' || command === null || Array.isArray(command)) {
      return { ok: false, status: 400, message: `Invalid commands[${index}]: expected object` }
    }
    let field: string | undefined
    if (typeof command.id !== 'string' || command.id.length === 0 || command.id.length > 64 || command.id.includes('\0')) field = 'id'
    else if (!['order.create', 'register.session.open', 'register.session.transition', 'register.movement.record',
      'register.movement.void', 'register.closure.submit'].includes(command.type)) field = 'type'
    else if (!Number.isSafeInteger(command.version) || command.version < 1) field = 'version'
    else if (typeof command.payload !== 'object' || command.payload === null || Array.isArray(command.payload)) field = 'payload'
    else if (typeof command.createdAt !== 'string') field = 'createdAt'
    else if (typeof command.deviceId !== 'string') field = 'deviceId'
    else if (!Number.isSafeInteger(command.attempt) || command.attempt < 1) field = 'attempt'
    if (field) return { ok: false, status: 400, message: `Invalid commands[${index}].${field}` }
  }
  return { ok: true, commands }
}

export async function processBatch(
  container: MedusaContainer,
  commands: CommandEnvelope<unknown>[],
  options: TallyPluginOptions
): Promise<BatchOutcome> {
  const upperBound = clientTimeUpperBound()
  const results: CommandResult[] = []
  for (const envelope of commands) {
    if (envelope.type !== 'order.create') {
      // Same step order as order.create: replay read, then the version rule, then shape and claim (ADR 0003, 0004).
      const replay = await replayRegisterCommand(container, envelope)
      if (!replay && !registerVersionAccepted(envelope.version, options)) {
        results.push({ id: envelope.id, status: 'rejected', error: { code: 'unsupported_version',
          message: `register version ${envelope.version} is not supported; this server supports ${SUPPORTED_REGISTER_VERSIONS.join(', ')}`,
          data: { register: Math.max(...SUPPORTED_REGISTER_VERSIONS) },
        } as CommandErrorWithData })
        continue
      }
      const outcome = replay ?? await executeRegisterCommand(container, envelope, upperBound, options)
      if (outcome.kind === 'in_progress') return { status: 409, body: { code: 'in_progress', id: outcome.id } }
      if (outcome.kind === 'transient') {
        const { id, message } = outcome
        const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
        logger.error(`Command ${id} failed transiently: ${message}`)
        return { status: 503, body: { code: 'transient', id, message: 'Temporary failure, retry later.' } }
      }
      results.push(outcome.result)
      continue
    }
    const command = envelope as CommandEnvelope<OrderCreatePayload>
    const nulErrors = payloadNulErrors(command.payload)
    if (nulErrors.length) {
      results.push({ id: command.id, status: 'rejected', error: { code: 'invalid_payload', message: nulErrors.join('; ') } })
      continue
    }
    const replay = await replayOrderCreate(container, command)
    if (replay?.kind === 'in_progress') return { status: 409, body: { code: 'in_progress', id: replay.id } }
    if (replay?.kind === 'transient') {
      container.resolve(ContainerRegistrationKeys.LOGGER).error(`Command ${replay.id} failed transiently: ${replay.message}`)
      return { status: 503, body: { code: 'transient', id: replay.id, message: 'Temporary failure, retry later.' } }
    }
    if (replay?.kind === 'result') {
      results.push(replay.result)
      continue
    }
    if (!SUPPORTED_ORDER_CREATE_VERSIONS.includes(command.version)) {
      results.push({ id: command.id, status: 'rejected', error: { code: 'unsupported_version',
        message: `order.create version ${command.version} is not supported; this server supports ${SUPPORTED_ORDER_CREATE_VERSIONS.join(', ')}`,
        data: { orderCreate: Math.max(...SUPPORTED_ORDER_CREATE_VERSIONS) },
      } as CommandErrorWithData })
      continue
    }
    // ADR-062 sends version 2 exactly when there is a discount, so version 1 can never create adjustments.
    const payload = command.payload as OrderCreatePayloadV3
    const { display, taxByRate, discountMinor } = payload
    const v3 = (command.version as number) >= 3
    const versionError = command.version === 2 && discountMinor === undefined ? 'version 2 requires discountMinor'
      : v3 && (display !== undefined) !== (taxByRate !== undefined) ? 'display and taxByRate must both be present or both absent'
      : undefined
    if (versionError) {
      results.push({ id: command.id, status: 'rejected', error: { code: 'invalid_payload', message: versionError } })
      continue
    }
    // Shape rules, with the fields this version or the envelope doesn't know (ruling 17): after the replay read, unstored, before the claim.
    const errors = [...envelopeErrors(command), ...payloadShapeErrors(payload, command.version)]
    if (!errors.length && v3 && display !== undefined && taxByRate !== undefined) {
      errors.push(...fiscalFiguresErrors((command.version as number) === 5 ? withoutV5Display(payload) : payload))
      if ((command.version as number) === 5) errors.push(...v5DisplayErrors(payload as unknown as Record<string, unknown>))
    }
    if (errors.length) {
      results.push({ id: command.id, status: 'rejected', error: { code: 'invalid_payload', message: errors.slice(0, 10).join('; ') } })
      continue
    }
    const refusals = (command.version as number) === 5 ? lineTaxRefusals(payload as unknown as Record<string, unknown>) : []
    if (refusals.length) {
      const { reason, path } = refusals[0]
      results.push({ id: command.id, status: 'rejected', error: { code: 'invalid_payload',
        message: refusals.map(refusal => refusal.message).join('; '), data: { reason, path } } })
      continue
    }
    const timeErrors = clientTimeStageErrors(command, upperBound)
    if (timeErrors.length) {
      results.push({ id: command.id, status: 'rejected', error: { code: 'invalid_payload', message: timeErrors.join('; ') } })
      continue
    }
    const outcome = await executeOrderCreate(container, command, options)
    if (outcome.kind === 'in_progress') {
      return { status: 409, body: { code: 'in_progress', id: outcome.id } }
    }
    if (outcome.kind === 'transient') {
      const { id, message } = outcome
      const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
      logger.error(`Command ${id} failed transiently: ${message}`)
      return { status: 503, body: { code: 'transient', id, message: 'Temporary failure, retry later.' } }
    }
    results.push(outcome.result)
  }
  return { status: 200, body: { results } }
}
