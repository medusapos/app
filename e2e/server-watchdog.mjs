// Runs inside a Playwright web server's process group and ends that group when the runner dies
// (a SIGKILLed runner runs no exit handler, so its servers would live on under init) or when the
// group outlives a fixed bound. Usage: node e2e/server-watchdog.mjs [maxMs]

// How often to check the runner and the clock.
const POLL_MS = 1000;
// Time between SIGTERM and SIGKILL for the server group.
const GRACE_MS = 5000;
// Two hours: above the longest local full run; CI caps e2e at 30 minutes.
const DEFAULT_MAX_MS = 2 * 60 * 60 * 1000;

const positiveInt = (value) => (Number.isInteger(value) && value > 0 ? value : undefined);
const maxMs = positiveInt(Number(process.argv[2])) ?? DEFAULT_MAX_MS;
const runnerPid = positiveInt(Number(process.env.E2E_RUNNER_PID));
const startedAt = Date.now();

function runnerGone() {
  if (runnerPid === undefined) return false;
  try {
    process.kill(runnerPid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

// Stay alive through our own group SIGTERM so the SIGKILL is sent; that SIGKILL ends us too.
process.on('SIGTERM', () => {});
// A dead runner closes our stdout/stderr pipes; an unhandled EPIPE would kill us before the SIGKILL.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const timer = setInterval(() => {
  const gone = runnerGone();
  if (!gone && Date.now() - startedAt < maxMs) return;
  clearInterval(timer);
  process.stderr.write(gone
    ? `server-watchdog: runner ${runnerPid} gone, stopping the server group\n`
    : `server-watchdog: ${maxMs} ms bound reached, stopping the server group\n`);
  process.kill(0, 'SIGTERM');
  setTimeout(() => process.kill(0, 'SIGKILL'), GRACE_MS);
}, POLL_MS);
