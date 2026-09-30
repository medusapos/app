import { execFileSync, spawnSync } from 'node:child_process';
import { basename } from 'node:path';

export function releasedTag() {
  if (process.env.E2E_RELEASED_TAG) return process.env.E2E_RELEASED_TAG;
  if (spawnSync('git', ['rev-parse', '--verify', 'origin/main'], { stdio: 'ignore' }).status !== 0) {
    execFileSync('git', ['fetch', 'origin', 'main', '--tags'], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', 'origin/main'], { encoding: 'utf8' }).trim();
  } catch (cause) {
    throw new Error('No released v* tag reachable from origin/main. Run git fetch origin main --tags, or set E2E_RELEASED_TAG to reproduce a release.', { cause });
  }
}

// No import.meta: Playwright compiles this file to CommonJS when global setup imports it.
if (process.argv[1] && basename(process.argv[1]) === 'released-tag.mjs') console.log(releasedTag());
