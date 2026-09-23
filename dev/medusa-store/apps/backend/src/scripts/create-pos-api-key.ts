/**
 * Creates the secret Admin API key the TallyUI POS dev app uses, and writes
 * its token to $POS_API_KEY_FILE. Medusa only reveals a secret key's token at
 * creation, so an existing key is revoked and replaced.
 *
 *   POS_API_KEY_FILE=../../.pos-api-key npx medusa exec ./src/scripts/create-pos-api-key.ts
 */
import { writeFileSync } from 'node:fs'

import { createApiKeysWorkflow, revokeApiKeysWorkflow } from '@medusajs/medusa/core-flows'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import type { ExecArgs } from '@medusajs/framework/types'

const KEY_TITLE = 'TallyUI POS (dev)'

export default async function createPosApiKey({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const file = process.env.POS_API_KEY_FILE
  if (!file) throw new Error('Set POS_API_KEY_FILE to where the token should be written.')

  const { data: existing } = await query.graph({
    entity: 'api_key',
    fields: ['id'],
    filters: { title: KEY_TITLE, type: 'secret', revoked_at: null },
  })
  if (existing.length) {
    await revokeApiKeysWorkflow(container).run({
      input: { selector: { id: existing.map((k) => k.id) }, revoke: { revoked_by: 'seed' } },
    })
  }

  const { result } = await createApiKeysWorkflow(container).run({
    input: { api_keys: [{ title: KEY_TITLE, type: 'secret', created_by: 'seed' }] },
  })
  writeFileSync(file, `${result[0].token}\n`, { mode: 0o600 })
  logger.info(`Wrote "${KEY_TITLE}" token to ${file}`)
}
