import { providerRows } from '../payment-providers/providers'
import { GET } from '../payment-providers/route'

const ids = ['pp_stripe_stripe', 'pp_system_default', 'pp_acme-pay_acme', 'custom']

it("names providers as before and puts the till's own first", () => {
  expect(providerRows(ids, undefined)).toEqual([
    { id: 'pp_system_default', name: 'Manual payment', tillCanTake: true, terminal: false },
    { id: 'custom', name: 'custom', tillCanTake: false, terminal: false },
    { id: 'pp_acme-pay_acme', name: 'Acme Pay', tillCanTake: false, terminal: false },
    { id: 'pp_stripe_stripe', name: 'Stripe', tillCanTake: false, terminal: false },
  ])
})

it('flags only the configured terminal providers', () => {
  const rows = providerRows(ids, ['pp_stripe_stripe', 'pp_not-enabled_x'])
  expect(rows.filter(row => row.terminal).map(row => row.id)).toEqual(['pp_stripe_stripe'])
  expect(rows).toHaveLength(4)
})

it('without terminalProviders no provider is a terminal', () => {
  expect(providerRows(ids, undefined).some(row => row.terminal)).toBe(false)
  expect(providerRows(ids, []).some(row => row.terminal)).toBe(false)
})

it('lists each provider id once', () => {
  expect(providerRows(['pp_acme-pay_acme', 'pp_system_default', 'pp_acme-pay_acme'], undefined).map(row => row.id))
    .toEqual(['pp_system_default', 'pp_acme-pay_acme'])
})

it('answers 400 invalid_region_id for a repeated region_id', async () => {
  const resolve = jest.fn()
  const res = { json: jest.fn(), status: jest.fn() }
  res.status.mockReturnValue(res)
  const req = { query: { region_id: ['reg_a', 'reg_b'] }, scope: { resolve } }
  await GET(req as unknown as Parameters<typeof GET>[0], res as unknown as Parameters<typeof GET>[1])
  expect(res.status).toHaveBeenCalledWith(400)
  expect(res.json).toHaveBeenCalledWith({ code: 'invalid_region_id' })
  expect(resolve).not.toHaveBeenCalled()
})
