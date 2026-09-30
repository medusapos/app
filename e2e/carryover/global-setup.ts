import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { E2E_RUN } from '../ports';
import { releasedTag } from './released-tag.mjs';

const root = resolve(__dirname, '../..');
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

export default function globalSetup() {
  const tag = releasedTag();
  const prepare = `Prepare a sibling checkout: git worktree add --detach <dir> ${tag}, then ~/.claude/bin/rxdb-premium-install.sh <dir> on this machine (in CI, run the app checkout's scripts/pnpm-install-filtered.sh --frozen-lockfile inside <dir>). Set E2E_RELEASED_SRC=<dir>.`;
  let src: string;
  let commit: string;
  let rxdb: string;
  try {
    if (!process.env.E2E_RELEASED_SRC) throw new Error('E2E_RELEASED_SRC is required');
    src = realpathSync(process.env.E2E_RELEASED_SRC);
    const checkout = realpathSync(root);
    if (src === checkout || src.startsWith(checkout + sep)) throw new Error('Released source must be outside this checkout');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: src, encoding: 'utf8' }).trim();
    commit = git('rev-parse', `${tag}^{commit}`);
    if (git('rev-parse', 'HEAD') !== commit) throw new Error(`Released HEAD is not ${tag}`);
    rxdb = json(resolve(src, 'apps/expo/package.json')).dependencies.rxdb;
    if (json(resolve(src, 'apps/expo/node_modules/rxdb/package.json')).version !== rxdb) {
      throw new Error('Released RxDB install does not equal its pin');
    }
  } catch (cause) {
    throw new Error(`Invalid released checkout. ${prepare}`, { cause });
  }
  console.log(`carry-over: released tag ${tag} (${commit})`);
  const backendUrl = `http://localhost:${E2E_RUN.backendPort}`;
  const build = (cwd: string, destination: string, ref: object) => {
    execFileSync('pnpm', ['--filter', '@medusapos/expo', 'build:web', '--clear'], {
      cwd, stdio: 'inherit',
      env: { ...process.env, EXPO_PUBLIC_MEDUSA_URL: backendUrl, EXPO_PUBLIC_E2E_DEBUG: '1', CI: '1', EXPO_NO_TELEMETRY: '1' },
    });
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    cpSync(resolve(cwd, 'apps/expo/dist'), resolve(destination, 'dist'), { recursive: true });
    copyFileSync(resolve(cwd, 'apps/expo/vercel.json'), resolve(destination, 'vercel.json'));
    writeFileSync(resolve(destination, 'BUILD_REF.json'), JSON.stringify(ref, null, 2) + '\n');
  };
  const released = resolve(root, 'e2e/.tmp/carryover/released');
  const ref = { tag, commit, backendUrl, rxdb };
  const refFile = resolve(released, 'BUILD_REF.json');
  if (!existsSync(refFile) || JSON.stringify(json(refFile)) !== JSON.stringify(ref)) {
    const dump = resolve(src, 'apps/expo/lib/app-store-dump.ts');
    if (!existsSync(dump)) copyFileSync(resolve(root, 'apps/expo/lib/app-store-dump.ts'), dump);
    const layout = resolve(src, 'apps/expo/app/_layout.tsx');
    if (!readFileSync(layout, 'utf8').includes("import '../lib/app-store-dump'")) {
      appendFileSync(layout, "\nimport '../lib/app-store-dump';\n");
    }
    build(src, released, ref);
  }
  build(root, resolve(root, 'e2e/.tmp/carryover/current'), { rxdb: json(resolve(root, 'apps/expo/package.json')).dependencies.rxdb });
}
