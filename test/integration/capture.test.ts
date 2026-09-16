/**
 * Phase 7 gate: capture stations — the camera-station REST path end to end with
 * the real sidecar (quality gate → extract → N-sample ceremony → biometric punch
 * → EF_ATTLOG to the oracle). Camera hardware is never in the loop: frames are
 * generated programmatically (capture-stations §7); probe templates come from the
 * sidecar's synthetic fixture generator (NFR-07 — never real).
 *
 * Requires JDK 17+ (`java` on PATH); skips with an explicit message otherwise.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { startSimulator, type SimulatorHandle } from '../../src/server.js';

const TCP_PORT = 24373;
const HTTP_PORT = 23303;
const SIDECAR_PORT = 28093;

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let sim: SimulatorHandle | null = null;
let sidecar: ReturnType<typeof spawn> | null = null;
let zk: any = null;
const bioDir = mkdtempSync(path.join(tmpdir(), 'zksim-cap-'));
const TEST_KEY = '4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b';

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

// ---- synthetic camera frames (320×320 24-bit BMP, ridge pattern P=10) ----
const S = 320;
function bmp(raw: Uint8Array): Buffer {
  const rowSize = (S * 3 + 3) & ~3, imgSize = rowSize * S, fileSize = 54 + imgSize;
  const b = Buffer.alloc(fileSize);
  b.write('BM', 0, 'ascii'); b.writeUInt32LE(fileSize, 2); b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14); b.writeInt32LE(S, 18); b.writeInt32LE(S, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28);
  b.writeUInt32LE(imgSize, 34); b.writeUInt32LE(19685, 38); b.writeUInt32LE(19685, 42);
  for (let y = 0; y < S; y++) {
    const dst = 54 + y * rowSize, src = (S - 1 - y) * S;
    for (let x = 0; x < S; x++) {
      const g = raw[src + x];
      b[dst + x * 3] = g; b[dst + x * 3 + 1] = g; b[dst + x * 3 + 2] = g;
    }
  }
  return b;
}

function ridgeFrame(): Buffer {
  const P = 10, cx = S / 2, cy = S / 2;
  const raw = Buffer.alloc(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const rr = Math.hypot(x - cx, y - cy), a = Math.atan2(y - cy, x - cx);
      const env = Math.max(0, 1 - rr / (S * 0.48));
      const v = Math.sin((rr / P + 0.8 * Math.sin(a * 3) * env) * 2 * Math.PI);
      raw[y * S + x] = v > 0 ? 40 : 235;
    }
  }
  return bmp(raw);
}

function blankFrame(): Buffer {
  return bmp(Buffer.alloc(S * S, 235));
}

const B = `http://127.0.0.1:${SIDECAR_PORT}`;
const synth = async (seed: number, rot = 0, jitter = 0, drop = 0): Promise<string> => {
  const res = await fetch(`${B}/synthetic?seed=${seed}&rot=${rot}&jitter=${jitter}&drop=${drop}`);
  const j = (await res.json()) as { templateB64?: string };
  assert.ok(j.templateB64, `synthetic fixture failed: ${JSON.stringify(j)}`);
  return j.templateB64;
};

const api = async (route: string, body?: unknown, method?: string) => {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}${route}`, {
    method: method ?? (body === undefined ? 'GET' : typeof body === 'string' || Buffer.isBuffer(body) ? 'POST' : 'POST'),
    headers: body === undefined ? undefined : { 'content-type': Buffer.isBuffer(body) ? 'image/bmp' : 'application/json' },
    body: body === undefined ? undefined : Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

test.before(async () => {
  if (!haveJava()) return;
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
      '--zk-biometric-data-dir', path.join(bioDir, 'data'),
      '--zk-biometric-key', TEST_KEY,
    ]),
  );
});

test.after(async () => {
  try {
    await zk?.disconnect?.();
  } catch {
    /* device may close first */
  }
  await sim?.stop();
  sidecar?.kill();
  rmSync(bioDir, { recursive: true, force: true });
});

test('quality gate accepts a textured ridge frame and returns a template (FR-16.1)', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available — Phase 7 integration requires java on PATH');
  const { status, json } = await api('/api/biometric/capture', ridgeFrame());
  assert.equal(status, 200);
  assert.equal(json.decision, 'accept');
  const q = json.quality as { brightness: number; sharpness: number; coverage: number };
  assert.ok(q.brightness > 100 && q.brightness < 180, `brightness=${q.brightness}`);
  assert.ok(q.sharpness >= 25, `sharpness=${q.sharpness}`);
  assert.ok(q.coverage >= 0.18, `coverage=${q.coverage}`);
  assert.ok(String(json.templateB64).length > 50, 'template returned');
});

test('quality gate rejects a blank frame with an actionable reason (FR-16.1)', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available');
  const { status, json } = await api('/api/biometric/capture', blankFrame());
  assert.equal(status, 409);
  assert.equal(json.decision, 'reject');
  assert.equal(json.reason, 'too-blurry', `reason=${json.reason}`);
  assert.equal(json.templateB64, undefined, 'no template leaks from a rejected frame');
});

test('N-sample ceremony enrolls mutually consistent samples (FR-14)', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available');
  const res = await api('/api/biometric/enroll', {
    userId: '1001',
    finger: 0,
    consent: true,
    source: 'camera',
    samples: [await synth(1, 0), await synth(1, 2, 1, 10), await synth(1, -2, 2, 10)],
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.samples, 3);
  for (const c of res.json.consistency as number[]) assert.ok(c >= 40, `pair score=${c}`);

  // …and the enrollment answers identify like any other
  const hit = await api('/api/biometric/identify', { templateB64: await synth(1, 3, 1, 10) });
  assert.equal(hit.json.decision, 'match');
  assert.equal(hit.json.userId, '1001');
});

test('ceremony rejects inconsistent samples (409) and stores nothing', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available');
  const res = await api('/api/biometric/enroll', {
    userId: '1003',
    finger: 1,
    consent: true,
    samples: [await synth(21, 0), await synth(22, 0), await synth(23, 0)],
  });
  assert.equal(res.status, 409);
  const status = await api('/api/biometric/status');
  assert.equal(status.json.enrolled, 1, 'only the earlier ceremony enrollment exists');
});

test('biometric punch records attendance (verifyType=1) and reaches the oracle (FR-15)', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available');
  // enroll employee 1002 through the ceremony
  const enroll = await api('/api/biometric/enroll', {
    userId: '1002',
    finger: 0,
    consent: true,
    samples: [await synth(2, 0), await synth(2, 2, 1, 10), await synth(2, -2, 2, 10)],
  });
  assert.equal(enroll.status, 200);

  // oracle session (the BITS pattern) listens for the realtime event
  const { createRequire } = await import('node:module');
  const ZKLibTCP = createRequire(import.meta.url)('node-zklib/zklibtcp.js');
  const client = new ZKLibTCP('127.0.0.1', TCP_PORT, 10000, 5200);
  if (typeof client.createSocket === 'function') await client.createSocket();
  else await client.connect();
  zk = client;
  const received = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no EF_ATTLOG within 8 s')), 8000);
    zk.getRealTimeLogs((log: any) => {
      clearTimeout(timer);
      resolve(log);
    });
  });
  await new Promise((r) => setTimeout(r, 400)); // let the registration settle

  // the punch: capture output → identify → record, all server-side
  const punch = await api('/api/biometric/punch', { templateB64: await synth(2, 3, 1, 10) });
  assert.equal(punch.status, 200);
  assert.equal(punch.json.result, 'pass');
  assert.equal(punch.json.name, 'Reyes, Ben');
  assert.ok((punch.json.score as number) >= 40, `score=${punch.json.score}`);

  const evt = await received; // EF_ATTLOG on the wire — BITS would ingest this
  assert.ok(evt);

  // the record lands with a genuinely earned verify type
  const att = await api('/api/attendance');
  const records = att.json.attendance as { deviceUserId: string; verifyType: number }[];
  assert.ok(records.some((r) => r.deviceUserId === '1002' && r.verifyType === 1));
});

test('camera-station pages are served (/enroll, /scan)', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available');
  const enroll = await fetch(`http://127.0.0.1:${HTTP_PORT}/enroll`);
  assert.equal(enroll.status, 200);
  const enrollText = await enroll.text();
  assert.ok(enrollText.includes('consent'), 'consent statement required');
  const scan = await fetch(`http://127.0.0.1:${HTTP_PORT}/scan`);
  assert.equal(scan.status, 200);
  assert.ok((await scan.text()).includes('Place finger'));
  // the device-face menu links the stations
  const index = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/`)).text();
  assert.ok(index.includes('href="/scan"') && index.includes('href="/enroll"'));
  assert.ok(index.includes('href="/biometric"'), 'the menu links the admin view');
});

// ------------------------------------------------------------------ Phase 8

test('consent statement is served with a version and hash (ADR-011 §4)', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available');
  const { status, json } = await api('/api/biometric/consent');
  assert.equal(status, 200);
  assert.equal(json.version, 'v1');
  assert.equal(json.purpose, 'attendance-identification');
  assert.ok(String(json.text).includes('attendance identification only'), 'the statement states the purpose');
  assert.equal(String(json.hash).length, 64, 'a sha-256 hash links records to the exact wording');
});

test('a stale consent version is refused (409) and stores nothing', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available');
  const before = await api('/api/biometric/status');
  const res = await api('/api/biometric/enroll', {
    userId: '1003',
    finger: 2,
    consent: true,
    consentVersion: 'v0',
    samples: [await synth(5, 0), await synth(5, 2, 1, 10), await synth(5, -2, 2, 10)],
  });
  assert.equal(res.status, 409);
  assert.ok(String(res.json.error).includes('outdated'), `error=${res.json.error}`);
  const after = await api('/api/biometric/status');
  assert.equal(after.json.enrolled, before.json.enrolled, 'nothing stored for a stale statement');
});

test('rosters carry metadata only; station attribution is recorded (multi-station)', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available');
  const sample = await synth(9, 0);
  const enroll = await api('/api/biometric/enroll', {
    userId: '1004',
    finger: 0,
    consent: true,
    consentVersion: 'v1',
    station: 'camera-9',
    samples: [sample, await synth(9, 2, 1, 10), await synth(9, -2, 2, 10)],
  });
  assert.equal(enroll.status, 200);

  const roster = await api('/api/biometric/enrollments');
  assert.equal(roster.status, 200);
  const rows = roster.json.enrollments as Record<string, unknown>[];
  const mine = rows.find((r) => r.userId === '1004');
  assert.ok(mine, 'the new enrollment is listed');
  assert.equal(mine.station, 'camera-9');
  assert.equal(mine.name, 'Bautista, Dan');
  assert.equal(mine.finger, 0);
  assert.equal(mine.source, 'camera');
  const raw = JSON.stringify(rows);
  assert.ok(!raw.includes(sample), 'no template bytes in the enrollment roster');
  assert.ok(!/template/i.test(raw), 'no template field in the enrollment roster');

  const consents = await api('/api/biometric/consents');
  const c = (consents.json.consents as Record<string, unknown>[]).find((r) => r.userId === '1004');
  assert.ok(c, 'consent record written on enrollment');
  assert.equal(c.statementVersion, 'v1');
  assert.equal(c.station, 'camera-9');
  assert.equal(c.method, 'camera');
  assert.equal(c.uid, mine.uid);
  assert.ok(!c.withdrawnAt, 'consent is active');
  assert.ok(!JSON.stringify(consents.json).includes(sample), 'no template bytes in the consent roster');
});

test('concurrent probes through one matcher both land (multi-station safety)', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available');
  const before = (await api('/api/attendance')).json.attendance as unknown[];
  const probe = await synth(1, 3, 1, 10);
  const [a, b] = await Promise.all([
    api('/api/biometric/punch', { templateB64: probe, station: 'scan-a' }),
    api('/api/biometric/punch', { templateB64: probe, station: 'scan-b' }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.json.result, 'pass');
  assert.equal(b.json.result, 'pass');
  assert.equal((a.json.record as Record<string, unknown>).deviceUserId, '1001');
  assert.equal((b.json.record as Record<string, unknown>).deviceUserId, '1001');
  const after = (await api('/api/attendance')).json.attendance as unknown[];
  assert.equal(after.length, before.length + 2, 'both punches recorded — none lost or merged');
});

test('withdrawal deletes every template and marks consent withdrawn (ADR-011 §5)', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available');
  const before = await api('/api/biometric/status');
  const missing = await api('/api/biometric/withdraw', { userId: '9999' });
  assert.equal(missing.status, 404, 'unknown employee');

  const w = await api('/api/biometric/withdraw', { userId: '1004', reason: 'unit-test' });
  assert.equal(w.status, 200);
  assert.equal(w.json.removed, 1);
  assert.equal(w.json.consentOnFile, true);

  const after = await api('/api/biometric/status');
  assert.equal(after.json.enrolled, (before.json.enrolled as number) - 1, 'template count dropped');

  const consents = (await api('/api/biometric/consents')).json.consents as Record<string, unknown>[];
  const rec = consents.find((r) => r.userId === '1004');
  assert.ok(rec, 'the withdrawn record is kept as accountability evidence');
  assert.ok(rec?.withdrawnAt, 'consent marked withdrawn');
  assert.equal(rec?.withdrawReason, 'unit-test');

  const files = readdirSync(path.join(bioDir, 'data')).filter((f) => f.endsWith('.bio'));
  assert.equal(files.length, after.json.enrolled as number, 'one .bio file per remaining enrollment');

  const probe = await api('/api/biometric/identify', { templateB64: await synth(9, 3, 1, 10) });
  assert.notEqual(probe.json.userId, '1004', 'a withdrawn finger no longer identifies');
});

test('biometric admin page is served and never handles template bytes (ADR-011 §3)', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available');
  const page = await fetch(`http://127.0.0.1:${HTTP_PORT}/biometric`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('Consent records') && html.includes('PURGE'), 'admin view sections present');
  const js = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/biometric.js`)).text();
  assert.ok(!js.includes('templateB64'), 'the admin view never fetches template bytes');
  assert.ok(!/base64/i.test(js), 'no base64 handling in the admin view');
});

test('purge leaves no ciphertext, no consent record and no wire copy (ADR-011 §5)', async (t) => {
  if (!sim) return t.skip('JDK 17+ not available');
  const refused = await api('/api/biometric/purge', {});
  assert.equal(refused.status, 400, 'explicit confirmation is required');

  const purge = await api('/api/biometric/purge', { confirm: true });
  assert.equal(purge.status, 200);
  assert.ok((purge.json.purged as number) >= 1);

  const status = await api('/api/biometric/status');
  assert.equal(status.json.enrolled, 0);
  assert.equal(status.json.consents, 0);
  assert.equal(status.json.matcherTemplates, 0);
  assert.equal(readdirSync(path.join(bioDir, 'data')).filter((f) => f.endsWith('.bio')).length, 0, 'no ciphertext survives');
  assert.equal(readdirSync(path.join(bioDir, 'data', 'consent')).length, 0, 'no consent record survives');

  const att = (await api('/api/attendance')).json.attendance as unknown[];
  assert.ok(att.length > 0, 'attendance records are the device log, untouched by a biometric purge');
});

