/**
 * Phase 6 gate: biometric substitute core — the app's REST layer end to end,
 * with the real matcher sidecar running (ADR-010 criterion 3) and the real
 * encrypted store (ADR-011). Uses sidecar synthetic fixtures only (NFR-07 —
 * no real biometrics). Boots its own sidecar on a private port.
 *
 * Requires JDK 17+ (`java` on PATH); skips with an explicit message otherwise.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { startSimulator, type SimulatorHandle } from '../../src/server.js';

const TCP_PORT = 24372;
const HTTP_PORT = 23302;
const SIDECAR_PORT = 28092;

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let sim: SimulatorHandle | null = null;
let sidecar: ReturnType<typeof spawn> | null = null;
const bioDir = mkdtempSync(path.join(tmpdir(), 'zksim-bio-'));
// 32-byte test key — throwaway fixture value, never used for real data
const TEST_KEY = '3f2a9c1d5e7b8a024d6c8e1f0a3b5c7d9e2f4a6b8c0d1e3f5a7b9c1d3e5f7a0b';

function haveJava(): boolean {
  try {
    return !spawnSync('java', ['-version'], { stdio: 'ignore' }).error;
  } catch {
    return false;
  }
}

async function waitHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const B = `http://127.0.0.1:${SIDECAR_PORT}`;
const synth = async (seed: number, rot = 0, jitter = 0, drop = 0): Promise<string> => {
  const res = await fetch(`${B}/synthetic?seed=${seed}&rot=${rot}&jitter=${jitter}&drop=${drop}`);
  const j = (await res.json()) as { templateB64?: string };
  assert.ok(j.templateB64, `synthetic fixture failed: ${JSON.stringify(j)}`);
  return j.templateB64;
};

const api = async (route: string, body?: unknown, method = body ? 'POST' : 'GET') => {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}${route}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

test.before(async () => {
  if (!haveJava()) return; // tests individually skip below
  sidecar = spawn('java', ['-cp', path.join('sidecar', 'lib', '*'), path.join('sidecar', 'MatcherSidecar.java'), String(SIDECAR_PORT)], {
    cwd: APP_ROOT,
    stdio: 'ignore',
  });
  assert.ok(await waitHealthy(SIDECAR_PORT, 30000), 'matcher sidecar must become healthy within 30 s');
  sim = await startSimulator(
    loadConfig([
      '--zk-tcp-port', String(TCP_PORT),
      '--zk-http-port', String(HTTP_PORT),
      '--zk-log-level', 'warn',
      '--zk-seed', 'standard',
      '--zk-matcher-url', B,
      '--zk-biometric-real', 'true',
      '--zk-biometric-data-dir', path.join(bioDir, 'data'),
      '--zk-biometric-key', TEST_KEY,
    ]),
  );
});

test.after(async () => {
  await sim?.stop();
  sidecar?.kill();
  rmSync(bioDir, { recursive: true, force: true });
});

test('status reports the biometric core enabled with a live matcher', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available — Phase 6 integration requires java on PATH');
  const { status, json } = await api('/api/biometric/status');
  assert.equal(status, 200);
  assert.equal(json.enabled, true);
  assert.equal(json.matcherUp, true);
});

test('enroll → identify → wrong-probe cycle end to end (ADR-010 criterion 3)', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available');
  // consent-gated: missing consent is refused (ADR-011 §4)
  const noConsent = await api('/api/biometric/enroll', {
    userId: '1001', finger: 0, templateB64: await synth(1), consent: false,
  });
  assert.equal(noConsent.status, 400);

  const enroll = await api('/api/biometric/enroll', {
    userId: '1001', finger: 0, templateB64: await synth(1), consent: true, source: 'imported', quality: 80,
  });
  assert.equal(enroll.status, 200);

  // 1:N identify with a re-presentation of the same finger → match on 1001
  const hit = await api('/api/biometric/identify', { templateB64: await synth(1, 4, 2, 10) });
  assert.equal(hit.status, 200);
  assert.equal(hit.json.decision, 'match');
  assert.equal(hit.json.userId, '1001');
  assert.ok((hit.json.score as number) >= 40, `score=${hit.json.score}`);

  // impostor → no-match (the rejection path of the cycle)
  const miss = await api('/api/biometric/identify', { templateB64: await synth(77, -3, 2, 10) });
  assert.equal(miss.status, 200);
  assert.equal(miss.json.decision, 'no-match');

  // delete → probe again → the enrollment is gone (retention rule, ADR-011 §5)
  const del = await api('/api/biometric/remove', { userId: '1001', finger: 0 });
  assert.equal(del.status, 200);
  const gone = await api('/api/biometric/identify', { templateB64: await synth(1, 2, 1, 5) });
  assert.equal(gone.json.decision, 'no-match');
});

test('FR-8 unchanged: a REST-enrolled template is matchable and wire-visible', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available');
  // enroll via REST v2 (uid of 1002 resolves through the device store)
  const enroll = await api('/api/biometric/enroll', {
    userId: '1002', finger: 1, templateB64: await synth(2), consent: true,
  });
  assert.equal(enroll.status, 200);
  // the matcher copy answers identify
  const hit = await api('/api/biometric/identify', { templateB64: await synth(2, -2, 1, 0) });
  assert.equal(hit.json.decision, 'match');
  assert.equal(hit.json.userId, '1002');
  // …and the device store now carries the real ISO template on the FR-8 slot
  const counts = await api('/api/device/state');
  assert.ok((counts.json.counts as { templates: number }).templates >= 1);
});

test('ciphertext at rest (ADR-011 §2): store files are not plaintext templates', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available');
  const dataDir = path.join(bioDir, 'data');
  assert.ok(existsSync(dataDir), 'biometric data dir must exist');
  const files = readdirSync(dataDir).filter((f) => f.endsWith('.bio'));
  assert.ok(files.length >= 1, 'at least one encrypted record expected');
  for (const f of files) {
    const raw = readFileSync(path.join(dataDir, f));
    assert.ok(raw.length > 12 + 16, 'record must carry iv+tag+ciphertext');
    assert.ok(!raw.subarray(28).toString('latin1').includes('templateB64'), 'plaintext envelope must not be readable');
    assert.ok(!raw.subarray(0, 4).toString('ascii').includes('FMR'), 'no ISO magic in the clear');
  }
});

test('purge leaves no ciphertext (ADR-011 §5) and the sidecar candidate table empties', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available');
  const refuse = await api('/api/biometric/purge', {});
  assert.equal(refuse.status, 400); // explicit confirmation required

  const purge = await api('/api/biometric/purge', { confirm: true });
  assert.equal(purge.status, 200);
  assert.ok((purge.json.purged as number) >= 1);

  const left = readdirSync(path.join(bioDir, 'data')).filter((f) => f.endsWith('.bio'));
  assert.equal(left.length, 0, 'no .bio ciphertext may survive purge');

  const status = await api('/api/biometric/status');
  assert.equal(status.json.matcherTemplates, 0);
});

