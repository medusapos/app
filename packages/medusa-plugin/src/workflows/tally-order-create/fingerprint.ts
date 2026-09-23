import { createHash } from 'node:crypto'
import type { CommandEnvelope } from '@tallyui/core'

/** JSON with recursively sorted object keys; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item) ?? 'null').join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().filter(key => object[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Lower-case hex SHA-256 of the canonical command content. */
export function commandFingerprint(envelope: Pick<CommandEnvelope, 'type' | 'version' | 'payload'>): string {
  const { type, version, payload } = envelope
  return createHash('sha256').update(canonicalJson({ type, version, payload })).digest('hex')
}
