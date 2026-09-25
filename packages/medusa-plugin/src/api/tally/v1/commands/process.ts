import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import type { CommandEnvelope, CommandResult, CommandBatchResponse, OrderCreatePayload } from '@tallyui/core'
import { executeOrderCreate } from '../../../../workflows/tally-order-create/execute'
import type { TallyPluginOptions } from '../../../../workflows/tally-order-create/run'

export type BatchOutcome =
  | { status: 200; body: CommandBatchResponse }
  | { status: 409; body: { code: 'in_progress'; id: string } }
  | { status: 503; body: { code: 'transient'; id: string; message: string } }

/** Validates every envelope before any command is claimed. */
export function validateBatch(body: unknown):
  | { ok: true; commands: CommandEnvelope<OrderCreatePayload>[] }
  | { ok: false; status: 400 | 413; message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, message: 'Expected body object with commands array' }
  }
  const { commands } = body as Record<string, unknown>
  if (!Array.isArray(commands)) return { ok: false, status: 400, message: 'Expected commands array' }
  if (commands.length > 50) return { ok: false, status: 413, message: 'At most 50 commands are allowed' }
  if (commands.length === 0) return { ok: false, status: 400, message: 'commands must not be empty' }
  for (const [index, command] of commands.entries()) {
    if (typeof command !== 'object' || command === null || Array.isArray(command)) {
      return { ok: false, status: 400, message: `Invalid commands[${index}]: expected object` }
    }
    let field: string | undefined
    if (typeof command.id !== 'string' || command.id.length === 0 || command.id.length > 64) field = 'id'
    else if (command.type !== 'order.create') field = 'type'
    else if (command.version !== 1 && command.version !== 2) field = 'version'
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
  commands: CommandEnvelope<OrderCreatePayload>[],
  options: TallyPluginOptions
): Promise<BatchOutcome> {
  const results: CommandResult[] = []
  for (const command of commands) {
    // ADR-062 sends version 2 only with a discount.
    if (command.version === 2 && command.payload.discountMinor === undefined) {
      results.push({ id: command.id, status: 'rejected', error: { code: 'invalid_payload', message: 'version 2 requires discountMinor' } })
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
