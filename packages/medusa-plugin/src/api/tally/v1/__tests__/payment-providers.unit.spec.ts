import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { TALLY_LEDGER_MODULE } from '../../../../modules/tally-ledger'
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

function fakeScope(deps: { listPaymentProviders?: jest.Mock; graph?: jest.Mock }) {
  const options = { terminalProviders: ['pp_stripe_stripe'] }
  return jest.fn((key: string) => {
    if (key === TALLY_LEDGER_MODULE) return { getPluginOptions: () => options }
    if (key === Modules.PAYMENT) return { listPaymentProviders: deps.listPaymentProviders }
    if (key === ContainerRegistrationKeys.QUERY) return { graph: deps.graph }
    throw new Error(`unexpected key ${key}`)
  })
}

const terminalRows = [
  { id: 'pp_system_default', name: 'Manual payment', tillCanTake: true, terminal: false },
  { id: 'pp_stripe_stripe', name: 'Stripe', tillCanTake: false, terminal: true },
]

it('marks configured terminals in the store-wide list', async () => {
  const listPaymentProviders = jest.fn().mockResolvedValue([{ id: 'pp_system_default' }, { id: 'pp_stripe_stripe' }])
  const res = { json: jest.fn(), status: jest.fn() }
  const req = { query: {}, scope: { resolve: fakeScope({ listPaymentProviders }) } }
  await GET(req as unknown as Parameters<typeof GET>[0], res as unknown as Parameters<typeof GET>[1])
  expect(res.json).toHaveBeenCalledWith({ providers: terminalRows })
})

it("marks configured terminals in a region's list", async () => {
  const graph = jest.fn().mockResolvedValue({ data: [{ id: 'reg_1', payment_providers: [
    { id: 'pp_stripe_stripe', is_enabled: true }, { id: 'pp_system_default', is_enabled: true }] }] })
  const res = { json: jest.fn(), status: jest.fn() }
  const req = { query: { region_id: 'reg_1' }, scope: { resolve: fakeScope({ graph }) } }
  await GET(req as unknown as Parameters<typeof GET>[0], res as unknown as Parameters<typeof GET>[1])
  expect(res.json).toHaveBeenCalledWith({ providers: terminalRows })
  expect(graph).toHaveBeenCalledWith(expect.objectContaining({ filters: { id: 'reg_1' } }))
})
