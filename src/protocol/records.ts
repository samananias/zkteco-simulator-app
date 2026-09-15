/**
 * Record codecs — byte-level layouts verified in
 * docs/simulator-docs/research/zk-protocol-notes.md §5.
 *
 * User record        : 72 B (TFT/TCP; node-zklib 1.3.0 + BITS driver agree)
 * Attendance record  : 40 B
 * Realtime event rec : 32 B (EF_ATTLOG)
 * Dataset frame      : [u32-LE total bytes of records][records…]
 */
import { encodeTime, decodeTime } from './timecodec.js';

export const USER_RECORD_SIZE = 72;
export const ATT_RECORD_SIZE = 40;
export const EVENT_RECORD_SIZE = 32;
export const DATASET_PREFIX_SIZE = 4;

export interface UserRecord {
  uid: number;
  role: number;
  password: string;
  name: string;
  card: number;
  userId: string;
}

export interface AttendanceRecord {
  userSn: number;
  deviceUserId: string;
  verifyType: number;
  state: number;
  time: Date;
}

function writeAscii(buf: Buffer, offset: number, size: number, value: string): void {
  const bytes = Buffer.from(value, 'ascii');
  bytes.copy(buf, offset, 0, Math.min(bytes.length, size));
}

function readAscii(buf: Buffer, offset: number, size: number): string {
  const end = offset + size;
  let stop = offset;
  while (stop < end && buf[stop] !== 0x00) stop++;
  return buf.toString('ascii', offset, stop);
}

export function encodeUser(user: UserRecord): Buffer {
  const buf = Buffer.alloc(USER_RECORD_SIZE);
  buf.writeUInt16LE(user.uid & 0xffff, 0);
  buf.writeUInt8(user.role & 0xff, 2);
  writeAscii(buf, 3, 8, user.password);
  writeAscii(buf, 11, 24, user.name);
  buf.writeUInt32LE(user.card >>> 0, 35);
  writeAscii(buf, 48, 9, user.userId);
  return buf;
}

export function decodeUser(buf: Buffer, offset = 0): UserRecord {
  return {
    uid: buf.readUInt16LE(offset + 0),
    role: buf.readUInt8(offset + 2),
    password: readAscii(buf, offset + 3, 8),
    name: readAscii(buf, offset + 11, 24),
    card: buf.readUInt32LE(offset + 35),
    userId: readAscii(buf, offset + 48, 9),
  };
}

/**
 * Accepts both published write variants:
 *  - 73 B: pyzk `repack73` prepends a 0x02 tag byte.
 *  - 72 B: BITS driver writes the plain record (no tag).
 */
export function decodeUserWrite(payload: Buffer): UserRecord | null {
  if (payload.length >= USER_RECORD_SIZE + 1 && payload[0] === 0x02) {
    const inner = payload.subarray(1);
    const user = decodeUser(inner, 0);
    // pyzk packs the trailing byte of the 9-B userId field as its length; normalise.
    return user;
  }
  if (payload.length >= USER_RECORD_SIZE) {
    return decodeUser(payload, 0);
  }
  return null;
}

export function encodeAttendance(rec: AttendanceRecord): Buffer {
  const buf = Buffer.alloc(ATT_RECORD_SIZE);
  buf.writeUInt16LE(rec.userSn & 0xffff, 0);
  writeAscii(buf, 2, 9, rec.deviceUserId);
  buf.writeUInt8(rec.verifyType & 0xff, 26);
  buf.writeUInt32LE(encodeTime(rec.time) >>> 0, 27);
  buf.writeUInt8(rec.state & 0xff, 31);
  buf.writeUInt8(0x00, 32);
  buf.writeUInt8(0x00, 33);
  buf.writeUInt8(0x00, 34);
  buf.writeUInt8(0x00, 35);
  buf.writeUInt8(0xff, 36);
  buf.writeUInt8(0x00, 37);
  buf.writeUInt8(0x00, 38);
  buf.writeUInt8(0x00, 39);
  return buf;
}

export function decodeAttendance(buf: Buffer, offset = 0): AttendanceRecord {
  return {
    userSn: buf.readUInt16LE(offset + 0),
    deviceUserId: readAscii(buf, offset + 2, 9),
    verifyType: buf.readUInt8(offset + 26),
    time: decodeTime(buf.readUInt32LE(offset + 27)),
    state: buf.readUInt8(offset + 31),
  };
}

/** Realtime EF_ATTLOG payload (32 B). Time is the 6-byte raw form. */
export function encodeEventRecord(rec: AttendanceRecord, deviceTime: Date): Buffer {
  const buf = Buffer.alloc(EVENT_RECORD_SIZE);
  writeAscii(buf, 0, 9, rec.deviceUserId);
  buf.writeUInt16LE(rec.verifyType & 0xffff, 24);
  buf.writeUInt8((deviceTime.getFullYear() - 2000) & 0xff, 26);
  buf.writeUInt8(deviceTime.getMonth() + 1, 27);
  buf.writeUInt8(deviceTime.getDate(), 28);
  buf.writeUInt8(deviceTime.getHours(), 29);
  buf.writeUInt8(deviceTime.getMinutes(), 30);
  buf.writeUInt8(deviceTime.getSeconds(), 31);
  return buf;
}

/** Dataset frame: 4-byte LE total length followed by the records. */
export function encodeDataset(records: readonly Buffer[]): Buffer {
  const body = Buffer.concat(records.map((r) => Buffer.from(r)));
  const out = Buffer.alloc(DATASET_PREFIX_SIZE + body.length);
  out.writeUInt32LE(body.length, 0);
  body.copy(out, DATASET_PREFIX_SIZE);
  return out;
}

export function decodeDataset(buf: Buffer): { total: number; body: Buffer } {
  if (buf.length < DATASET_PREFIX_SIZE) return { total: 0, body: Buffer.alloc(0) };
  const total = buf.readUInt32LE(0);
  return { total, body: buf.subarray(DATASET_PREFIX_SIZE) };
}

/** Fingerprint template read entry: [entrySize u16][uid u16][fid u8][flag u8][bytes…] */
export function encodeTemplateEntry(
  uid: number,
  finger: number,
  flag: number,
  template: Buffer,
): Buffer {
  const out = Buffer.alloc(6 + template.length);
  out.writeUInt16LE(6 + template.length, 0);
  out.writeUInt16LE(uid & 0xffff, 2);
  out.writeUInt8(finger & 0xff, 4);
  out.writeUInt8(flag & 0xff, 5);
  template.copy(out, 6);
  return out;
}
