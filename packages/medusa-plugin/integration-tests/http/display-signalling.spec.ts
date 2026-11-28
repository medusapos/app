import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, FeatureFlag, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { displaySignallingContract, type DisplaySignallingHarness } from '@tallyui/core/server'
import type { SyncContext } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { TALLY_DISPLAY_MODULE } from '../../src/modules/tally-display'
import { DEFAULT_ICE_SERVERS, displayAdvertisement } from '../../src/modules/tally-display/ice-servers'
import type TallyDisplayModuleService from '../../src/modules/tally-display/service'
import { DISPLAY_REFUSAL_SOURCES_MAX, sha256Hex } from '../../src/modules/tally-display/service'
import tallyDisplayReset from '../../src/scripts/tally-display-reset'
import { createHttpDisplaySignalling } from './display-signalling-client'

jest.setTimeout(180000)

// Register RBAC before the test runner evaluates medusa-config.
FeatureFlag.setFlag('rbac', true)

const TABLES = ['tally_display_device', 'tally_display_code', 'tally_display_pending', 'tally_display',
  'tally_display_signal', 'tally_display_snapshot', 'tally_display_claim_failure', 'tally_display_adoption']
// The contract's cashiers. The Medusa user id is the cashier id, so the registry and the adoption log name them.
const CASHIERS = [
  { cashierId: 'cashier-a', canPair: true }, { cashierId: 'cashier-b', canPair: true },
  { cashierId: 'cashier-viewer', canPair: false },
]

/** Core's own `parseDisplayAdvertisement`, run in a child node: it lives in core's ESM root, which this CommonJS suite cannot load. */
function coreParse(value: unknown): unknown {
  const code = "import { parseDisplayAdvertisement as parse } from '@tallyui/core'; " +
    'process.stdout.write(JSON.stringify(parse(JSON.parse(process.argv[1])) ?? null))'
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(value)],
    { cwd: path.resolve(__dirname, '../..') }).toString())
}

medusaIntegrationTestRunner({
  cwd: path.resolve(__dirname, '../plugin-app'),
  env: { MEDUSA_FF_RBAC: 'true' },
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer
    const sessions = new Map<string, { canPair: boolean; headers: Record<string, string> }>()
    const service = () => container.resolve<TallyDisplayModuleService>(TALLY_DISPLAY_MODULE)
    const knex = () => container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const baseUrl = () => api.defaults.baseURL as string

    // Users and roles made here are in the template the runner restores before each test.
    beforeAll(async () => {
      container = getContainer()
      const rbac = container.resolve(Modules.RBAC)
      const policies = await rbac.listRbacPolicies({ key: ['tally_pos:use', 'tally_pos:pair_display'] })
      expect(policies).toHaveLength(2)
      const [pair, viewer] = await rbac.createRbacRoles([{ name: 'Display pairer' }, { name: 'Display viewer' }])
      await rbac.createRbacRolePolicies([
        ...policies.map(policy => ({ role_id: pair.id, policy_id: policy.id })),
        { role_id: viewer.id, policy_id: policies.find(policy => policy.key === 'tally_pos:use')!.id },
      ])
      for (const { cashierId, canPair } of CASHIERS) {
        const email = `${cashierId}@example.com`
        const password = 'integration-test-password'
        await container.resolve(Modules.USER).createUsers({ id: cashierId, email } as any)
        const auth = container.resolve(Modules.AUTH)
        const { authIdentity } = await auth.register('emailpass', { body: { email, password } })
        await auth.updateAuthIdentities({ id: authIdentity!.id, app_metadata: { user_id: cashierId } })
        await container.resolve(ContainerRegistrationKeys.LINK).create({
          [Modules.USER]: { user_id: cashierId }, [Modules.RBAC]: { rbac_role_id: canPair ? pair.id : viewer.id },
        })
        const login = await api.post('/auth/user/emailpass', { email, password })
        sessions.set(cashierId, { canPair, headers: { Authorization: `Bearer ${login.data.token}`, 'X-Tally-Protocol': '1' } })
      }
    })

    const till = (cashierId: string, canPair = true): SyncContext => {
      const session = sessions.get(cashierId)
      if (!session || session.canPair !== canPair) throw new Error(`no test user ${cashierId} with canPair ${canPair}`)
      return { connectorId: 'medusa-display-test', baseUrl: baseUrl(), headers: session.headers }
    }
    // Medusa sets Express's trust proxy to 1 hop, so the X-Forwarded-For entry is req.ip.
    const display = (source: string) => ({
      baseUrl: baseUrl(),
      fetch: ((url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), 'X-Forwarded-For': source } })) as typeof fetch,
    })

    async function makeHarness(): Promise<DisplaySignallingHarness> {
      await knex().raw(`truncate ${TABLES.join(', ')}`)
      service().resetClock()
      service().resetDisplayRefusals()
      const rows = async (table: string) => knex().select('*').from(table).orderBy(table === 'tally_display_signal' ? 'seq' : 'id')
      return {
        signalling: createHttpDisplaySignalling(),
        till: ({ cashierId, canPair }) => till(cashierId, canPair),
        display,
        advance: async ms => service().advanceClock(ms),
        async storedText() {
          await service().prune()
          return JSON.stringify(await Promise.all(TABLES.map(rows)))
        },
        async storedCounts() {
          await service().prune()
          const count = async (table: string) => Number((await knex()(table).count('* as n'))[0].n)
          return { codes: await count('tally_display_code'), pending: await count('tally_display_pending'),
            displays: await count('tally_display'), snapshots: await count('tally_display_snapshot'),
            devices: await count('tally_display_device') }
        },
        async seedLegacyDevice(deviceId) {
          const token = randomBytes(16).toString('base64url'), displayId = randomBytes(16).toString('hex')
          const now = new Date(service().now())
          await knex()('tally_display_device').insert({ id: deviceId, key_hash: null, adopted: false, last_call_at: now })
          await knex()('tally_display').insert({ id: displayId, device_id: deviceId, name: 'Legacy', cashier_id: 'cashier-legacy',
            confirmed_at: now, token_hash: sha256Hex(token) })
          return { displayId, token }
        },
        adoptionLog: async () => (await knex()('tally_display_adoption').select('device_id', 'cashier_id').orderBy(['adopted_at', 'id']))
          .map((row: any) => ({ deviceId: row.device_id, cashierId: row.cashier_id })),
      }
    }

    describe('C1: TallyUI displaySignallingContract', () => {
      for (const c of displaySignallingContract(makeHarness)) it(c.name, c.run)
    })

    async function pairedDisplay(h: DisplaySignallingHarness, deviceId = 'till-a') {
      const s = h.signalling, ctx = till('cashier-a'), d = display('192.0.2.1')
      const device = { deviceId, deviceKey: (await s.registerDevice(ctx, deviceId)).deviceKey }
      const claim = await s.claim(d, { code: (await s.mint(ctx, device)).code, displayName: 'Counter' })
      await s.confirm(ctx, device, (await s.pending(ctx, device))[0].claimId)
      const collected = await s.collect(d, claim.claimSecret)
      if (collected.status !== 'paired') throw new Error('not paired')
      return { s, ctx, d, device, displayId: collected.displayId, token: collected.token }
    }
    const raw = (method: string, url: string, headers: Record<string, string> = {}, body?: unknown) =>
      fetch(`${baseUrl()}${url}`, { method, headers: { 'Content-Type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

    it('H1: a till route without a bearer is 401 and creates nothing; a display route needs no bearer', async () => {
      const h = await makeHarness()
      expect((await raw('POST', '/tally/v1/display-devices', { 'X-Tally-Protocol': '1' }, { deviceId: 'till-x' })).status).toBe(401)
      expect((await raw('POST', '/tally/v1/display-codes', { 'X-Tally-Device-Id': 'till-x', 'X-Tally-Device-Key': 'k' })).status).toBe(401)
      expect(await h.storedCounts()).toEqual({ codes: 0, pending: 0, displays: 0, snapshots: 0, devices: 0 })
      const collect = await raw('POST', '/tally/v1/display/collect', {}, { claimSecret: 'AAAAAAAAAAAAAAAAAAAAAA' })
      expect(collect.status).toBe(403)
      expect(await collect.json()).toEqual({ code: 'collect_refused', message: 'This pairing cannot be collected.' })
      // The plugin's own refusals are never 401, which pos reads as Medusa's session refusal.
      const device = await raw('POST', '/tally/v1/display-codes', { ...sessions.get('cashier-a')!.headers, 'X-Tally-Device-Id': 'till-x', 'X-Tally-Device-Key': 'k' })
      expect([device.status, (await device.json()).code]).toEqual([403, 'device_refused'])
      const token = await raw('GET', '/tally/v1/display/snapshot', { 'X-Tally-Display-Token': 'nope' })
      expect([token.status, (await token.json()).code]).toEqual([403, 'token_refused'])
      expect(await h.storedCounts()).toEqual({ codes: 0, pending: 0, displays: 0, snapshots: 0, devices: 0 })
    })

    it('H2: CORS preflights allow the device headers on a till route and the token header on a display route', async () => {
      for (const [url, method, headers] of [
        ['/tally/v1/display-codes', 'POST', 'authorization,x-tally-device-id,x-tally-device-key'],
        ['/tally/v1/displays/d1/snapshot', 'PUT', 'authorization,x-tally-device-id,x-tally-device-key'],
        ['/tally/v1/display/signals', 'POST', 'x-tally-display-token'],
        ['/tally/v1/display/snapshot', 'GET', 'x-tally-display-token'],
      ]) {
        const response = await fetch(`${baseUrl()}${url}`, { method: 'OPTIONS', headers: {
          Origin: 'http://localhost', 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers,
        } })
        expect(response.status).toBe(204)
        expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost')
        const allowed = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(',')
        expect(allowed).toEqual(expect.arrayContaining(headers.split(',')))
        expect(response.headers.get('access-control-allow-methods')).toContain(method)
      }
    })

    it('H3: /info advertises customerDisplay in the shape core parses, and an invalid ICE list advertises the default', async () => {
      const info = await api.get('/tally/v1/info', { headers: sessions.get('cashier-a')!.headers })
      const defaults = DEFAULT_ICE_SERVERS.map(server => ({ ...server }))
      expect(info.data.customerDisplay).toEqual({ v: 1, iceServers: defaults, snapshot: 1 })
      expect(coreParse(info.data.customerDisplay)).toEqual({ iceServers: defaults, snapshot: true })
      const warn = jest.fn()
      const invalid = displayAdvertisement({ customerDisplay: { iceServers: [{ urls: 'turn:turn.example.com', username: 'u' }] } }, warn)
      expect(invalid).toEqual({ v: 1, iceServers: defaults, snapshot: 1 })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(coreParse(invalid)).toEqual({ iceServers: defaults, snapshot: true })
    })

    it('H4: a snapshot of 204 801 bytes is too_large and keeps the old one; one of 204 800 is kept', async () => {
      const { s, ctx, d, device, displayId, token } = await pairedDisplay(await makeHarness())
      const sized = (bytes: number) => ({ pad: 'x'.repeat(bytes - '{"pad":""}'.length) })
      await s.postSnapshot(ctx, device, displayId, sized(204_800))
      await expect(s.postSnapshot(ctx, device, displayId, sized(204_801))).rejects.toMatchObject({ code: 'too_large' })
      expect(JSON.stringify(await s.readSnapshot(d, token))).toBe(JSON.stringify(sized(204_800)))
    })

    it('H5: the reset script deletes the device with its displays, and the id registers again', async () => {
      const h = await makeHarness()
      const { s, ctx, d, device, token } = await pairedDisplay(h)
      await s.mint(ctx, device)
      await tallyDisplayReset({ container, args: ['till-a'] } as any)
      await expect(s.readSnapshot(d, token)).rejects.toMatchObject({ code: 'token_refused' })
      await expect(s.list(ctx, device)).rejects.toMatchObject({ code: 'device_refused' })
      expect(await h.storedCounts()).toEqual({ codes: 0, pending: 0, displays: 0, snapshots: 0, devices: 0 })
      const again = { deviceId: 'till-a', deviceKey: (await s.registerDevice(ctx, 'till-a')).deviceKey }
      expect(await s.list(ctx, again)).toEqual([])
      expect(await h.adoptionLog()).toEqual([])
    })

    it("H6: each signal inbox keeps its newest 100 messages, in order, and never another inbox's", async () => {
      const { s, ctx, d, device, displayId, token } = await pairedDisplay(await makeHarness())
      const claim = await s.claim(d, { code: (await s.mint(ctx, device)).code, displayName: 'Other' })
      await s.confirm(ctx, device, (await s.pending(ctx, device))[0].claimId)
      const other = await s.collect(d, claim.claimSecret)
      if (other.status !== 'paired') throw new Error('not paired')
      for (let i = 0; i <= 100; i++) await s.displaySendSignal(d, token, { type: 'ice', payload: String(i) })
      await s.displaySendSignal(d, other.token, { type: 'ice', payload: 'other' })
      expect(await s.receiveSignals(ctx, device)).toEqual([
        ...Array.from({ length: 100 }, (_, i) => ({ type: 'ice', payload: String(i + 1), displayId })),
        { type: 'ice', payload: 'other', displayId: other.displayId },
      ])
      await s.displaySendSignal(d, token, { type: 'ice', payload: 'late' })
      for (let i = 0; i <= 100; i++) await s.sendSignal(ctx, device, displayId, { type: 'ice', payload: String(i) })
      expect(await s.displayReceiveSignals(d, token)).toEqual(
        Array.from({ length: 100 }, (_, i) => ({ type: 'ice', payload: String(i + 1) })),
      )
      expect(await s.receiveSignals(ctx, device)).toEqual([{ type: 'ice', payload: 'late', displayId }])
    })

    async function withDisplayLock<T>(work: () => Promise<T>): Promise<T> {
      const transaction = await knex().transaction()
      try {
        await transaction.raw('select pg_advisory_xact_lock(hashtextextended(?, 0))', ['tally_display'])
        return await work()
      } finally {
        await transaction.rollback()
      }
    }

    const expectPromptRefusal = (call: Promise<unknown>, code: string) =>
      expect(Promise.race([call, delay(2000, 'timed out')])).rejects.toMatchObject({ code })

    it('H7: with a paired display, unknown and empty tokens are refused by all three calls without waiting for the lock', async () => {
      await pairedDisplay(await makeHarness())
      const source = '192.0.2.1'
      await withDisplayLock(async () => {
        for (const token of ['x'.repeat(22), '']) {
          await Promise.all([
            expectPromptRefusal(service().readSnapshot(token, source), 'token_refused'),
            expectPromptRefusal(service().displayReceiveSignals(token, source), 'token_refused'),
            expectPromptRefusal(service().displaySendSignal(token, { type: 'ice', payload: 'test' }, source), 'token_refused'),
          ])
        }
      })
    })

    it('H8: an unknown claim secret is refused without waiting for the lock', async () => {
      await withDisplayLock(() => expectPromptRefusal(service().collect('x'.repeat(22), '192.0.2.1'), 'collect_refused'))
    })

    it('H9: a paired token and a pending claim secret both wait for the lock', async () => {
      const { device, token } = await pairedDisplay(await makeHarness())
      const { code } = await service().mint(device)
      const { claimSecret } = await service().claim('192.0.2.1', { code, displayName: 'Pending' })
      const { snapshot, collection } = await withDisplayLock(async () => {
        const snapshot = service().readSnapshot(token, '192.0.2.1'), collection = service().collect(claimSecret, '192.0.2.1')
        expect(await Promise.race([snapshot, collection, delay(500, 'waiting')])).toBe('waiting')
        return { snapshot, collection }
      })
      await expect(snapshot).resolves.toBeNull()
      await expect(collection).resolves.toMatchObject({ status: 'pending' })
    })

    it('H10: over-limit claims are refused without waiting for the lock', async () => {
      await makeHarness()
      const opened_at = new Date(service().now()), request = { code: 'made-up', displayName: 'Counter' }
      await knex()('tally_display_claim_failure').insert({ id: 'source:192.0.2.9', opened_at, failures: 10 })
      await withDisplayLock(() => expectPromptRefusal(service().claim('192.0.2.9', request), 'claim_refused'))
      await knex()('tally_display_claim_failure').insert({ id: 'store', opened_at, failures: 100 })
      await withDisplayLock(() => expectPromptRefusal(service().claim('192.0.2.10', request), 'claim_refused'))
    })

    it('H11: claims under the limit, or with an ended window, still wait for the lock', async () => {
      await makeHarness()
      const now = new Date(service().now()), sources = ['192.0.2.11', '192.0.2.12', '192.0.2.13']
      await knex()('tally_display_claim_failure').insert([
        { id: `source:${sources[0]}`, opened_at: now, failures: 9 },
        { id: `source:${sources[1]}`, opened_at: new Date(now.getTime() - 61_000), failures: 10 },
        { id: 'store', opened_at: new Date(now.getTime() - 11 * 60_000), failures: 100 },
      ])
      const calls = await withDisplayLock(async () => {
        const claims = sources.map(source => service().claim(source, { code: 'made-up', displayName: 'Counter' }))
        expect(await Promise.race([...claims, delay(500, 'waiting')])).toBe('waiting')
        return claims
      })
      await Promise.all(calls.map(call => expect(call).rejects.toMatchObject({ code: 'claim_refused' })))
    })

    it('H12: 20 refused token and collect calls cap a source, even for a valid token, until the window ends', async () => {
      const { token } = await pairedDisplay(await makeHarness())
      const source = '198.51.100.7', unknown = 'x'.repeat(22), refused = { code: 'token_refused' }
      service().advanceClock(0)
      for (let attempt = 0; attempt < 4; attempt++) {
        await expect(service().readSnapshot(unknown, source)).rejects.toMatchObject(refused)
        await expect(service().readSnapshot(unknown, source)).rejects.toMatchObject(refused)
        await expect(service().displayReceiveSignals('', source)).rejects.toMatchObject(refused)
        await expect(service().displaySendSignal(unknown, { type: 'ice', payload: 'test' }, source)).rejects.toMatchObject(refused)
        await expect(service().collect(unknown, source)).rejects.toMatchObject({ code: 'collect_refused' })
      }
      await withDisplayLock(async () => {
        await expectPromptRefusal(service().readSnapshot(token, source), 'rate_limited')
        await expectPromptRefusal(service().collect(unknown, source), 'rate_limited')
      })
      await expect(service().readSnapshot(token, '198.51.100.8')).resolves.toBeNull()
      service().advanceClock(60_000)
      await expect(service().readSnapshot(token, source)).resolves.toBeNull()
    })

    it('H13: a capped source gets HTTP 429 rate_limited, and the connector reads it as server', async () => {
      const { s, token } = await pairedDisplay(await makeHarness())
      const source = '198.51.100.7', headers = { 'X-Forwarded-For': source, 'x-tally-display-token': 'x'.repeat(22) }
      const snapshot = () => raw('GET', '/tally/v1/display/snapshot', headers)
      for (let attempt = 0; attempt < 20; attempt++) {
        const response = await snapshot()
        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({ code: 'token_refused' })
      }
      const limited = await snapshot()
      expect(limited.status).toBe(429)
      expect(await limited.json()).toEqual({ code: 'rate_limited', message: 'Too many refused display requests from this address. Try again in a minute.' })
      await expect(s.readSnapshot(display(source), token)).rejects.toMatchObject({ code: 'server' })
    })

    it('H14: the cap tracks at most 10 000 sources and drops the oldest window', async () => {
      await makeHarness()
      const module = service(), refused = { code: 'token_refused' }
      module.advanceClock(0)
      for (let attempt = 0; attempt < 20; attempt++) await expect(module.readSnapshot('', '10.0.0.1')).rejects.toMatchObject(refused)
      module.advanceClock(1)
      for (let index = 0; index < DISPLAY_REFUSAL_SOURCES_MAX; index++) {
        await expect(module.readSnapshot('', `10.1.${index >> 8}.${index & 255}`)).rejects.toMatchObject(refused)
      }
      await expect(module.readSnapshot('', '10.0.0.1')).rejects.toMatchObject(refused)
    })
  },
})
