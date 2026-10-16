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

/** Extract calendar components for a specific timezone (or host local if unspecified/local). */
export function getZonedTimeFields(date: Date, timeZone?: string): DeviceTime {
  if (!timeZone || timeZone === 'local') {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    };
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  let year = date.getUTCFullYear();
  let month = date.getUTCMonth() + 1;
  let day = date.getUTCDate();
  let hour = date.getUTCHours();
  let minute = date.getUTCMinutes();
  let second = date.getUTCSeconds();

  for (const part of parts) {
    if (part.type === 'year') year = Number.parseInt(part.value, 10);
    else if (part.type === 'month') month = Number.parseInt(part.value, 10);
    else if (part.type === 'day') day = Number.parseInt(part.value, 10);
    else if (part.type === 'hour') {
      const h = Number.parseInt(part.value, 10);
      hour = h === 24 ? 0 : h;
    } else if (part.type === 'minute') minute = Number.parseInt(part.value, 10);
    else if (part.type === 'second') second = Number.parseInt(part.value, 10);
  }

  return { year, month, day, hour, minute, second };
}

/** Encode a `Date` into device u32 with timezone awareness (e.g. Asia/Manila). */
export function encodeTime(date: Date, timeZone?: string): number {
  const f = getZonedTimeFields(date, timeZone);
  const days =
    (f.year - DEVICE_YEAR_BASE) * DEVICE_MONTHS_PER_YEAR * DEVICE_DAYS_PER_MONTH +
    (f.month - 1) * DEVICE_DAYS_PER_MONTH +
    (f.day - 1);
  return (
    days * DEVICE_SECONDS_PER_DAY +
    (f.hour * 60 + f.minute) * 60 +
    f.second
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

export function decodeTime(value: number, timeZone?: string): Date {
  const f = decodeTimeFields(value);
  if (!timeZone || timeZone === 'local') {
    return new Date(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  }
  if (timeZone === 'Asia/Manila' || timeZone === 'UTC+8' || timeZone === 'Etc/GMT-8') {
    return new Date(Date.UTC(f.year, f.month - 1, f.day, f.hour - 8, f.minute, f.second));
  }
  const approximateUtc = new Date(Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second));
  const zoned = getZonedTimeFields(approximateUtc, timeZone);
  const offsetMs = approximateUtc.getTime() - Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
  return new Date(approximateUtc.getTime() + offsetMs);
}

/**
 * Realtime event time — 6 raw bytes: [year-2000][month][day][hour][minute][second].
 *
 * The oracle decodes these with `readUIntLE` per byte (`parseHexToTime`), i.e. plain
 * binary values, NOT BCD. We encode binary to satisfy the pinned oracle.
 */
export function encodeTimeBytes(date: Date, timeZone?: string): Buffer {
  const f = getZonedTimeFields(date, timeZone);
  return Buffer.from([
    f.year - DEVICE_YEAR_BASE,
    f.month,
    f.day,
    f.hour,
    f.minute,
    f.second,
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
