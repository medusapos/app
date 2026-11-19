import type { IUserModuleService } from '@medusajs/framework/types'

// Bounds the response: a store with more users lists the first 200 by email.
export const CASHIERS_MAX = 200

export interface CashierRow { id: string; email: string; name: string }

/** Names a user the way register approvals do: first and last name trimmed, else the email. */
export function toCashierRow(user: { id: string; email: string; first_name?: string | null; last_name?: string | null }): CashierRow {
  const name = `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim()
  return { id: user.id, email: user.email, name: name || user.email }
}

export async function listCashiers(users: Pick<IUserModuleService, 'listUsers'>): Promise<CashierRow[]> {
  const found = await users.listUsers({}, {
    select: ['id', 'email', 'first_name', 'last_name'], take: CASHIERS_MAX, order: { email: 'ASC' },
  })
  return found.map(toCashierRow).sort((a, b) => a.name.localeCompare(b.name))
}
