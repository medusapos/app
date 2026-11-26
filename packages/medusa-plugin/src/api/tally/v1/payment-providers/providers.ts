import { SYSTEM_PROVIDER_ID } from '../../../../workflows/tally-order-create/resume'

export type ProviderRow = { id: string; name: string; tillCanTake: boolean; terminal: boolean }

function providerName(id: string) {
  if (id === SYSTEM_PROVIDER_ID) return 'Manual payment'
  const match = /^pp_(.+)_[^_]+$/.exec(id)
  if (!match) return id
  return match[1].split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/** Rows for Settings › Card readers: the till's own provider first, then by id; `terminal` only from the plugin option. */
export function providerRows(ids: readonly string[], terminalIds: readonly string[] | undefined): ProviderRow[] {
  return [...new Set(ids)]
    .map(id => ({ id, name: providerName(id), tillCanTake: id === SYSTEM_PROVIDER_ID, terminal: terminalIds?.includes(id) ?? false }))
    .sort((a, b) => Number(b.tillCanTake) - Number(a.tillCanTake) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
