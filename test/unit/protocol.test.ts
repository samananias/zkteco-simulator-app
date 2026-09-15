/**
 * Phase-1 golden-byte unit tests (testing-strategy L1/L2).
 * The checksum reference here is an INDEPENDENT implementation so a bug in
 * src/protocol/checksum.ts cannot validate itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeChecksum } from '../../src/protocol/checksum.js';
import { encodePacket, FrameParser } from '../../src/protocol/frame.js';
import { encodeTime, decodeTime } from '../../src/protocol/timecodec.js';
import {
  encodeUser, decodeUser, decodeUserWrite, encodeAttendance, decodeAttendance,
  encodeEventRecord, encodeDataset, decodeDataset, encodeTemplateEntry,
  USER_RECORD_SIZE, ATT_RECORD_SIZE, EVENT_RECORD_SIZE,
} from '../../src/protocol/records.js';
import { loadConfig, ConfigError } from '../../src/config.js';

/** reference checksum built from the spec/published implementations */
function refChecksum(buf: Buffer, variant: 'classic' | 'oracle'): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    sum += i + 1 < buf.length ? buf[i] | (buf[i + 1] << 8) : buf[i];
    sum %= 65535;
  }
  const s = sum & 0xffff;
  return variant === 'classic' ? (65535 - s) & 0xffff : (65534 - s) & 0xffff;
}

test('checksum variants match the independent reference', () => {
  const samples = [
    Buffer.from('5050827d08000000100000000000', 'hex'),
    Buffer.from([0xe8, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00]),
    Buffer.alloc(0),
    Buffer.from([1, 2, 3]), // odd tail byte
  ];
  for (const buf of samples) {
    assert.equal(computeChecksum(buf, 'classic'), refChecksum(buf, 'classic'), `classic ${buf.toString('hex')}`);
    assert.equal(computeChecksum(buf, 'oracle'), refChecksum(buf, 'oracle'), `oracle ${buf.toString('hex')}`);
    // the two published variants differ by exactly one (notes §2)
    assert.equal((refChecksum(buf, 'classic') - refChecksum(buf, 'oracle')) & 0xffff, 1);
  }
});

test('frame roundtrip: prefix, length, fields, payload', () => {
  const payload = Buffer.from('hello-device', 'ascii');
  const packet = encodePacket({ command: 1000, sessionId: 30646, replyId: 7, payload });
  assert.deepEqual([...packet.subarray(0, 4)], [0x50, 0x50, 0x82, 0x7d]);
  assert.equal(packet.readUInt16LE(4), 8 + payload.length); // frame length excludes the prefix
  assert.equal(packet.readUInt16LE(6), 0);

  const frames = new FrameParser().push(packet);
  assert.equal(frames.length, 1);
  const f = frames[0];
  assert.equal(f.command, 1000);
  assert.equal(f.sessionId, 30646);
  assert.equal(f.replyId, 7);
  assert.deepEqual([...f.payload], [...payload]);
});

test('frame parser reassembles packets split across TCP chunks', () => {
  const packet = encodePacket({ command: 9, sessionId: 1, replyId: 2, payload: Buffer.alloc(20, 0xaa) });
  const parser = new FrameParser();
  assert.deepEqual(parser.push(packet.subarray(0, 5)), []); // partial prefix
  const mid = parser.push(packet.subarray(5, 13));
  assert.deepEqual(mid, []); // header not complete
  const done = parser.push(packet.subarray(13));
  assert.equal(done.length, 1);
  assert.equal(done[0].command, 9);
  assert.equal(done[0].payload.length, 20);
});

test('frame parser handles coalesced packets', () => {
  const a = encodePacket({ command: 201, sessionId: 2, replyId: 3 });
  const b = encodePacket({ command: 1000, sessionId: 2, replyId: 1 });
  const frames = new FrameParser().push(Buffer.concat([a, b]));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].command, 201);
  assert.equal(frames[1].command, 1000);
});

test('device time codec: 372-day calendar (notes §6)', () => {
  assert.equal(encodeTime(new Date(2000, 0, 1, 0, 0, 0)), 0);
  // 2026-09-15 11:29:05 — months use 31 days, never the real calendar
  const expected = ((2026 - 2000) * 12 * 31 + 8 * 31 + 14) * 86400 + (11 * 60 + 29) * 60 + 5;
  assert.equal(encodeTime(new Date(2026, 8, 15, 11, 29, 5)), expected);
  const back = decodeTime(expected);
  assert.deepEqual(
    [back.getFullYear(), back.getMonth(), back.getDate(), back.getHours(), back.getMinutes(), back.getSeconds()],
    [2026, 8, 15, 11, 29, 5],
  );
});

test('user record: 72 B layout and both write variants', () => {
  const user = { uid: 3, role: 0, password: '', name: 'Dela Cruz, Ana', card: 0, userId: '1' };
  const buf = encodeUser(user);
  assert.equal(buf.length, USER_RECORD_SIZE);
  assert.equal(buf.readUInt16LE(0), 3);
  assert.equal(buf.toString('ascii', 11, 11 + 'Dela Cruz, Ana'.length), 'Dela Cruz, Ana');
  assert.equal(buf.toString('ascii', 48, 57).replace(/\0.*$/, ''), '1');
  const back = decodeUser(buf, 0);
  assert.equal(back.name, 'Dela Cruz, Ana');

  // 72 B plain (BITS driver) and 73 B tagged (pyzk repack73)
  assert.deepEqual(decodeUserWrite(buf), user);
  const from73 = decodeUserWrite(Buffer.concat([Buffer.from([0x02]), buf]));
  assert.ok(from73);
  assert.equal(from73?.name, 'Dela Cruz, Ana');
  assert.equal(decodeUserWrite(Buffer.alloc(10)), null);
});

test('attendance record: 40 B layout', () => {
  const rec = { userSn: 2, deviceUserId: '2', verifyType: 1, state: 0, time: new Date(2026, 8, 15, 8, 0, 0) };
  const buf = encodeAttendance(rec);
  assert.equal(buf.length, ATT_RECORD_SIZE);
  assert.equal(buf.readUInt16LE(0), 2);
  assert.equal(buf.toString('ascii', 2, 11).replace(/\0.*$/, ''), '2');
  assert.equal(buf.readUInt8(26), 1);
  assert.equal(buf.readUInt8(31), 0);
  assert.equal(buf[36], 0xff); // fixed tail (notes §5)
  const back = decodeAttendance(buf, 0);
  assert.equal(back.deviceUserId, '2');
  assert.deepEqual([back.time.getHours(), back.time.getMinutes()], [8, 0]);
});

test('realtime event record: 32 B with 6-byte raw time', () => {
  const rec = { userSn: 1, deviceUserId: '1', verifyType: 1, state: 0, time: new Date(2026, 8, 15, 7, 42, 15) };
  const buf = encodeEventRecord(rec, rec.time);
  assert.equal(buf.length, EVENT_RECORD_SIZE);
  assert.equal(buf.toString('ascii', 0, 1), '1');
  assert.equal(buf.readUInt16LE(24), 1);
  assert.deepEqual([...buf.subarray(26, 32)], [26, 9, 15, 7, 42, 15]); // 20YY MM DD HH MM SS
});

test('dataset frame: u32 total then records', () => {
  const users = [
    encodeUser({ uid: 1, role: 0, password: '', name: 'A', card: 0, userId: '1' }),
    encodeUser({ uid: 2, role: 0, password: '', name: 'B', card: 0, userId: '2' }),
  ];
  const ds = encodeDataset(users);
  const { total, body } = decodeDataset(ds);
  assert.equal(total, 2 * USER_RECORD_SIZE);
  assert.equal(body.length, total);
  assert.equal(decodeUser(body, USER_RECORD_SIZE).name, 'B');
});

test('template entry: 6-byte header then blob (FR-8)', () => {
  const tpl = Buffer.alloc(512, 0x5a);
  const entry = encodeTemplateEntry(4, 1, 1, tpl);
  assert.equal(entry.readUInt16LE(0), 6 + tpl.length);
  assert.equal(entry.readUInt16LE(2), 4);
  assert.equal(entry.readUInt8(4), 1);
  assert.equal(entry.readUInt8(5), 1);
  assert.equal(entry.subarray(6).length, 512);
});

test('configuration: defaults, env, CLI, validation', () => {
  const cfg = loadConfig([], {});
  assert.equal(cfg.tcpPort, 4370);
  assert.equal(cfg.httpPort, 3000);
  assert.equal(cfg.commKey, 0); // BITS backend default — auth disabled
  assert.equal(cfg.readMode, 'direct');

  const env = loadConfig([], { ZK_TCP_PORT: '4371', ZK_LOG_LEVEL: 'debug' });
  assert.equal(env.tcpPort, 4371);
  assert.equal(env.logLevel, 'debug');

  const cli = loadConfig(['--zk-http-port', '3001'], {});
  assert.equal(cli.httpPort, 3001);

  assert.throws(() => loadConfig([], { ZK_TCP_PORT: 'nope' }), ConfigError);
  assert.throws(() => loadConfig([], { ZK_TCP_PORT: '99999' }), ConfigError);
  assert.throws(() => loadConfig([], { ZK_SEED: 'bogus' }), ConfigError);
  assert.throws(() => loadConfig(['--no-such-flag', 'x'], {}), ConfigError);
});

