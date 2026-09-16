/**
 * Phase 8 unit tests: the consent ledger (statement versioning, hash linking,
 * withdrawal, purge, path safety) — no sidecar required.
 *
 * ADR-011 §4 / NFR-10: consent must be an explicit, logged, accountable act, so
 * the ledger is the evidence that an enrollment was consented to — and the
 * statement text is versioned + hashed so the evidence names the exact wording.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConsentLedger, type ConsentRecord } from '../../src/biometric/consent.js';
import {
  CONSENT_PURPOSE,
  LATEST_CONSENT_VERSION,
  consentStatement,
  consentTextHash,
  consentVersions,
} from '../../src/biometric/consent-text.js';

function newLedger(): { ledger: ConsentLedger; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'zksim-consent-unit-'));
  return { ledger: new ConsentLedger(path.join(dir, 'consent')), dir: path.join(dir, 'consent') };
}

function record(userId: string, at = '2026-09-16T08:00:00.000Z'): ConsentRecord {
  const statement = consentStatement(LATEST_CONSENT_VERSION);
  assert.ok(statement, 'the default statement version must exist');
  return {
    userId,
    uid: Number(userId) - 1000,
    statementVersion: statement.version,
    statementHash: statement.hash,
    purpose: statement.purpose,
    method: 'camera',
    station: 'camera-1',
    at,
  };
}

test('consent statement: versioned, purpose-bound, hash-linked to the wording', () => {
  const statement = consentStatement(LATEST_CONSENT_VERSION);
  assert.ok(statement);
  assert.equal(statement.version, 'v1');
  assert.equal(statement.purpose, CONSENT_PURPOSE);
  assert.equal(statement.hash.length, 64, 'sha-256 hex');
  assert.equal(statement.hash, consentTextHash(statement.text), 'hash covers exactly the served text');
  assert.ok(consentVersions().includes('v1'));
  assert.equal(consentStatement('v0'), undefined, 'unknown versions resolve to nothing (never a silent default)');
});

test('ledger: write → read → list, plaintext by design, no biometric field', async () => {
  const { ledger, dir } = newLedger();
  await ledger.init();
  await ledger.put(record('1002'));
  await ledger.put(record('1001'));

  const one = await ledger.get('1002');
  assert.equal(one?.userId, '1002');
  assert.equal(one?.uid, 2);
  assert.equal(one?.statementVersion, 'v1');
  assert.equal(one?.purpose, CONSENT_PURPOSE);
  assert.equal(one?.station, 'camera-1');
  assert.equal(one?.method, 'camera');

  const all = await ledger.list();
  assert.deepEqual(all.map((r) => r.userId), ['1001', '1002'], 'sorted by employee');

  // accountability records must stay readable even if the encryption key is lost
  // (the ciphertext is the part that must not be) — and they hold no biometrics
  const file = path.join(dir, '1002.consent.json');
  const onDisk = readFileSync(file, 'utf8');
  assert.ok(onDisk.includes('"statementVersion"'), 'plaintext JSON on disk');
  assert.ok(!/template/i.test(onDisk), 'no template field in a consent record');
});

test('ledger: withdrawal marks the record instead of destroying the evidence', async () => {
  const { ledger } = newLedger();
  await ledger.init();
  await ledger.put(record('1003'));

  const withdrawn = await ledger.withdraw('1003', 'employee request', new Date('2026-09-17T09:30:00.000Z'));
  assert.equal(withdrawn?.withdrawReason, 'employee request');
  assert.equal(withdrawn?.withdrawnAt, '2026-09-17T09:30:00.000Z');

  const after = await ledger.get('1003');
  assert.equal(after?.withdrawnAt, '2026-09-17T09:30:00.000Z');
  assert.equal(after?.station, 'camera-1', 'the original consent facts are preserved');
  assert.equal(await ledger.withdraw('9999', 'nobody'), undefined, 'no record → nothing to withdraw');
});

test('ledger: re-enrolment after withdrawal records fresh consent', async () => {
  const { ledger } = newLedger();
  await ledger.init();
  await ledger.put(record('1004'));
  await ledger.withdraw('1004', 'changed their mind');
  assert.ok((await ledger.get('1004'))?.withdrawnAt);

  await ledger.put(record('1004', '2026-09-18T07:00:00.000Z'));
  const fresh = await ledger.get('1004');
  assert.equal(fresh?.withdrawnAt, undefined, 'a new consented enrollment clears the withdrawal');
  assert.equal(fresh?.at, '2026-09-18T07:00:00.000Z');
});

test('ledger: purge removes every consent record', async () => {
  const { ledger, dir } = newLedger();
  await ledger.init();
  await ledger.put(record('1001'));
  await ledger.put(record('1002'));
  assert.equal(readdirSync(dir).length, 2);

  assert.equal(await ledger.purge(), 2);
  assert.deepEqual(await ledger.list(), []);
  assert.equal(readdirSync(dir).length, 0);
});

test('ledger: a hostile employee id cannot escape the data directory', async () => {
  const { ledger, dir } = newLedger();
  await ledger.init();
  await ledger.put(record('../../escape'));
  const names = readdirSync(dir);
  assert.equal(names.length, 1);
  assert.ok(!names[0]?.includes('..'), `sanitized name, got ${names[0]}`);
  assert.ok(!/[/\\]/.test(names[0] ?? ''), 'no path separator in a record name');
  assert.equal((await ledger.get('../../escape'))?.userId, '../../escape', 'still readable by the original id');
});

test('ledger: an unreadable record is skipped, never deleted', async () => {
  const { ledger, dir } = newLedger();
  await ledger.init();
  await ledger.put(record('1001'));
  await ledger.put(record('1002'));
  // simulate corruption of one record
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(dir, '1002.consent.json'), '{ truncated', 'utf8');

  const all = await ledger.list();
  assert.deepEqual(all.map((r) => r.userId), ['1001'], 'corrupt record is not listed');
  assert.equal(readdirSync(dir).length, 2, 'but it is preserved on disk for recovery');
});