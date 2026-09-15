/**
 * ZKTeco device time codec.
 *
 * NOT unix time. The device uses a 372-day "year": 12 months x 31 days.
 *
 *   seconds = ((year-2000)*12*31 + (month-1)*31 + (day-1)) * 86400
 *           + (hour*60 + minute)*60 + second
 *
 * Verified identical in pyzk, node-zklib 1.3.0 and the BITS driver
 * (docs/simulator-docs/research/zk-protocol-notes.md §6). Getting this wrong
 * silently corrupts every attendance timestamp, which is why it is one module
 * with exhaustive round-trip tests.
 */

export const DEVICE_YEAR_BASE = 2000;
export const DEVICE_DAYS_PER_MONTH = 31;
export const DEVICE_MONTHS_PER_YEAR = 12;
export const DEVICE_SECONDS_PER_DAY = 86400;

export interface DeviceTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
}

/** Encode a host `Date` (local fields, as the device shows them) into device u32. */
export function encodeTime(date: Date): number {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const days =
    (year - DEVICE_YEAR_BASE) * DEVICE_MONTHS_PER_YEAR * DEVICE_DAYS_PER_MONTH +
    (month - 1) * DEVICE_DAYS_PER_MONTH +
    (day - 1);
  return (
    days * DEVICE_SECONDS_PER_DAY +
    (date.getHours() * 60 + date.getMinutes()) * 60 +
    date.getSeconds()
  );
}

/** Decode a device u32 into calendar fields. */
export function decodeTimeFields(value: number): DeviceTime {
  let rest = value;
  const second = rest % 60;
  rest = (rest - second) / 60;
  const minute = rest % 60;
  rest = (rest - minute) / 60;
  const hour = rest % 24;
  rest = (rest - hour) / 24;
  const day = (rest % DEVICE_DAYS_PER_MONTH) + 1;
  rest = (rest - (day - 1)) / DEVICE_DAYS_PER_MONTH;
  const month = (rest % DEVICE_MONTHS_PER_YEAR) + 1;
  rest = (rest - (month - 1)) / DEVICE_MONTHS_PER_YEAR;
  return { year: rest + DEVICE_YEAR_BASE, month, day, hour, minute, second };
}

export function decodeTime(value: number): Date {
  const f = decodeTimeFields(value);
  return new Date(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
}

/**
 * Realtime event time — 6 raw bytes: [year-2000][month][day][hour][minute][second].
 *
 * The oracle decodes these with `readUIntLE` per byte (`parseHexToTime`), i.e. plain
 * binary values, NOT BCD. We encode binary to satisfy the pinned oracle; the spec's
 * worked example is ambiguous on this point, recorded as an open item in the notes.
 */
export function encodeTimeBytes(date: Date): Buffer {
  return Buffer.from([
    date.getFullYear() - DEVICE_YEAR_BASE,
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ]);
}

export function decodeTimeBytes(buf: Buffer, offset = 0): Date {
  return new Date(
    DEVICE_YEAR_BASE + buf.readUInt8(offset),
    buf.readUInt8(offset + 1) - 1,
    buf.readUInt8(offset + 2),
    buf.readUInt8(offset + 3),
    buf.readUInt8(offset + 4),
    buf.readUInt8(offset + 5),
  );
}
