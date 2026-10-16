/**
 * Milestone 1 Unit Tests: Verification of Gaps G1 to G7.
 *
 * M1-1 (G2): Port harmonization — default httpPort 3030, env & CLI overrides.
 * M1-2 (G3): Timezone correctness — Asia/Manila (PHT, UTC+8) calendar encoding & roundtrip across midnight.
 * M1-3 (G1): Synthetic enrollment — synthetic template structure, slot validation.
 * M1-4 (G5): Biometric suite OFF by default — disabled responses on camera pages and API.
 * M1-5 (G6, G7): Virtual labeling and realistic credential checks in HTTP punch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import {
  encodeTime,
  decodeTime,
  decodeTimeFields,
  getZonedTimeFields,
  encodeTimeBytes,
} from '../../src/protocol/timecodec.js';
import {
  encodeAttendance,
  decodeAttendance,
  encodeEventRecord,
} from '../../src/protocol/records.js';
import { syntheticTemplate } from '../../src/store/seed.js';
import { DEFAULT_OPTIONS } from '../../src/store/types.js';
import { startSimulator, type SimulatorHandle } from '../../src/server.js';

test('M1-1 (G2): Port harmonization defaults to 3030 with overrides', () => {
  const def = loadConfig([], {});
  assert.equal(def.httpPort, 3030, 'default HTTP port must be 3030');
  assert.equal(def.tcpPort, 4370, 'default TCP port must be 4370');

  const env = loadConfig([], { ZK_HTTP_PORT: '3040' });
  assert.equal(env.httpPort, 3040, 'env override must be respected');

  const cli = loadConfig(['--zk-http-port', '3050'], {});
  assert.equal(cli.httpPort, 3050, 'cli override must be respected');
});

test('M1-2 (G3): Timezone correctness for Asia/Manila (PHT = UTC+8)', () => {
  // Test 1: Daytime UTC timestamp (00:00:00 UTC -> 08:00:00 PHT)
  const utcDay = new Date('2026-10-16T00:00:00.000Z');
  const zonedDay = getZonedTimeFields(utcDay, 'Asia/Manila');
  assert.equal(zonedDay.year, 2026);
  assert.equal(zonedDay.month, 10);
  assert.equal(zonedDay.day, 16);
  assert.equal(zonedDay.hour, 8);
  assert.equal(zonedDay.minute, 0);
  assert.equal(zonedDay.second, 0);

  const encodedDay = encodeTime(utcDay, 'Asia/Manila');
  const decodedDay = decodeTime(encodedDay, 'Asia/Manila');
  assert.equal(decodedDay.toISOString(), '2026-10-16T00:00:00.000Z');

  // Verify BITS driver behavior: BITS reads the calendar fields as local date, then subtracts 8 hours
  const bitsDaySimulated = new Date(Date.UTC(zonedDay.year, zonedDay.month - 1, zonedDay.day, zonedDay.hour - 8, zonedDay.minute, zonedDay.second));
  assert.equal(bitsDaySimulated.toISOString(), utcDay.toISOString(), 'BITS -8h conversion matches exact original UTC');

  // Test 2: Midnight boundary rollover (16:30:00 UTC Oct 15 -> 00:30:00 PHT Oct 16)
  const utcMidnight = new Date('2026-10-15T16:30:00.000Z');
  const zonedMidnight = getZonedTimeFields(utcMidnight, 'Asia/Manila');
  assert.equal(zonedMidnight.year, 2026);
  assert.equal(zonedMidnight.month, 10);
  assert.equal(zonedMidnight.day, 16, 'date has rolled over to Oct 16 in Manila');
  assert.equal(zonedMidnight.hour, 0);
  assert.equal(zonedMidnight.minute, 30);
  assert.equal(zonedMidnight.second, 0);

  const encodedMidnight = encodeTime(utcMidnight, 'Asia/Manila');
  const decodedMidnight = decodeTime(encodedMidnight, 'Asia/Manila');
  assert.equal(decodedMidnight.toISOString(), '2026-10-15T16:30:00.000Z');

  // Test 3: encodeAttendance and decodeAttendance with Asia/Manila
  const rec = {
    userSn: 1,
    deviceUserId: '1001',
    verifyType: 1,
    state: 0,
    time: utcDay,
  };
  const buf = encodeAttendance(rec, 'Asia/Manila');
  const parsed = decodeAttendance(buf, 0, 'Asia/Manila');
  assert.equal(parsed.userSn, 1);
  assert.equal(parsed.deviceUserId, '1001');
  assert.equal(parsed.verifyType, 1);
  assert.equal(parsed.time.toISOString(), utcDay.toISOString());

  // Test 4: Realtime 6-byte raw time (encodeEventRecord / encodeTimeBytes)
  const eventBytes = encodeTimeBytes(utcMidnight, 'Asia/Manila');
  assert.equal(eventBytes[0], 26); // 2026 - 2000
  assert.equal(eventBytes[1], 10); // month
  assert.equal(eventBytes[2], 16); // day
  assert.equal(eventBytes[3], 0);  // hour
  assert.equal(eventBytes[4], 30); // minute
  assert.equal(eventBytes[5], 0);  // second
});

test('M1-3 (G1): Synthetic template structure and consistency', () => {
  const blob = syntheticTemplate(1, 0);
  assert.ok(blob.length >= 500, `template must be >=500 bytes, got ${blob.length}`);
  assert.equal(blob.toString('ascii', 0, 4), 'SS21', 'template must start with synthetic marker SS21');
  assert.equal(blob.readUInt16LE(6), 512 - 6, 'template size header matches format');

  // Deterministic: same uid and finger produces identical synthetic template
  const blob2 = syntheticTemplate(1, 0);
  assert.deepEqual(blob, blob2);

  // Different slot produces different synthetic template
  const blobOtherFinger = syntheticTemplate(1, 1);
  assert.notDeepEqual(blob, blobOtherFinger);
});

test('M1-4 (G5): Biometric suite is OFF by default', async () => {
  const cfg = loadConfig([], {});
  assert.equal(cfg.biometricReal, false, 'biometricReal must default to false');

  const testHttpPort = 23399;
  const testTcpPort = 24399;
  const sim = await startSimulator(
    loadConfig([
      '--zk-tcp-port', String(testTcpPort),
      '--zk-http-port', String(testHttpPort),
      '--zk-log-level', 'error',
    ]),
  );

  try {
    // 1. /api/biometric/status should report enabled: false
    const apiRes = await fetch(`http://127.0.0.1:${testHttpPort}/api/biometric/status`);
    assert.equal(apiRes.status, 200);
    const apiJson = (await apiRes.json()) as { enabled?: boolean };
    assert.equal(apiJson.enabled, false, 'biometric status must report enabled=false');

    // 2. Functional biometric route should return 503
    const consentRes = await fetch(`http://127.0.0.1:${testHttpPort}/api/biometric/consent`);
    assert.equal(consentRes.status, 503, 'biometric functional route must return 503');

    // 3. Camera pages (/enroll, /scan, /biometric) should return 403 explanatory page
    for (const path of ['/enroll', '/scan', '/biometric']) {
      const pageRes = await fetch(`http://127.0.0.1:${testHttpPort}${path}`);
      assert.equal(pageRes.status, 403, `path ${path} should return 403 when biometric disabled`);
      const text = await pageRes.text();
      assert.ok(text.includes('Biometric Real-Capture Suite Disabled'));
      assert.ok(text.includes('synthetic credentials'));
    }
  } finally {
    await sim.stop();
  }
});

test('M1-5 (G6, G7): Virtual labeling and realistic credential checks in /api/punch', async () => {
  assert.ok(DEFAULT_OPTIONS['~DeviceName'].includes('VIRTUAL'), 'Device name must indicate VIRTUAL');
  assert.equal(DEFAULT_OPTIONS['~SerialNumber'], 'VIRT-K14-2026', 'Serial number must match virtual profile');

  const testHttpPort = 23398;
  const testTcpPort = 24398;
  const sim = await startSimulator(
    loadConfig([
      '--zk-tcp-port', String(testTcpPort),
      '--zk-http-port', String(testHttpPort),
      '--zk-log-level', 'error',
      '--zk-seed', 'empty', // start with empty device to test credential validation
    ]),
  );

  try {
    // Add user without template or card
    await sim.store.upsertUser({
      uid: 99,
      userId: '9099',
      name: 'Test Employee',
      role: 0,
      password: '',
      card: 0,
    });

    // 1. Fingerprint punch (verifyType=1) without template should fail with 422
    const fpFailRes = await fetch(`http://127.0.0.1:${testHttpPort}/api/punch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '9099', verifyType: 1 }),
    });
    assert.equal(fpFailRes.status, 422);
    const fpFailJson = (await fpFailRes.json()) as { result: string; reason: string };
    assert.equal(fpFailJson.result, 'fail');
    assert.equal(fpFailJson.reason, 'no enrolled fingerprint template');

    // 2. Card punch (verifyType=2) without card should fail with 422
    const cardFailRes = await fetch(`http://127.0.0.1:${testHttpPort}/api/punch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '9099', verifyType: 2 }),
    });
    assert.equal(cardFailRes.status, 422);
    const cardFailJson = (await cardFailRes.json()) as { result: string; reason: string };
    assert.equal(cardFailJson.result, 'fail');
    assert.equal(cardFailJson.reason, 'no registered card');

    // 3. Custom timestamp should be honored (G7)
    const customTime = '2026-10-15T23:45:00.000Z';
    const pwdRes = await fetch(`http://127.0.0.1:${testHttpPort}/api/punch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: '9099',
        verifyType: 3, // password / pin
        timestamp: customTime,
      }),
    });
    assert.equal(pwdRes.status, 200);
    const pwdJson = (await pwdRes.json()) as { result: string; record: { time: string } };
    assert.equal(pwdJson.result, 'pass');
    assert.equal(new Date(pwdJson.record.time).toISOString(), customTime);
  } finally {
    await sim.stop();
  }
});
