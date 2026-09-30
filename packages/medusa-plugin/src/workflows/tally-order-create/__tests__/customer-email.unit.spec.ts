import { escapeLike, normaliseCustomerEmail, pickCustomer } from '../customer-email'

it.each([
  ['Buyer@Example.com', 'buyer@example.com'],
  ['invalid', null],
  [' buyer@example.com', null],
  ['buyer@example.com ', null],
])('normalises customer email %j without trimming', (email, expected) => {
  expect(normaliseCustomerEmail(email!)).toBe(expected)
})

it('escapes backslashes, percent signs and underscores for LIKE', () => {
  expect(escapeLike('a\\b%c_d')).toBe('a\\\\b\\%c\\_d')
})

const guest = { id: 'guest', email: 'Buyer@Example.com', has_account: false, created_at: '2026-01-01T00:00:00Z' }

it('picks an account before an older guest with the same email ignoring case', () => {
  const account = { ...guest, id: 'account', email: 'buyer@example.com', has_account: true, created_at: '2026-02-01T00:00:00Z' }
  expect(pickCustomer([guest, account], 'buyer@example.com')).toEqual({ id: account.id })
})

it('picks the oldest guest', () => {
  const older = { ...guest, id: 'older', created_at: new Date('2025-01-01T00:00:00Z') }
  expect(pickCustomer([guest, older], 'buyer@example.com')).toEqual({ id: older.id })
})

it('breaks a created_at tie by id', () => {
  expect(pickCustomer([{ ...guest, id: 'b' }, { ...guest, id: 'a' }], 'buyer@example.com')).toEqual({ id: 'a' })
})

it.each([
  ['x_y@example.com', 'xzy@example.com'],
  ['p%q@example.com', 'paq@example.com'],
  ['xzy@example.com', 'x_y@example.com'],
  ['paq@example.com', 'p%q@example.com'],
])('excludes wildcard-only matches between %s and %s', (email, normalised) => {
  expect(pickCustomer([{ ...guest, email }], normalised)).toBeNull()
})

it('returns null for no customers', () => {
  expect(pickCustomer([], 'buyer@example.com')).toBeNull()
})
