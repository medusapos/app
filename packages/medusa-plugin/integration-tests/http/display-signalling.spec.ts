import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { MedusaContainer } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, FeatureFlag, Modules } from '@medusajs/framework/utils'
import { medusaIntegrationTestRunner } from '@medusajs/test-utils'
import { displaySignallingContract, type DisplaySignallingHarness } from '@tallyui/core/server'
import type { SyncContext } from '@tallyui/core' with { 'resolution-mode': 'import' }
import { TALLY_DISPLAY_MODULE } from '../../src/modules/tally-display'
import { DEFAULT_ICE_SERVERS, displayAdvertisement } from '../../src/modules/tally-display/ice-servers'
import type TallyDisplayModuleService from '../../src/modules/tally-display/service'
import { sha256Hex } from '../../src/modules/tally-display/service'
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
  },
})
