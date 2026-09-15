/**
 * Phase 5 gate: ZK_STORE=sqlite — same oracle suite, persistent backend.
 * Uses a throwaway database file; proves the Store seam (ADR-008) end to end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig } from '../../src/config.js';
import { startSimulator, type SimulatorHandle } from '../../src/server.js';

const require = createRequire(import.meta.url);
let ZKLibTCP: any = null;
try {
  ZKLibTCP = require('node-zklib/zklibtcp.js');
} catch {
  ZKLibTCP = null;
}

const TCP_PORT = 24371;
const HTTP_PORT = 23301;
const dir = mkdtempSync(path.join(tmpdir(), 'zksim-'));
const dbPath = path.join(dir, 'device.sqlite');

let sim: SimulatorHandle | null = null;
let zk: any = null;

test.before(async () => {
  sim = await startSimulator(
    loadConfig([
      '--zk-tcp-port', String(TCP_PORT),
      '--zk-http-port', String(HTTP_PORT),
      '--zk-log-level', 'warn',
      '--zk-store', 'sqlite',
      '--zk-sqlite-path', dbPath,
    ]),
  );
  assert.ok(ZKLibTCP, 'node-zklib@1.3.0 must be installed');
  const client = new ZKLibTCP('127.0.0.1', TCP_PORT, 10000, 5200);
  if (typeof client.createSocket === 'function') await client.createSocket();
  else await client.connect();
  zk = client;
});

test.after(async () => {
  try {
    await zk?.disconnect?.();
  } catch {
    /* device may close first */
  }
  await sim?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('sqlite store: oracle reads seeded users and attendance', async () => {
  const info = await zk.getInfo();
  assert.ok(info.userCounts >= 5, `userCounts=${info.userCounts}`);

  const result = await zk.getUsers();
  const users = result?.data ?? result;
  assert.ok(users.length >= 5);
  assert.ok(users.some((u: any) => u.name === 'Dela Cruz, Ana'));

  let logs = await zk.getAttendances();
  if (!Array.isArray(logs)) logs = logs?.data ?? [];
  assert.ok(logs.length >= 1);
});

test('sqlite store: protocol writes persist across the connection', async () => {
  const user = { uid: 91, role: 0, password: '', name: 'SQLite Persist', card: 0, userId: '1091' };
  assert.equal((await zk.executeCmd(8, Buffer.alloc(0))).constructor, Buffer); // shape sanity
  const reply = await zk.executeCmd(8, Buffer.from([91, 0, 0, 14, 0, 0, 0, 0, 0, 0, 0])); // too short → ERROR expected
  assert.equal(reply.readUInt16LE(0), 2001);

  // a proper 72 B write
  const rec = Buffer.alloc(72);
  rec.writeUInt16LE(91, 0);
  rec.writeUInt8(0, 2);
  rec.write('SQLite Persist', 11, 'ascii');
  rec.write('1091', 48, 'ascii');
  const ok = await zk.executeCmd(8, rec);
  assert.equal(ok.readUInt16LE(0), 2000);

  const result = await zk.getUsers();
  const users = result?.data ?? result;
  assert.ok(users.some((u: any) => u.name === 'SQLite Persist'));

  const del = Buffer.alloc(11);
  del.writeUInt16LE(91, 0);
  del.write('1091', 2, 'ascii');
  assert.equal((await zk.executeCmd(18, del)).readUInt16LE(0), 2000);
});

test('sqlite store: REST snapshot reflects the persistent backend', async () => {
  const state = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/api/device/state`)).json();
  assert.ok(state.counts.users >= 5);
  const attendance = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/api/attendance`)).json();
  assert.ok(Array.isArray(attendance.attendance));
});
