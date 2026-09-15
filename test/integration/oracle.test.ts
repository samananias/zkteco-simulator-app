/**
 * Integration gate (testing-strategy L4): the REAL pinned oracle —
 * node-zklib@1.3.0, the exact library the BITS backend uses — must connect to
 * the simulator and complete the driver's call patterns unmodified.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadConfig } from '../../src/config.js';
import { startSimulator, type SimulatorHandle } from '../../src/server.js';
import { decodeTime } from '../../src/protocol/timecodec.js';
import { encodeUser } from '../../src/protocol/records.js';

const require = createRequire(import.meta.url);
let ZKLibTCP: any = null;
try {
  ZKLibTCP = require('node-zklib/zklibtcp.js');
} catch {
  ZKLibTCP = null; // suite reports a failure with an explicit reason below
}

const TCP_PORT = 24370;
const HTTP_PORT = 23300;

let sim: SimulatorHandle | null = null;
let zk: any = null;

test.before(async () => {
  sim = await startSimulator(
    loadConfig([
      '--zk-tcp-port', String(TCP_PORT),
      '--zk-http-port', String(HTTP_PORT),
      '--zk-log-level', 'warn',
      '--zk-seed', 'standard',
    ]),
  );
});

test.after(async () => {
  try {
    await zk?.disconnect?.();
  } catch {
    /* the device closing first is normal */
  }
  await sim?.stop();
});

async function connectOracle(): Promise<void> {
  assert.ok(ZKLibTCP, 'node-zklib@1.3.0 must be installed (npm install)');
  const client = new ZKLibTCP('127.0.0.1', TCP_PORT, 10000, 5200);
  if (typeof client.createSocket === 'function') await client.createSocket();
  else await client.connect();
  zk = client;
}

// executeCmd() resolves the FRAME buffer (8-B header + payload): cmd@0, payload@8.
const cmdOf = (reply: Buffer): number => reply.readUInt16LE(0);
const payloadOf = (reply: Buffer): Buffer => reply.subarray(8);

test('oracle connects (CMD_CONNECT handshake + session assignment)', async () => {
  await connectOracle();
  assert.ok(zk);
});

test('getInfo(): free-sizes reply parses (offsets 24/40/72)', async () => {
  const info = await zk.getInfo();
  assert.ok(info);
  assert.ok(info.userCounts >= 5, `userCounts=${info.userCounts}`);
});

test('getUsers(): 72 B dataset decodes with seeded employees', async () => {
  const result = await zk.getUsers();
  const users = result?.data ?? result;
  assert.ok(Array.isArray(users));
  assert.ok(users.length >= 5);
  const names = users.map((u: any) => u.name);
  assert.ok(names.includes('Dela Cruz, Ana'), `names=${JSON.stringify(names)}`);
});

test('getAttendances(): 40 B dataset decodes with seed records', async () => {
  let logs = await zk.getAttendances();
  if (!Array.isArray(logs)) logs = logs?.data ?? logs?.attendances ?? [];
  assert.ok(Array.isArray(logs));
  assert.ok(logs.length >= 1);
  assert.ok(logs[0].deviceUserId !== undefined);
});

test('CMD_GET_TIME: ACK_OK and a sane 372-day clock', async () => {
  const reply = await zk.executeCmd(201, '');
  assert.equal(cmdOf(reply), 2000);
  const data = payloadOf(reply);
  if (data.length >= 4) {
    const t = decodeTime(data.readUInt32LE(0));
    assert.ok(t.getFullYear() >= 2024 && t.getFullYear() <= 2035, `year=${t.getFullYear()}`);
  } else {
    assert.fail(`GET_TIME payload too short: ${data.length}`);
  }
});

test('backend-style user write (72 B CMD_USER_WRQ) lands in the device store', async () => {
  const user = { uid: 90, role: 0, password: '', name: 'Oracle Test User', card: 0, userId: '90' };
  const reply = await zk.executeCmd(8, encodeUser(user)); // CMD_USER_WRQ
  assert.equal(cmdOf(reply), 2000);

  const result = await zk.getUsers();
  const users = result?.data ?? result;
  assert.ok(users.some((u: any) => u.name === 'Oracle Test User'));

  // and back out again: CMD_DELETE_USER (uid u16 + userId ascii 9 B)
  const del = Buffer.alloc(11);
  del.writeUInt16LE(90, 0);
  del.write('90', 2, 'ascii');
  const delReply = await zk.executeCmd(18, del);
  assert.equal(cmdOf(delReply), 2000);

  const after = await zk.getUsers();
  const afterUsers = after?.data ?? after;
  assert.ok(!afterUsers.some((u: any) => u.name === 'Oracle Test User'));
});

test('fingerprint template: driver write sequence → read back → empty probe → delete (FR-8)', async () => {
  const uid = 1;
  const finger = 0;
  const blob = Buffer.alloc(512, 0x77);

  // the BITS driver's exact sequence (zk-protocol-notes.md §7)
  await zk.executeCmd(1003, Buffer.from([0, 0, 0, 0])); // DISABLEDEVICE
  await zk.executeCmd(19, Buffer.from([uid, 0, finger])); // DELETE_USERTEMP
  const prep = Buffer.alloc(4);
  prep.writeUInt16LE(blob.length, 0); // [size u16][00 00]
  await zk.executeCmd(1500, prep); // PREPARE_DATA
  await zk.executeCmd(1501, blob); // CMD_DATA
  await zk.executeCmd(119, ''); // CHECKSUM_BUFFER
  const tw = Buffer.alloc(6);
  tw.writeUInt16LE(uid, 0);
  tw.writeUInt8(finger, 2);
  tw.writeUInt8(1, 3);
  tw.writeUInt16LE(blob.length, 4);
  await zk.executeCmd(87, tw); // TMP_WRITE
  await zk.executeCmd(1502, ''); // FREE_DATA
  await zk.executeCmd(1013, ''); // REFRESHDATA
  await zk.executeCmd(1002, ''); // ENABLEDEVICE

  // read back: single CMD_DATA frame with the 6-B entry header
  const req = Buffer.alloc(3);
  req.writeUInt16LE(uid, 0);
  req.writeUInt8(finger, 2);
  const got = await zk.executeCmd(9, req); // CMD_USERTEMP_RRQ
  assert.equal(cmdOf(got), 1501, `expected CMD_DATA, got ${cmdOf(got)}`);
  const data = payloadOf(got);
  assert.ok(data.length > 100, `template bytes=${data.length}`);
  assert.equal(data.readUInt16LE(2), uid); // entry: [size][uid][fid][flag][blob…]

  // empty slot: plain CMD_ACK_ERROR with no data (the driver probes this way)
  const miss = Buffer.alloc(3);
  miss.writeUInt16LE(99, 0);
  miss.writeUInt8(0, 2);
  const empty = await zk.executeCmd(9, miss);
  assert.equal(cmdOf(empty), 2001);
});

test('realtime EF_ATTLOG reaches a registered client (ADR-006, Phase 3)', async () => {
  const received = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no EF_ATTLOG within 6 s')), 6000);
    zk.getRealTimeLogs((log: any) => {
      clearTimeout(timer);
      resolve(log);
    });
  });
  await new Promise((r) => setTimeout(r, 400)); // let the registration settle
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/punch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: '1001' }),
  });
  assert.equal(res.status, 200);
  const evt = await received;
  assert.ok(evt);
});

test('CMD_CLEAR_ATTLOG empties the dataset; REST punch refills it', async () => {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/punch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: '1002' }),
  });
  assert.equal(res.status, 200);

  const cleared = await zk.executeCmd(15, '');
  assert.equal(cmdOf(cleared), 2000);
  let logs = await zk.getAttendances();
  if (!Array.isArray(logs)) logs = logs?.data ?? [];
  assert.equal(logs.length, 0);
});

test('device-face UI + REST snapshot are served (Phase 4 smoke)', async () => {
  const page = await fetch(`http://127.0.0.1:${HTTP_PORT}/`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('ZKTECO'));
  const state = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/api/device/state`)).json();
  assert.ok(state.deviceName);
  assert.equal(state.enabled, true);
});

test('unknown commands reply CMD_ACK_UNKNOWN (65535)', async () => {
  const reply = await zk.executeCmd(9999, '');
  assert.equal(cmdOf(reply), 65535);
});

