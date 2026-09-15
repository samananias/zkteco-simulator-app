/**
 * Phase 6 unit tests: template encryption at rest (ADR-011 §2), the encrypted
 * biometric store, and the service's decision rules (threshold, separation,
 * retention) — no sidecar required (matcher is stubbed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { BiometricKeyError, decrypt, encrypt, generateSessionKey, loadBiometricKey } from '../../src/biometric/crypto.js';
import { EncryptedBiometricStore } from '../../src/biometric/store.js';
import { BiometricService, BiometricServiceError, type EnrollInput } from '../../src/biometric/service.js';
import type { MatcherClient, MatchCandidate } from '../../src/biometric/matcher.js';
import { MemoryStore } from '../../src/store/memory.js';
import type { Store, UserRecord } from '../../src/store/types.js';

const KEY = loadBiometricKey('3f2a9c1d5e7b8a024d6c8e1f0a3b5c7d9e2f4a6b8c0d1e3f5a7b9c1d3e5f7a0b');
const T = (s: string): Buffer => Buffer.from(s.padEnd(24, '-'), 'latin1'); // service rejects < 8 B

test('biometric key: hex / base64 / utf8-32 accepted, garbage rejected', () => {
  assert.equal(loadBiometricKey('a'.repeat(64)).bytes.length, 32);
  assert.equal(loadBiometricKey(Buffer.alloc(32, 7).toString('base64')).bytes.length, 32);
  assert.equal(loadBiometricKey('k'.repeat(32)).bytes.length, 32);
  assert.throws(() => loadBiometricKey('short'), BiometricKeyError);
  assert.throws(() => loadBiometricKey('z'.repeat(64)), BiometricKeyError);
  const session = generateSessionKey();
  assert.equal(session.bytes.length, 32);
  assert.equal(session.source, 'session');
});

test('AES-256-GCM: round-trip, tamper detection, wrong key, fresh IV per record', () => {
  const plain = T('ISO-TEMPLATE-BYTES-\x01\x02\x03');
  const blob = encrypt(KEY, plain);
  assert.equal(blob.length, plain.length + 12 + 16, 'iv + tag + ciphertext layout');
  assert.deepEqual(decrypt(KEY, blob), plain);

  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => decrypt(KEY, tampered));

  assert.throws(() => decrypt(generateSessionKey(), blob));

  const blob2 = encrypt(KEY, plain);
  assert.ok(!blob.equals(blob2), 'fresh IV must change the ciphertext');
});

function newStore(): { store: EncryptedBiometricStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'zksim-bio-unit-'));
  return { store: new EncryptedBiometricStore(path.join(dir, 'data'), KEY), dir };
}

const RECORD = {
  uid: 1,
  finger: 0,
  userId: '1001',
  template: T('FAKE-ISO-TEMPLATE-CONTENT-0123456789ABCDEF'),
  flag: 1,
  format: 'iso19794-2' as const,
  quality: 80,
  source: 'imported' as const,
  createdAt: new Date().toISOString(),
};

test('encrypted store: put/get round-trip preserves the record', async () => {
  const { store } = newStore();
  await store.put(RECORD);
  const got = await store.get(1, 0);
  assert.ok(got);
  assert.equal(got.userId, '1001');
  assert.equal(got.format, 'iso19794-2');
  assert.equal(got.quality, 80);
  assert.deepEqual(got.template, RECORD.template);
  assert.equal(await store.get(1, 1), undefined);
});

test('encrypted store: remove / removeUser / purge / list', async () => {
  const { store, dir } = newStore();
  await store.put(RECORD);
  await store.put({ ...RECORD, finger: 1 });
  await store.put({ ...RECORD, uid: 2, userId: '1002' });
  assert.equal((await store.list()).length, 3);
  assert.equal(await store.removeUser(2), 1);
  assert.equal(await store.remove(1, 1), true);
  assert.equal(await store.remove(1, 1), false);
  assert.equal(await store.purge(), 1);
  assert.equal((await store.list()).length, 0);
  assert.equal(readdirSync(path.join(dir, 'data')).filter((f) => f.endsWith('.bio')).length, 0);
});

test('encrypted store: plaintext never touches disk (ADR-011 §2)', async () => {
  const { store, dir } = newStore();
  await store.put(RECORD);
  const files = readdirSync(path.join(dir, 'data')).filter((f) => f.endsWith('.bio'));
  assert.equal(files.length, 1);
  const ascii = readFileSync(path.join(dir, 'data', files[0])).toString('latin1');
  assert.ok(!ascii.includes('templateB64'), 'envelope JSON must not be readable');
  assert.ok(!ascii.includes('FAKE-ISO-TEMPLATE'), 'template bytes must not be readable');
  assert.ok(!ascii.includes('1001'), 'metadata must not be readable in the clear');
});

// ---------- service decision rules (stubbed matcher, real store) ----------

interface StubState {
  identify: MatchCandidate[];
  verifyScores: Map<string, number>;
  enrolled: string[];
}

function stubMatcher(state: StubState): MatcherClient {
  return {
    health: async () => ({ ok: true, engine: 'stub', templates: state.enrolled.length }),
    enrollTemplate: async (uid: number, finger: number) => {
      state.enrolled.push(`${uid}:${finger}`);
    },
    identifyTemplate: async () => state.identify,
    verifyTemplate: async (uid: number, finger: number) => state.verifyScores.get(`${uid}:${finger}`),
    removeTemplate: async (uid: number, finger: number) => {
      const i = state.enrolled.indexOf(`${uid}:${finger}`);
      if (i >= 0) state.enrolled.splice(i, 1);
    },
    clearAll: async () => {
      state.enrolled.length = 0;
    },
  } as unknown as MatcherClient;
}

async function newService(matchThreshold?: number, matchSeparation?: number): Promise<{
  service: BiometricService;
  store: Store;
  state: StubState;
}> {
  const store = new MemoryStore();
  await store.init();
  const users: UserRecord[] = [
    { uid: 1, role: 0, password: '', name: 'Ana', card: 0, userId: '1001' },
    { uid: 2, role: 0, password: '', name: 'Ben', card: 0, userId: '1002' },
  ];
  for (const u of users) await store.upsertUser(u);
  const state: StubState = { identify: [], verifyScores: new Map(), enrolled: [] };
  const flags = ['--zk-log-level', 'silent'];
  if (matchThreshold !== undefined) flags.push('--zk-match-threshold', String(matchThreshold));
  if (matchSeparation !== undefined) flags.push('--zk-match-separation', String(matchSeparation));
  const service = new BiometricService({
    config: loadConfig(flags),
    store,
    bio: new EncryptedBiometricStore(mkdtempSync(path.join(tmpdir(), 'zksim-bio-svc-')), KEY),
    matcher: stubMatcher(state),
    logger: { error() {}, warn() {}, info() {}, debug() {}, isDebug: false },
  });
  return { service, store, state };
}

const ENROLL: EnrollInput = {
  userId: '1001',
  finger: 0,
  template: T('ISO-TEMPLATE-1001-F0'),
  consent: true,
};

test('service.enroll: consent-gated, unknown-user-refused, writes all three copies', async () => {
  const { service, store, state } = await newService();
  await assert.rejects(
    () => service.enroll({ ...ENROLL, consent: false }),
    (e: BiometricServiceError) => e.status === 400,
  );
  await assert.rejects(
    () => service.enroll({ ...ENROLL, userId: '9999' }),
    (e: BiometricServiceError) => e.status === 404,
  );
  const r = await service.enroll(ENROLL);
  assert.equal(r.uid, 1);
  assert.ok(state.enrolled.includes('1:0'), 'matcher copy enrolled');
  assert.ok(await store.getTemplate(1, 0), 'FR-8 wire copy stored');
  assert.equal((await store.getTemplate(1, 0))?.format, 'iso19794-2');
});

test('service.identify: no candidates / below threshold → no-match', async () => {
  const { service, state } = await newService();
  state.identify = [];
  assert.equal((await service.identify(T('PROBE'))).decision, 'no-match');
  state.identify = [{ uid: 1, finger: 0, score: 12 }];
  assert.equal((await service.identify(T('PROBE'))).decision, 'no-match');
});

test('service.identify: clear winner → match with userId and runner-up evidence', async () => {
  const { service, state } = await newService();
  state.identify = [
    { uid: 1, finger: 0, score: 150 },
    { uid: 2, finger: 0, score: 3 },
  ];
  const r = await service.identify(T('PROBE'));
  assert.equal(r.decision, 'match');
  assert.equal(r.userId, '1001');
  assert.equal(r.uid, 1);
  assert.equal(r.runnerUpScore, 3);
});

test('service.identify: runner-up too close → ambiguous, never silently pick', async () => {
  const { service, state } = await newService();
  state.identify = [
    { uid: 1, finger: 0, score: 100 },
    { uid: 2, finger: 0, score: 90 },
  ];
  const r = await service.identify(T('PROBE'));
  assert.equal(r.decision, 'ambiguous');
  assert.equal(r.score, 100);
  assert.equal(r.runnerUpScore, 90);
});

test('service.identify: orphaned template (deleted employee) → not-enrolled + swept', async () => {
  const { service, state } = await newService();
  state.identify = [{ uid: 42, finger: 0, score: 300 }]; // uid 42 has no user record
  const r = await service.identify(T('PROBE'));
  assert.equal(r.decision, 'not-enrolled');
  assert.equal(state.enrolled.includes('42:0'), false, 'orphan swept from the matcher');
});

test('service.verify: unknown user / not enrolled / threshold pass and fail', async () => {
  const { service, state } = await newService();
  assert.equal((await service.verify('9999', 0, T('P'))).decision, 'not-enrolled');
  state.verifyScores.set('1:0', 250);
  assert.equal((await service.verify('1001', 0, T('P'))).decision, 'match');
  state.verifyScores.set('1:0', 5);
  assert.equal((await service.verify('1001', 0, T('P'))).decision, 'no-match');
  assert.equal((await service.verify('1001', 3, T('P'))).decision, 'not-enrolled');
});

test('service: configured threshold overrides the default (ADR-011 §7)', async () => {
  const { service, state } = await newService(200);
  state.identify = [{ uid: 1, finger: 0, score: 150 }];
  assert.equal((await service.identify(T('PROBE'))).decision, 'no-match', '150 < configured 200');
});

test('service.purge: wipes encrypted store, matcher copy, and FR-8 wire copies', async () => {
  const { service, store, state } = await newService();
  await service.enroll(ENROLL);
  assert.equal(await service.purge(), 1);
  assert.equal(state.enrolled.length, 0);
  assert.equal(await store.getTemplate(1, 0), undefined, 'ISO wire copy purged');
});
