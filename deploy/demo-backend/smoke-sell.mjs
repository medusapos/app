import { randomUUID } from 'node:crypto'

const [baseUrl, email, password] = process.argv.slice(2)
let token
let step = 'auth'
let status = 'unavailable'
let snippet = ''

function fail(reason) {
  console.error(`smoke-sell: FAILED at ${step}: ${reason}; HTTP ${status}; body: ${snippet}`)
  process.exit(1)
}

function check(condition, reason) {
  if (!condition) throw new Error(reason)
}

const deadline = setTimeout(() => fail('whole-script timeout after 3 minutes'), 180000)

async function request(name, path, body) {
  step = name
  status = 'unavailable'
  snippet = ''
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (path === '/tally/v1/commands') headers['X-Tally-Protocol'] = '1'
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  })
  status = response.status
  const text = await response.text()
  snippet = text.slice(0, 500)
  check(status === 200, 'expected HTTP 200')
  return JSON.parse(text)
}

async function command(name, type, version, payload) {
  const data = await request(name, '/tally/v1/commands', {
    commands: [{
      id: randomUUID(), type, version, payload,
      createdAt: new Date().toISOString(), deviceId: 'smoke', attempt: 1,
    }],
  })
  const result = data?.results?.[0]
  check(result?.status === 'applied', `expected applied, got ${result?.status}`)
  return result
}

try {
  const auth = await request('auth', '/auth/user/emailpass', { email, password })
  check(typeof auth?.token === 'string' && auth.token.length > 0, 'expected a token')
  token = auth.token

  const info = await request('info', '/tally/v1/info')
  check(Array.isArray(info?.contracts?.['order.create']) && info.contracts['order.create'].includes(3),
    'expected order.create contracts to include 3')
  check(JSON.stringify(info?.contracts?.register) === '[1]', 'expected register contracts [1]')

  const stores = await request('store-name', '/admin/stores?fields=id,name')
  check(stores?.stores?.[0]?.name === 'Medusa POS demo store', 'expected the demo store name')

  const products = await request('sale', '/admin/products?handle=e2e-1&fields=id,variants.id,variants.sku')
  const variant = products?.products?.flatMap(product => product.variants ?? []).find(item => item.sku === 'E2E-1')
  check(variant?.id, 'expected E2E-1 variant')
  // Version 2 requires a positive order discount equal to the sum of line discounts.
  // The till's figures for the demo store: E2E-1 is EUR 2.00 (seed-e2e.ts), Europe prices include tax
  // (seed-demo-presentation.ts sets the region preference), and the sale's location, the channel's European
  // Warehouse in Copenhagen, falls in the Europe region (dk), whose default VAT is 25% (tax-rates.ts).
  // Inclusive line, discount in the line's own mode: gross 200 − 20 = 180; tax 180 × 0.25 / 1.25 = 36
  // (rounded once per order, half away from zero: exact); subtotal 144; total 180.
  const totalMinor = 180
  const sale = await command('sale', 'order.create', 2, {
    clientOrderId: randomUUID(), createdAt: new Date().toISOString(),
    currency: 'EUR', pricesIncludeTax: true,
    lines: [{
      clientLineId: randomUUID(), variantId: variant.id, quantity: 1,
      unitPriceMinor: 200, discountMinor: 20,
    }],
    discountMinor: 20, subtotalMinor: 144, taxMinor: 36, totalMinor,
    payments: [{ clientPaymentId: randomUUID(), method: 'cash', amountMinor: totalMinor }],
  })
  check(sale.serverRefs?.orderId, 'expected serverRefs.orderId')
  check(!sale.warnings?.length, `expected no warnings, got ${JSON.stringify(sale.warnings)}`)

  const { order } = await request('sale-order',
    `/admin/orders/${sale.serverRefs.orderId}?fields=id,status,payment_status,fulfillment_status,total`)
  check(Math.round(Number(order?.total) * 100) === totalMinor,
    `expected the order total to be ${totalMinor} minor, got ${order?.total}`)
  check(order?.status === 'completed' && order?.payment_status === 'captured' &&
    ['fulfilled', 'shipped', 'delivered'].includes(order?.fulfillment_status),
    `expected completed/captured/fulfilled, shipped or delivered; got status=${order?.status}, ` +
      `payment_status=${order?.payment_status}, fulfillment_status=${order?.fulfillment_status}`)

  const registerId = randomUUID()
  const sessionId = randomUUID()
  const movementId = randomUUID()
  const closureId = randomUUID()
  const openedAt = new Date().toISOString()
  await command('register-open', 'register.session.open', 1, {
    registerId, sessionId, openedAt, countedFloatMinor: 1000,
  })
  await command('register-movement', 'register.movement.record', 1, {
    sessionId, movementId, createdAt: new Date().toISOString(),
    type: 'paid_in', amountMinor: 500, reason: 'smoke',
  })

  const register = await request('register-get', `/tally/v1/registers/${registerId}`)
  check(register?.session?.status === 'open' && register?.session?.expected?.cash === 1500,
    'expected open session with expected.cash 1500')

  const closedAt = new Date().toISOString()
  await command('register-close', 'register.session.transition', 1, {
    sessionId, at: closedAt, status: 'closed', counted: { cash: 1500 },
  })
  const result = await command('register-closure', 'register.closure.submit', 1, {
    closureId, registerId, sessionId, openedAt, closedAt, number: 1,
    tillExpected: { cash: 1500 }, counted: { cash: 1500 },
    periodSalesTotalMinor: 0, periodRefundsTotalMinor: 0,
    perpetualSalesTotalMinor: 0, perpetualRefundsTotalMinor: 0,
    unsyncedCount: 0, unsyncedTotalMinor: 0,
    orderIds: [], movementIds: [movementId], softwareVersion: 'smoke',
  })
  check(result.register?.closure?.number === 1 && result.register?.closure?.variance?.cash === 0,
    'expected closure.number 1 and closure.variance.cash 0')

  console.log('smoke-sell: ok')
} catch (error) {
  fail(error.message)
} finally {
  clearTimeout(deadline)
}
