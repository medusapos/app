import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { CASHIERS_MAX, listCashiers, toCashierRow } from '../cashiers'
import { GET } from '../cashiers/route'

const users = [
  { id: 'user_ben', email: 'ben@store.test', first_name: 'Ben', last_name: null },
  { id: 'user_zed', email: 'aaa@store.test', first_name: null, last_name: null },
  { id: 'user_ana', email: 'ana@store.test', first_name: 'Ana', last_name: 'Silva' },
]

describe('toCashierRow', () => {
  it('joins first and last name', () => {
    expect(toCashierRow({ id: 'u1', email: 'ana@store.test', first_name: 'Ana', last_name: 'Silva' }))
      .toStrictEqual({ id: 'u1', email: 'ana@store.test', name: 'Ana Silva' })
  })

  it('uses whichever of first or last name is set', () => {
    expect(toCashierRow({ id: 'u1', email: 'ana@store.test', first_name: 'Ana', last_name: null }).name).toBe('Ana')
    expect(toCashierRow({ id: 'u1', email: 'ana@store.test', first_name: '', last_name: 'Silva' }).name).toBe('Silva')
  })

  it('falls back to the email when both names are null or empty', () => {
    expect(toCashierRow({ id: 'u1', email: 'ana@store.test', first_name: null, last_name: null }).name).toBe('ana@store.test')
    expect(toCashierRow({ id: 'u1', email: 'ana@store.test', first_name: '', last_name: '' }).name).toBe('ana@store.test')
    expect(toCashierRow({ id: 'u1', email: 'ana@store.test' }).name).toBe('ana@store.test')
  })
})

describe('listCashiers', () => {
  it('asks for the named fields, at most CASHIERS_MAX users, and sorts the rows by name', async () => {
    const listUsers = jest.fn(async () => users)
    const rows = await listCashiers({ listUsers } as never)
    expect(listUsers).toHaveBeenCalledWith({}, {
      select: ['id', 'email', 'first_name', 'last_name'], take: CASHIERS_MAX, order: { email: 'ASC' },
    })
    expect(CASHIERS_MAX).toBe(200)
    expect(rows.map(row => row.name)).toStrictEqual(['aaa@store.test', 'Ana Silva', 'Ben'])
  })
})

describe('GET /tally/v1/cashiers', () => {
  it('answers the mapped rows under cashiers', async () => {
    const resolve = jest.fn(() => ({ listUsers: async () => users }))
    const json = jest.fn()
    await GET({ scope: { resolve } } as unknown as MedusaRequest, { json } as unknown as MedusaResponse)
    expect(resolve).toHaveBeenCalledWith(Modules.USER)
    expect(json).toHaveBeenCalledWith({ cashiers: [
      { id: 'user_zed', email: 'aaa@store.test', name: 'aaa@store.test' },
      { id: 'user_ana', email: 'ana@store.test', name: 'Ana Silva' },
      { id: 'user_ben', email: 'ben@store.test', name: 'Ben' },
    ] })
  })
})
