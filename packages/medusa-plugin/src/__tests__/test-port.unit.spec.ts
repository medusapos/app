import net from 'node:net'
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
  it('leaves an explicit PORT alone', () => expect(resolveTestPort({ PORT: '5000' }, pathA, 2)).toBeUndefined())
  it('leaves CI=true to get-port', () => expect(resolveTestPort({ CI: 'true' }, pathA, 2)).toBeUndefined())
  it('derives the port for CI=false', () => expect(resolveTestPort({ CI: 'false' }, pathA, 2)).toBe(derived))
  it('derives the port when CI and PORT are unset', () => expect(resolveTestPort({}, pathA, 2)).toBe(derived))
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

  it('rejects, naming the port, when a server holds it on 127.0.0.1 only', async () => {
    const port = await freePort()
    let holder: net.Server | undefined
    try {
      holder = await listen(port, '127.0.0.1')
      await expect(assertPortsFree([port])).rejects.toThrow(`integration test port(s) ${port} busy on 127.0.0.1`)
    } finally {
      await close(holder)
    }
  })

  it('rejects, naming the port, when a server holds it on ::', async () => {
    const port = await freePort()
    let holder: net.Server | undefined
    try {
      holder = await listen(port, '::')
      await expect(assertPortsFree([port])).rejects.toThrow(new RegExp(`port\\(s\\) ${port} busy on .*::`))
    } finally {
      await close(holder)
    }
  })
})
