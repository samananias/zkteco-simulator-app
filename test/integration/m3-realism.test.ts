/**
 * Milestone 3: Realism (closer to a real device)
 *
 * Automated verification of R1 to R10:
 * - R1: Capacity limits (reported by CMD_GET_FREE_SIZES, reject writes past capacity)
 * - R2: Verification rules & table-driven punch test matrix
 * - R3: Device-level duplicate punch suppression window
 * - R4: Device admin privileges (role 14 vs 0) and CMD_CLEAR_ADMIN
 * - R5: Clock drift and CMD_SET_TIME recovery
 * - R6: Fault injection (connection refusal, command error, command drop, clear)
 * - R7: Offline buffering (punch accumulation and reconnection sync)
 * - R8: Large logs and CMD_CLEAR_ATTLOG
 * - R9: Realistic option strings (~SerialNumber, ~DeviceName, ~Platform, capacities)
 * - R10: Real-time events (CMD_REG_EVENT / EF_ATTLOG)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { loadConfig } from '../../src/config.js';
import { startSimulator, type SimulatorHandle } from '../../src/server.js';
import { encodeUser, type UserRecord } from '../../src/protocol/records.js';
import { encodeTime, decodeTime } from '../../src/protocol/timecodec.js';
import { COMMANDS } from '../../src/protocol/codes.js';

const require = createRequire(import.meta.url);
let ZKLibTCP: any = null;
try {
  ZKLibTCP = require('node-zklib/zklibtcp.js');
} catch {
  ZKLibTCP = null;
}

const TCP_PORT = 24375;
const HTTP_PORT = 23305;

let sim: SimulatorHandle | null = null;
let zk: any = null;

const cmdOf = (reply: Buffer): number => reply.readUInt16LE(0);
const payloadOf = (reply: Buffer): Buffer => reply.subarray(8);

test.before(async () => {
  sim = await startSimulator(
    loadConfig([
      '--zk-tcp-port', String(TCP_PORT),
      '--zk-http-port', String(HTTP_PORT),
      '--zk-log-level', 'warn',
      '--zk-seed', 'empty',
      '--zk-duplicate-punch-window', '60',
    ]),
  );
  assert.ok(ZKLibTCP, 'node-zklib@1.3.0 must be available');
  zk = new ZKLibTCP('127.0.0.1', TCP_PORT, 10000, 5200);
  if (typeof zk.createSocket === 'function') await zk.createSocket();
  else await zk.connect();
});

test.after(async () => {
  try {
    await zk?.disconnect?.();
  } catch {
    /* ignore */
  }
  await sim?.stop();
});

// =========================================================================
// R1: Capacity Limits
// =========================================================================

test('R1: CMD_GET_FREE_SIZES reports accurate profile capacities and counts', async () => {
  const reply = await zk.executeCmd(COMMANDS.CMD_GET_FREE_SIZES, '');
  assert.equal(cmdOf(reply), COMMANDS.CMD_ACK_OK);
  const data = payloadOf(reply);
  assert.ok(data.length >= 72, `expected at least 72 bytes, got ${data.length}`);

  const userCapacity = data.readUInt32LE(48);
  const fpCapacity = data.readUInt32LE(52);
  const logCapacity = data.readUInt32LE(64);

  assert.equal(userCapacity, 3000, 'user capacity should be 3000 (K14 profile)');
  assert.equal(fpCapacity, 3000, 'template capacity should be 3000');
  assert.equal(logCapacity, 100000, 'log capacity should be 100000 (K14 profile)');

  // High-level node-zklib getInfo() parses correctly
  const info = await zk.getInfo();
  assert.equal(info.logCapacity, 100000);
});

test('R1: Device rejects user writes past capacity with CMD_ACK_ERROR', async () => {
  const capSim = await startSimulator(
    loadConfig([
      '--zk-tcp-port', '24376',
      '--zk-http-port', '23306',
      '--zk-log-level', 'warn',
      '--zk-seed', 'empty',
      '--zk-user-capacity', '1',
    ]),
  );
  const capZk = new ZKLibTCP('127.0.0.1', 24376, 5000, 5200);
  await capZk.createSocket();
  try {
    const u1: UserRecord = { uid: 1, role: 0, password: '', name: 'User 1', card: 0, userId: '1' };
    const u2: UserRecord = { uid: 2, role: 0, password: '', name: 'User 2', card: 0, userId: '2' };

    const rep1 = await capZk.executeCmd(COMMANDS.CMD_USER_WRQ, encodeUser(u1));
    assert.equal(cmdOf(rep1), COMMANDS.CMD_ACK_OK, 'first user write must succeed');

    const rep2 = await capZk.executeCmd(COMMANDS.CMD_USER_WRQ, encodeUser(u2));
    assert.equal(cmdOf(rep2), COMMANDS.CMD_ACK_ERROR, 'second user write must be rejected past capacity');

    // Updating existing user 1 still succeeds
    const repUpdate = await capZk.executeCmd(COMMANDS.CMD_USER_WRQ, encodeUser({ ...u1, name: 'User 1 Updated' }));
    assert.equal(cmdOf(repUpdate), COMMANDS.CMD_ACK_OK, 'updating existing user must succeed');
  } finally {
    try { await capZk.disconnect(); } catch { /* ignore */ }
    await capSim.stop();
  }
});

test('R1: /api/punch rejects punches when log capacity is reached', async () => {
  const capSim = await startSimulator(
    loadConfig([
      '--zk-tcp-port', '24377',
      '--zk-http-port', '23307',
      '--zk-log-level', 'warn',
      '--zk-seed', 'empty',
      '--zk-log-capacity', '1',
    ]),
  );
  try {
    await capSim.store.upsertUser({ uid: 10, role: 0, password: '', name: 'Test', card: 12345, userId: '10' });

    // First punch succeeds
    const res1 = await fetch('http://127.0.0.1:23307/api/punch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '10', verifyType: 2, timestamp: '2026-10-15T08:00:00.000Z' }),
    });
    assert.equal(res1.status, 200);

    // Second punch fails because capacity is 1
    const res2 = await fetch('http://127.0.0.1:23307/api/punch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '10', verifyType: 2, timestamp: '2026-10-15T09:00:00.000Z' }),
    });
    assert.equal(res2.status, 422);
    const json2 = (await res2.json()) as { result: string; reason: string };
    assert.equal(json2.result, 'fail');
    assert.equal(json2.reason, 'device log capacity exceeded');
  } finally {
    await capSim.stop();
  }
});

// =========================================================================
// R2: Verification Rules & Table-Driven Punch Test Matrix
// =========================================================================

test('R2: Verification rules matrix handles credentials, states, and errors cleanly', async () => {
  // Seed test users
  // User 101: has synthetic fingerprint template, no card
  await sim!.store.upsertUser({ uid: 101, role: 0, password: '', name: 'Fingerprint User', card: 0, userId: '101' });
  await sim!.store.saveTemplate({
    uid: 101, finger: 0, flag: 1, template: Buffer.alloc(100, 0x5a), format: 'synthetic',
  });

  // User 102: has card, no fingerprint template
  await sim!.store.upsertUser({ uid: 102, role: 0, password: '', name: 'Card User', card: 887766, userId: '102' });

  // User 103: disabled user
  await sim!.store.upsertUser({ uid: 103, role: 0, password: '', name: 'Disabled User', card: 112233, userId: '103', enabled: false });

  const cases = [
    {
      name: 'Enrolled fingerprint punch passes',
      body: { userId: '101', verifyType: 1 },
      expectedStatus: 200,
      expectedResult: 'pass',
    },
    {
      name: 'Unenrolled fingerprint punch rejects with 422',
      body: { userId: '102', verifyType: 1 },
      expectedStatus: 422,
      expectedResult: 'fail',
      expectedReason: 'no enrolled fingerprint template',
    },
    {
      name: 'Registered card punch passes',
      body: { userId: '102', verifyType: 2, timestamp: '2026-10-16T10:00:00.000Z' },
      expectedStatus: 200,
      expectedResult: 'pass',
    },
    {
      name: 'Unregistered card punch rejects with 422',
      body: { userId: '101', verifyType: 2 },
      expectedStatus: 422,
      expectedResult: 'fail',
      expectedReason: 'no registered card',
    },
    {
      name: 'Disabled user punch rejects with 403',
      body: { userId: '103', verifyType: 2 },
      expectedStatus: 403,
      expectedResult: 'fail',
      expectedReason: 'user disabled or inactive',
    },
    {
      name: 'Unknown user punch rejects with 404',
      body: { userId: '9999', verifyType: 1 },
      expectedStatus: 404,
      expectedResult: 'fail',
      expectedReason: 'unknown user',
    },
    {
      name: 'Cancelled scan reports fail without recording log',
      body: { userId: '101', verifyType: 1, cancel: true },
      expectedStatus: 200,
      expectedResult: 'fail',
      expectedReason: 'cancelled scan',
    },
    {
      name: 'Unsupported verification mode rejects with 422',
      body: { userId: '101', verifyType: 99 },
      expectedStatus: 422,
      expectedResult: 'fail',
      expectedReason: 'unsupported verification mode: 99',
    },
  ];

  for (const c of cases) {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/punch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(c.body),
    });
    assert.equal(res.status, c.expectedStatus, `${c.name} - HTTP status mismatch`);
    const json = (await res.json()) as { result: string; reason?: string };
    assert.equal(json.result, c.expectedResult, `${c.name} - result mismatch`);
    if (c.expectedReason) {
      assert.equal(json.reason, c.expectedReason, `${c.name} - reason mismatch`);
    }
  }
});

// =========================================================================
// R3: Device-Level Duplicate Punch Suppression Window
// =========================================================================

test('R3: On-device duplicate punch suppression window rejects rapid duplicate logs', async () => {
  await sim!.store.clearAttendance();
  await sim!.store.upsertUser({ uid: 201, role: 0, password: '', name: 'Dedup User', card: 554433, userId: '201' });

  const t0 = new Date('2026-10-16T12:00:00.000Z');

  // First punch
  const r1 = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/punch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: '201', verifyType: 2, timestamp: t0.toISOString() }),
  });
  assert.equal(r1.status, 200);
  const j1 = (await r1.json()) as { result: string };
  assert.equal(j1.result, 'pass');

  // Rapid punch 15s later -> device suppresses it
  const t1 = new Date(t0.getTime() + 15_000);
  const r2 = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/punch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: '201', verifyType: 2, timestamp: t1.toISOString() }),
  });
  assert.equal(r2.status, 200);
  const j2 = (await r2.json()) as { result: string; reason: string };
  assert.equal(j2.result, 'suppressed');
  assert.equal(j2.reason, 'duplicate punch within device suppression window');

  // Store still has exactly 1 attendance log
  const attsAfterSuppressed = await sim!.store.getAttendance();
  assert.equal(attsAfterSuppressed.length, 1);

  // Punch with force: true bypasses suppression
  const rForce = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/punch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: '201', verifyType: 2, timestamp: t1.toISOString(), force: true }),
  });
  assert.equal(rForce.status, 200);
  const jForce = (await rForce.json()) as { result: string };
  assert.equal(jForce.result, 'pass');

  // Punch beyond 60s window (75s) succeeds normally
  const t2 = new Date(t0.getTime() + 75_000);
  const r3 = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/punch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: '201', verifyType: 2, timestamp: t2.toISOString() }),
  });
  assert.equal(r3.status, 200);
  const j3 = (await r3.json()) as { result: string };
  assert.equal(j3.result, 'pass');

  const finalLogs = await sim!.store.getAttendance();
  assert.equal(finalLogs.length, 3);
});

// =========================================================================
// R4: Device Admin Privileges & CMD_CLEAR_ADMIN
// =========================================================================

test('R4: Admin privileges (role: 14) are wire-visible and CMD_CLEAR_ADMIN clears them', async () => {
  // Clear any existing users
  for (const u of await sim!.store.getUsers()) await sim!.store.deleteUser(u.uid);

  const normalUser: UserRecord = { uid: 301, role: 0, password: '', name: 'Normal User', card: 0, userId: '301' };
  const adminUser: UserRecord = { uid: 302, role: 14, password: '', name: 'Device Admin', card: 0, userId: '302' };

  await zk.executeCmd(COMMANDS.CMD_USER_WRQ, encodeUser(normalUser));
  await zk.executeCmd(COMMANDS.CMD_USER_WRQ, encodeUser(adminUser));

  const users = await zk.getUsers();
  const list = users?.data ?? users;
  const admin = list.find((u: any) => u.userId === '302');
  assert.ok(admin);
  assert.equal(admin.role, 14, 'admin user must have role=14 on wire');

  // Send CMD_CLEAR_ADMIN (command 20)
  const clearReply = await zk.executeCmd(COMMANDS.CMD_CLEAR_ADMIN, '');
  assert.equal(cmdOf(clearReply), COMMANDS.CMD_ACK_OK);

  // Read back: admin user role must be reset to 0
  const afterUsers = await zk.getUsers();
  const afterList = afterUsers?.data ?? afterUsers;
  const clearedAdmin = afterList.find((u: any) => u.userId === '302');
  assert.ok(clearedAdmin);
  assert.equal(clearedAdmin.role, 0, 'admin role must be cleared to 0 (normal user)');
});

// =========================================================================
// R5: Clock Drift and CMD_SET_TIME
// =========================================================================

test('R5: Clock drift injected via REST is corrected by CMD_SET_TIME', async () => {
  // Inject +180 minutes (+3 hours) clock drift via /api/clock
  const driftRes = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/clock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offsetMinutes: 180 }),
  });
  assert.equal(driftRes.status, 200);
  const driftJson = (await driftRes.json()) as { offsetMinutes: number };
  assert.equal(driftJson.offsetMinutes, 180);

  // Device clock reflects +3 hours
  const getTimeReply = await zk.executeCmd(COMMANDS.CMD_GET_TIME, '');
  assert.equal(cmdOf(getTimeReply), COMMANDS.CMD_ACK_OK);
  const rawTime = payloadOf(getTimeReply).readUInt32LE(0);
  const driftedDate = decodeTime(rawTime, 'Asia/Manila');
  const now = new Date();
  const diffHours = (driftedDate.getTime() - now.getTime()) / (3600 * 1000);
  assert.ok(Math.abs(diffHours - 3) < 0.1, `expected ~3h drift, got ${diffHours}`);

  // Send CMD_SET_TIME with exact current time (PHT encoded)
  const timeBuf = Buffer.alloc(4);
  timeBuf.writeUInt32LE(encodeTime(now, 'Asia/Manila'), 0);
  const setReply = await zk.executeCmd(COMMANDS.CMD_SET_TIME, timeBuf);
  assert.equal(cmdOf(setReply), COMMANDS.CMD_ACK_OK);

  // Check /api/clock offset is restored back near 0
  const clockCheck = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/clock`);
  const clockJson = (await clockCheck.json()) as { offsetMinutes: number };
  assert.ok(Math.abs(clockJson.offsetMinutes) <= 1, `offset should be near 0, got ${clockJson.offsetMinutes}`);
});

// =========================================================================
// R6: Fault Injection
// =========================================================================

test('R6: Fault injection endpoints control connection refusal and command errors', async () => {
  try {
    // 1. Error on command (CMD_GET_TIME = 201)
    const setFaultRes = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fault`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ errorOnCommand: COMMANDS.CMD_GET_TIME }),
    });
    assert.equal(setFaultRes.status, 200);

    const errReply = await zk.executeCmd(COMMANDS.CMD_GET_TIME, '');
    assert.equal(cmdOf(errReply), COMMANDS.CMD_ACK_ERROR, 'should return CMD_ACK_ERROR when fault is active');

    // Clear fault
    const clearRes = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fault`, { method: 'DELETE' });
    assert.equal(clearRes.status, 200);

    const okReply = await zk.executeCmd(COMMANDS.CMD_GET_TIME, '');
    assert.equal(cmdOf(okReply), COMMANDS.CMD_ACK_OK, 'should succeed normally after fault cleared');

    // 2. Refuse connections
    await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fault`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refuseConnections: true }),
    });

    const failZk = new ZKLibTCP('127.0.0.1', TCP_PORT, 2000, 5200);
    await assert.rejects(async () => {
      await failZk.createSocket();
      await failZk.connect();
    }, 'connecting must fail when refuseConnections=true');
  } finally {
    // Reset faults
    await fetch(`http://127.0.0.1:${HTTP_PORT}/api/fault/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  }
});

// =========================================================================
// R7: Offline Buffering
// =========================================================================

test('R7: Punches accumulated offline sync with their original timestamps intact', async () => {
  await sim!.store.clearAttendance();
  await sim!.store.upsertUser({ uid: 401, role: 0, password: '', name: 'Offline User', card: 998877, userId: '401' });

  // Disconnect client to simulate device offline
  await zk.disconnect();

  const punchTimes = [
    '2026-10-15T01:00:00.000Z',
    '2026-10-15T05:00:00.000Z',
    '2026-10-15T09:00:00.000Z',
  ];

  for (const pt of punchTimes) {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/punch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: '401', verifyType: 2, timestamp: pt }),
    });
    assert.equal(res.status, 200);
  }

  // Reconnect client
  zk = new ZKLibTCP('127.0.0.1', TCP_PORT, 10000, 5200);
  await zk.createSocket();
  await zk.connect();

  const logs = await zk.getAttendances();
  const list = logs?.data ?? logs;
  assert.equal(list.length, 3);

  const convertPHTtoUTC = (d: Date): string => {
    const rawUTC = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
    return new Date(rawUTC.getTime() - 8 * 3600 * 1000).toISOString();
  };

  const retrievedUtcs = list.map((l: any) => convertPHTtoUTC(new Date(l.recordTime)));

  for (const expectedUtc of punchTimes) {
    assert.ok(retrievedUtcs.includes(expectedUtc), `missing timestamp: ${expectedUtc}`);
  }
});

// =========================================================================
// R8: Large Logs and CMD_CLEAR_ATTLOG
// =========================================================================

test('R8: Large log sets are served and cleared via CMD_CLEAR_ATTLOG', async () => {
  await sim!.store.clearAttendance();
  await sim!.store.upsertUser({ uid: 500, role: 0, password: '', name: 'Bulk User', card: 1234, userId: '500' });

  // Add 100 attendance records
  const baseTime = new Date('2026-10-01T00:00:00.000Z').getTime();
  for (let i = 0; i < 100; i++) {
    await sim!.store.addAttendance({
      userSn: 500,
      deviceUserId: '500',
      verifyType: 1,
      state: 0,
      time: new Date(baseTime + i * 60_000),
    });
  }

  const logs = await zk.getAttendances();
  const list = logs?.data ?? logs;
  assert.equal(list.length, 100, 'must retrieve all 100 records');

  // Clear attendance logs via CMD_CLEAR_ATTLOG (command 15)
  const clearReply = await zk.executeCmd(COMMANDS.CMD_CLEAR_ATTLOG, '');
  assert.equal(cmdOf(clearReply), COMMANDS.CMD_ACK_OK);

  const afterLogs = await zk.getAttendances();
  const afterList = afterLogs?.data ?? afterLogs;
  assert.equal(afterList.length, 0, 'attendance logs must be empty after clear');
});

// =========================================================================
// R9: Realistic Option Strings
// =========================================================================

test('R9: Options query returns realistic K14 profile strings', async () => {
  const optionsToTest = [
    { key: '~SerialNumber', expected: 'VIRT-K14-2026' },
    { key: '~DeviceName', expected: 'BITS-VIRTUAL-K14 (Virtual Terminal)' },
    { key: '~Platform', expected: 'ZEM560_TFT' },
    { key: '~ZKFPVersion', expected: '10' },
    { key: '~OS', expected: '9.0.1' },
    { key: '~OEMVendor', expected: 'ZKTECO-VIRTUAL' },
    { key: '~MaxUserCount', expected: '3000' },
    { key: '~MaxAttLogCount', expected: '100000' },
    { key: '~MaxFingerCount', expected: '3000' },
  ];

  for (const opt of optionsToTest) {
    const rep = await zk.executeCmd(COMMANDS.CMD_OPTIONS_RRQ, opt.key);
    assert.equal(cmdOf(rep), COMMANDS.CMD_ACK_OK, `querying option ${opt.key} must return ACK_OK`);
    const val = payloadOf(rep).toString('ascii').replace(/\0+$/, '');
    assert.equal(val, opt.expected, `option ${opt.key} mismatch`);
  }
});

// =========================================================================
// R10: Real-Time Event Registration (CMD_REG_EVENT / EF_ATTLOG)
// =========================================================================

test('R10: Realtime EF_ATTLOG packets are received when a punch occurs', async () => {
  // Ensure test user exists with enrolled template
  await sim!.store.upsertUser({ uid: 701, role: 0, password: '', name: 'Event User', card: 0, userId: '701' });
  await sim!.store.saveTemplate({
    uid: 701, finger: 0, flag: 1, template: Buffer.alloc(100, 0x5a), format: 'synthetic',
  });

  const received = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no EF_ATTLOG within 6 s')), 6000);
    zk.getRealTimeLogs((log: any) => {
      clearTimeout(timer);
      resolve(log);
    });
  });

  await new Promise((r) => setTimeout(r, 400)); // let registration settle

  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/punch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: '701', verifyType: 1 }),
  });
  assert.equal(res.status, 200);

  const evt = await received;
  assert.ok(evt);
});
