import { integrationTestPort } from '../../integration-tests/test-port'

const pathA = '/Users/a/medusapos/packages/medusa-plugin'
const pathB = '/Users/b/medusapos/packages/medusa-plugin'
const workers = [1, 2, 3, 4, 5, 6, 7, 8]
const block = (dir: string) => workers.map(w => integrationTestPort(dir, w))

it('is deterministic for the same inputs', () => {
  expect(integrationTestPort(pathA, 3)).toBe(integrationTestPort(pathA, 3))
})

it('gives different package paths different ports', () => {
  expect(integrationTestPort(pathA, 1)).not.toBe(integrationTestPort(pathB, 1))
})

it('gives workers 1–8 on one path 8 consecutive distinct ports', () => {
  const ports = block(pathA)
  expect(ports).toEqual(workers.map(w => ports[0] + w - 1))
})

it('gives two paths in different blocks port ranges that cannot overlap', () => {
  const a = block(pathA)
  const b = block(pathB)
  expect(a.filter(p => b.includes(p))).toEqual([])
  expect(a[0] % 8).toBe(0)
  expect(b[0] % 8).toBe(0)
})

it('stays within 40000–43999 for every block and worker', () => {
  for (let i = 0; i < 2000; i++) {
    for (const p of block(`/checkout/${i}/packages/medusa-plugin`)) {
      expect(p).toBeGreaterThanOrEqual(40000)
      expect(p).toBeLessThanOrEqual(43999)
    }
  }
})

it('keeps 40000–43999 clear of the e2e port ranges', () => {
  // Restated from e2e/ports.ts: backend 9100 + (0..399), app 8100 + (0..399).
  for (const [lo, hi] of [[9100, 9499], [8100, 8499]]) {
    expect(hi < 40000 || lo > 43999).toBe(true)
  }
})
