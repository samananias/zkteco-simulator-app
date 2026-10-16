/**
 * Milestone 1 Integration Test: Synthetic Fingerprint Enrollment (G1).
 *
 * Verifies that CMD_STARTENROLL causes the virtual terminal to generate and
 * store a synthetic fingerprint template within a configurable delay, allowing
 * BITS's polling loop (CMD_USERTEMP_RRQ) to succeed without timeout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadConfig } from '../../src/config.js';
import { startSimulator, type SimulatorHandle } from '../../src/server.js';

const require = createRequire(import.meta.url);
let ZKLibTCP: any = null;
let COMMANDS: any = null;
try {
  ZKLibTCP = require('node-zklib/zklibtcp.js');
  COMMANDS = require('node-zklib/constants.js').COMMANDS;
} catch {
  ZKLibTCP = null;
}

const TCP_PORT = 24375;
const HTTP_PORT = 23305;

let sim: SimulatorHandle | null = null;
let zk: any = null;

test.before(async () => {
  sim = await startSimulator(
    loadConfig([
      '--zk-tcp-port', String(TCP_PORT),
      '--zk-http-port', String(HTTP_PORT),
      '--zk-log-level', 'warn',
      '--zk-seed', 'standard', // has user 1001 (uid 1), 1002 (uid 2)
      '--zk-enroll-delay-ms', '400', // fast delay for unit/integration tests
    ]),
  );

  assert.ok(ZKLibTCP, 'node-zklib@1.3.0 must be available');
  const client = new ZKLibTCP('127.0.0.1', TCP_PORT, 10000, 5200);
  if (typeof client.createSocket === 'function') await client.createSocket();
  else await client.connect();
  zk = client;
});

test.after(async () => {
  try {
    await zk?.disconnect?.();
  } catch {
    /* ignore */
  }
  await sim?.stop();
});

const cmdOf = (reply: Buffer): number => reply.readUInt16LE(0);
const payloadOf = (reply: Buffer): Buffer => reply.subarray(8);

test('M1-3 (G1): CMD_STARTENROLL produces a synthetic template readable via CMD_USERTEMP_RRQ', async () => {
  // Finger index 3 is currently unoccupied for user 1001 (uid 1)
  const probeBuf = Buffer.alloc(3);
  probeBuf.writeUInt16LE(1, 0); // uid 1
  probeBuf.writeUInt8(3, 2);    // finger 3

  // 1. Verify slot 3 is initially empty (CMD_ACK_ERROR 2001)
  const initialProbe = await zk.executeCmd(COMMANDS.CMD_USERTEMP_RRQ, probeBuf);
  assert.equal(cmdOf(initialProbe), 2001, 'slot 3 should initially be empty');

  // 2. Send CMD_STARTENROLL (61) for user "1001", finger 3, overwrite 1
  const enrollData = Buffer.alloc(26);
  enrollData.write('1001', 0, 24, 'ascii');
  enrollData.writeInt8(3, 24);
  enrollData.writeInt8(1, 25);

  const startReply = await zk.executeCmd(COMMANDS.CMD_STARTENROLL, enrollData);
  assert.equal(cmdOf(startReply), 2000, 'CMD_STARTENROLL should reply CMD_ACK_OK');

  // 3. Poll for template until ready (simulate BITS polling loop)
  const deadline = Date.now() + 3000;
  let templateFound = false;
  let templateBuffer: Buffer | null = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const reply = await zk.executeCmd(COMMANDS.CMD_USERTEMP_RRQ, probeBuf);
    if (cmdOf(reply) === 1501) { // CMD_DATA
      templateFound = true;
      templateBuffer = payloadOf(reply);
      break;
    }
  }

  assert.ok(templateFound, 'Template must be found within delay deadline');
  assert.ok(templateBuffer && templateBuffer.length > 500, `Template size must be > 500 B, got ${templateBuffer?.length}`);

  // Header verification: [reportedSize: u16][uid: u16][finger: u8][flag: u8][SS21...]
  const reportedSize = templateBuffer.readUInt16LE(0);
  const reportedUid = templateBuffer.readUInt16LE(2);
  const reportedFinger = templateBuffer.readUInt8(4);
  const reportedFlag = templateBuffer.readUInt8(5);
  const marker = templateBuffer.toString('ascii', 6, 10);

  assert.equal(reportedUid, 1);
  assert.equal(reportedFinger, 3);
  assert.equal(reportedFlag, 1);
  assert.equal(marker, 'SS21', 'Template blob must carry synthetic marker');
  assert.ok(reportedSize <= templateBuffer.length);
});

test('M1-3 (G1): CMD_CANCELCAPTURE cancels pending synthetic enrollment', async () => {
  const probeBuf = Buffer.alloc(3);
  probeBuf.writeUInt16LE(1, 0); // uid 1
  probeBuf.writeUInt8(4, 2);    // finger 4

  // Verify slot 4 is initially empty
  const initialProbe = await zk.executeCmd(COMMANDS.CMD_USERTEMP_RRQ, probeBuf);
  assert.equal(cmdOf(initialProbe), 2001);

  // Send CMD_STARTENROLL for finger 4
  const enrollData = Buffer.alloc(26);
  enrollData.write('1001', 0, 24, 'ascii');
  enrollData.writeInt8(4, 24);
  enrollData.writeInt8(1, 25);
  const startReply = await zk.executeCmd(COMMANDS.CMD_STARTENROLL, enrollData);
  assert.equal(cmdOf(startReply), 2000);

  // Immediately cancel capture before the 400ms delay
  const cancelReply = await zk.executeCmd(COMMANDS.CMD_CANCELCAPTURE, '');
  assert.equal(cmdOf(cancelReply), 2000, 'CMD_CANCELCAPTURE must return CMD_ACK_OK');

  // Wait 600ms (longer than enroll delay)
  await new Promise((r) => setTimeout(r, 600));

  // Verify slot 4 is STILL empty
  const afterCancelProbe = await zk.executeCmd(9, probeBuf);
  assert.equal(cmdOf(afterCancelProbe), 2001, 'Cancelled enrollment must not save a template');
});
