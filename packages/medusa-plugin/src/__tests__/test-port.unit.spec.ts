import net from 'node:net'
import os from 'node:os'
import { assertPortsFree, integrationTestPort, isCI, resolveTestPort } from '../../integration-tests/test-port'

const pathA = '/Users/a/medusapos/packages/medusa-plugin'
const pathB = '/Users/b/medusapos/packages/medusa-plugin'
const workers = [1, 2, 3, 4]
const block = (dir: string) => workers.map(w => integrationTestPort(dir, w))

it('is deterministic for the same inputs', () => {
  expect(integrationTestPort(pathA, 3)).toBe(integrationTestPort(pathA, 3))
})

it('gives different package paths different ports', () => {
  expect(integrationTestPort(pathA, 1)).not.toBe(integrationTestPort(pathB, 1))
})

it('gives workers 1–4 on one path 4 consecutive distinct ports', () => {
  const ports = block(pathA)
  expect(ports).toEqual(workers.map(w => ports[0] + w - 1))
})

it('gives two paths in different blocks port ranges that cannot overlap', () => {
  const a = block(pathA)
  const b = block(pathB)
  expect(a.filter(p => b.includes(p))).toEqual([])
  expect(a[0] % 4).toBe(0)
  expect(b[0] % 4).toBe(0)
})

it('stays within 40000–47999 for every block and worker', () => {
  for (let i = 0; i < 2000; i++) {
    for (const p of block(`/checkout/${i}/packages/medusa-plugin`)) {
      expect(p).toBeGreaterThanOrEqual(40000)
      expect(p).toBeLessThanOrEqual(47999)
    }
  }
})

it('keeps 40000–47999 clear of the e2e port ranges', () => {
  // Restated from e2e/ports.ts: backend 9100 + (0..399), app 8100 + (0..399).
  for (const [lo, hi] of [[9100, 9499], [8100, 8499]]) {
    expect(hi < 40000 || lo > 47999).toBe(true)
  }
})

it('refuses a fifth jest worker instead of wrapping onto worker 1', () => {
  expect(() => integrationTestPort(pathA, 5)).toThrow(
    'integration tests use at most 4 jest workers per checkout (worker 5); run with --maxWorkers=4 or fewer, or set PORT',
  )
})

describe('resolveTestPort', () => {
  const derived = String(integrationTestPort(pathA, 2))
  const http = { TEST_TYPE: 'integration:http' }
  it('leaves an explicit PORT alone', () => expect(resolveTestPort({ ...http, PORT: '5000' }, pathA, 2)).toBeUndefined())
  it('leaves CI=true to get-port', () => expect(resolveTestPort({ ...http, CI: 'true' }, pathA, 2)).toBeUndefined())
  it('derives the port for CI=false', () => expect(resolveTestPort({ ...http, CI: 'false' }, pathA, 2)).toBe(derived))
  it('derives the port when CI and PORT are unset', () => expect(resolveTestPort(http, pathA, 2)).toBe(derived))
  it.each([{ TEST_TYPE: 'unit' }, {}])('leaves %p alone on worker 9, without throwing', env =>
    expect(resolveTestPort(env, pathA, 9)).toBeUndefined())
  it('refuses worker 9 in the HTTP suite', () =>
    expect(() => resolveTestPort(http, pathA, 9)).toThrow('integration tests use at most 4 jest workers per checkout (worker 9)'))
})

describe('isCI', () => {
  it.each(['true', '1', 'TRUE'])('is true for CI=%p', v => expect(isCI({ CI: v })).toBe(true))
  it.each(['', '0', 'false', 'False'])('is false for CI=%p', v => expect(isCI({ CI: v })).toBe(false))
  it('is false when CI is unset', () => expect(isCI({})).toBe(false))
})

describe('assertPortsFree', () => {
  const listen = (port: number, host: string) =>
    new Promise<net.Server>((resolve, reject) => {
      const server = net.createServer().once('error', reject)
      server.listen(port, host, () => resolve(server))
    })
  const close = (server?: net.Server) =>
    new Promise<void>(resolve => (server?.listening ? server.close(() => resolve()) : resolve()))
  const freePort = async () => {
    const server = await listen(0, '127.0.0.1')
    const { port } = server.address() as net.AddressInfo
    await close(server)
    return port
  }

  it('resolves for a free port', async () => {
    await expect(assertPortsFree([await freePort()])).resolves.toBeUndefined()
  })

  // ::1 and :: need IPv6: without an IPv6 loopback interface those two cases are skipped.
  const hasIPv6 = Object.values(os.networkInterfaces()).flat().some(i => i?.family === 'IPv6' && i.internal)
  const busyHosts = (message: string, port: number) => message.match(new RegExp(`${port} busy on ([^;]*)`))?.[1].split(', ')
  for (const [host, connected] of [['127.0.0.1', '127.0.0.1'], ['0.0.0.0', '127.0.0.1'], ['::1', '::1'], ['::', '::1']]) {
    const run = host.includes(':') && !hasIPv6 ? it.skip : it
    run(`rejects, naming ${host} and ${connected} (connect), when a server holds the port on ${host} (IPv6 hosts skip without IPv6)`, async () => {
      const port = await freePort()
      let holder: net.Server | undefined
      try {
        holder = await listen(port, host)
        const message = await assertPortsFree([port]).then(() => 'resolved', (err: Error) => err.message)
        expect(message).toMatch(`integration test port(s) ${port} busy on `)
        expect(busyHosts(message, port)).toEqual(expect.arrayContaining([host, `${connected} (connect)`]))
      } finally {
        await close(holder)
      }
    })
  }
})
