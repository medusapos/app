import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { NeedsAdminError } from '../needs-admin-error'
import { resumeOrderCreate } from '../resume'

const mockRun = jest.fn(async (_workflow: string, _input: unknown) => ({ result: [] }))
jest.mock('@medusajs/medusa/core-flows', () => Object.fromEntries([
  'capturePaymentWorkflow', 'completeOrderWorkflow', 'convertDraftOrderWorkflow', 'createOrderFulfillmentWorkflow',
  'createOrderPaymentCollectionWorkflow', 'markPaymentCollectionAsPaid',
].map(name => [name, () => ({ run: (input: unknown) => mockRun(name, input) })])))
jest.mock('../workflow', () => ({ takeBackStockWorkflow: () => ({ run: (input: unknown) => mockRun('takeBackStockWorkflow', input) }) }))

beforeEach(() => mockRun.mockClear())

function container(order: Record<string, unknown>) {
  const graph = jest.fn(async () => ({ data: [{
    id: 'order_1', status: 'pending', is_draft_order: false, metadata: {},
    payment_collections: [], fulfillments: [], items: [], ...order,
  }] }))
  return { resolve: (key: string) => key === ContainerRegistrationKeys.QUERY ? { graph } : undefined } as unknown as MedusaContainer
}

function collection(status: string, provider_id = 'pp_system_default') {
  return { id: 'pay_col_1', status, payment_sessions: [{ id: 'payses_1', status: 'authorized', provider_id }],
    payments: [{ id: 'pay_1', captured_at: null, provider_id }] }
}

it.each([
  ['a refunded collection', { payment_collections: [collection('refunded')] }, 'payment collection pay_col_1 is refunded'],
  ['a partially_captured collection', { payment_collections: [collection('partially_captured')] },
    'payment collection pay_col_1 is partially_captured'],
  ['an authorized collection on a non-system provider', { payment_collections: [collection('authorized', 'pp_stripe_stripe')] },
    'payment collection pay_col_1 uses provider pp_stripe_stripe'],
  ['a canceled fulfilment', { payment_collections: [collection('completed')], fulfillments: [{ id: 'ful_1', canceled_at: new Date() }] },
    'fulfillment ful_1 is canceled'],
])('resume refuses %s with NeedsAdminError before running any workflow, even on a draft', async (_name, order, detail) => {
  const resumed = resumeOrderCreate(container({ is_draft_order: true, ...order }), 'order_1', 10, 'sloc_1', 'so_1')
  await expect(resumed).rejects.toThrow(NeedsAdminError)
  await expect(resumed).rejects.toMatchObject({ orderId: 'order_1', detail })
  expect(mockRun).not.toHaveBeenCalledWith('convertDraftOrderWorkflow', expect.anything())
  expect(mockRun).not.toHaveBeenCalled()
})

it('resume captures an authorized system-provider collection and completes the order', async () => {
  await resumeOrderCreate(container({ payment_collections: [collection('authorized')] }), 'order_1', 10, 'sloc_1', 'so_1')
  expect(mockRun.mock.calls).toEqual([
    ['capturePaymentWorkflow', { input: { payment_id: 'pay_1' } }],
    ['completeOrderWorkflow', { input: { orderIds: ['order_1'] } }],
  ])
})
