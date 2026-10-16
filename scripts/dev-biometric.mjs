#!/usr/bin/env node
/**
 * `npm run dev:biometric` — the two-runtime start (ADR-010): matcher sidecar
 * first, then the simulator wired to it via ZK_MATCHER_URL. The sidecar stays
 * optional at boot (NFR-12); this script is the documented convenience for the
 * full biometric experience.
 *
 * Extra CLI args are forwarded to the simulator (e.g. `npm run dev:biometric -- --zk-tcp-port 4371`).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR_PORT = process.env.ZK_MATCHER_PORT ?? '28090';
const SIM_ARGS = process.argv.slice(2);

function label(prefix, chunk) {
  for (const line of String(chunk).split(/\r?\n/)) if (line) process.stderr.write(`${prefix} ${line}\n`);
}

// ---- 1. matcher sidecar (compiles in memory on start, ~4 s cold) ----
const sidecar = spawn(
  'java',
  ['-cp', path.join('sidecar', 'lib', '*'), path.join('sidecar', 'MatcherSidecar.java'), SIDECAR_PORT],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
);
sidecar.stdout.on('data', (d) => label('[sidecar] ', d));
sidecar.stderr.on('data', (d) => label('[sidecar] ', d));

sidecar.on('error', (err) => {
  console.error(`[dev-biometric] cannot start the matcher sidecar: ${err.message}`);
  console.error('[dev-biometric] the sidecar needs JDK 17+ ("java" on PATH). The plain simulator still works without it: npm run dev');
  process.exit(1);
});

// ---- 2. wait for sidecar health ----
const ready = await new Promise((resolve) => {
  const deadline = Date.now() + 30000;
  const probe = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return resolve(true);
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) resolve(false);
    else setTimeout(probe, 300);
  };
  sidecar.on('exit', (code) => resolve(false)); // port in use or compile error
  probe();
});
if (!ready) {
  console.error(`[dev-biometric] matcher sidecar did not become healthy on port ${SIDECAR_PORT} within 30 s`);
  console.error('[dev-biometric] check that the port is free (ZK_MATCHER_PORT to change it) and JDK 17+ is installed');
  sidecar.kill();
  process.exit(1);
}
console.log(`[dev-biometric] sidecar ready on http://127.0.0.1:${SIDECAR_PORT}`);

// ---- 3. simulator with ZK_MATCHER_URL wired ----
const sim = spawn(
  process.execPath,
  ['--import', 'tsx', 'src/index.ts', ...SIM_ARGS],
  {
    cwd: ROOT,
    env: { ...process.env, ZK_BIOMETRIC_REAL: 'true', ZK_MATCHER_URL: `http://127.0.0.1:${SIDECAR_PORT}` },
    stdio: 'inherit',
  },
);

// ---- 4. lifecycle: either runtime going down takes both down ----
function shutdown(signal) {
  sim.kill();
  sidecar.kill();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
sim.on('exit', (code) => {
  sidecar.kill();
  process.exit(code ?? 0);
});
