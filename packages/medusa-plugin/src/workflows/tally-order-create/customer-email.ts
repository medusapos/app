import { validateEmail } from '@medusajs/framework/utils'

export function normaliseCustomerEmail(email: string): string | null {
  try {
    validateEmail(email)
    return email.toLowerCase()
  } catch {
    return null
  }
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

export function pickCustomer(
  rows: { id: string; email: string; has_account: boolean; created_at: Date | string }[],
  normalised: string
): { id: string } | null {
  const customer = rows.filter(row => row.email.toLowerCase() === normalised).sort((a, b) =>
    Number(b.has_account) - Number(a.has_account) ||
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.id.localeCompare(b.id)
  )[0]
  return customer ? { id: customer.id } : null
}
