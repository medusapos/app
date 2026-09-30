// Fails if the packed plugin tarball contains test or fixture files, or if an
// over-broad exclusion dropped a file the runtime needs. Run after `npm run build`.
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: pkgDir,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
const paths = JSON.parse(out)[0].files.map((f) => f.path)

// Paths that must never be packed.
const forbidden = [/__tests__\//, /__fixtures__\//, /\.spec\./, /\.test\./, /integration-tests\//]
// Runtime files whose absence means an exclusion was too broad.
const required = [
  '.medusa/server/src/workflows/index.js',
  '.medusa/server/src/api/middlewares.js',
]

const offenders = paths.filter((p) => forbidden.some((re) => re.test(p)))
const missing = required.filter((p) => !paths.includes(p))

if (offenders.length > 0) {
  console.error(`Packed test or fixture files (${offenders.length}):`)
  for (const p of offenders) console.error(`  ${p}`)
}
if (missing.length > 0) {
  console.error('Runtime files missing from the package:')
  for (const p of missing) console.error(`  ${p}`)
}
if (offenders.length > 0 || missing.length > 0) process.exit(1)

console.log(`check-pack: ok, ${paths.length} files packed`)
