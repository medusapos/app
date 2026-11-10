// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const groups: number[] = [];
const runners: ChildProcess[] = [];

/**
 * A stand-in web server group: the watchdog beside a long sleep, led by its own bash. `piped` models
 * Playwright's real launch: stdout and stderr are pipes to the runner, and the server ignores SIGTERM.
 */
function group(env: Record<string, string>, args: string[] = [], { piped = false } = {}): ChildProcess {
  const server = piped ? '(trap "" TERM; exec sleep 600)' : 'sleep 600';
  const child = spawn('bash', ['-c', `node e2e/server-watchdog.mjs ${args.join(' ')} & ${server} & wait`], {
    detached: true, cwd: repoRoot, stdio: piped ? ['ignore', 'pipe', 'pipe'] : 'ignore', env: { ...process.env, ...env },
  });
  groups.push(child.pid!);
  return child;
}

function runner(): ChildProcess {
  const child = spawn('sleep', ['600']);
  runners.push(child);
  return child;
}

function alive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return predicate();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  for (const pgid of groups.splice(0)) {
    try { process.kill(-pgid, 'SIGKILL'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  for (const child of runners.splice(0)) child.kill('SIGKILL');
});

describe('e2e server watchdog', () => {
  it('stops the server group when its runner dies', async () => {
    const fake = runner();
    const server = group({ E2E_RUNNER_PID: String(fake.pid) }, [], { piped: true });
    await sleep(1500);
    expect(alive(server.pid!)).toBe(true);
    // A SIGKILLed runner closes its ends of the server's pipes.
    server.stdout!.destroy();
    server.stderr!.destroy();
    fake.kill('SIGKILL');
    expect(await waitFor(() => !alive(server.pid!), 10_000)).toBe(true);
  }, 20_000);

  it('stops the server group at its lifetime bound', async () => {
    const fake = runner();
    const server = group({ E2E_RUNNER_PID: String(fake.pid) }, ['1500']);
    expect(await waitFor(() => !alive(server.pid!), 10_000)).toBe(true);
    expect(fake.exitCode).toBeNull();
    expect(fake.signalCode).toBeNull();
  }, 20_000);

  it('leaves the server alone while its runner lives', async () => {
    const fake = runner();
    const server = group({ E2E_RUNNER_PID: String(fake.pid) });
    // Past one poll plus the SIGTERM-to-SIGKILL grace, so a false trigger has finished the group.
    await sleep(7500);
    expect(alive(server.pid!)).toBe(true);
  }, 20_000);
});
