/**
 * Seed profiles (FR-12 / roadmap Phase 2-5).
 *
 * `standard` — a small but realistic roster: 5 employees, ~1 week of punches,
 *              synthetic fingerprint templates for two fingers each.
 *              Contains **no real personal data** (NFR-07): names are invented.
 * `empty`    — a fresh device: no users, no records, templates only for nothing.
 */
import { createHash } from 'node:crypto';
import type { AttendanceRecord, UserRecord } from '../protocol/records.js';
import type { FingerprintTemplate } from './types.js';
import type { Store } from './types.js';

export type SeedProfile = 'standard' | 'empty';

/** Synthetic template: structurally plausible (≥500 B, SS21-style header), never real. */
export function syntheticTemplate(uid: number, finger: number): Buffer {
  const body = Buffer.alloc(512);
  body.write('SS21', 0, 'ascii');
  const digest = createHash('sha256').update(`synthetic:${uid}:${finger}`).digest();
  for (let i = 0; i < body.length - 8; i++) {
    body[8 + i] = digest[i % digest.length]! ^ ((i * 31 + uid + finger) & 0xff);
  }
  body.writeUInt16LE(512 - 6, 6);
  return body;
}

const NAMES = ['Dela Cruz, Ana', 'Reyes, Ben', 'Santos, Cora', 'Bautista, Dan', 'Ocampo, Ella'];

const USERS: UserRecord[] = NAMES.map((name, i) => ({
  uid: i + 1,
  role: i === 0 ? 14 : 0,
  password: '',
  name,
  card: 0,
  userId: String(1001 + i),
}));

/** Builds a deterministic week of punches (2 per user per workday). */
function seedAttendance(now: Date): AttendanceRecord[] {
  const out: AttendanceRecord[] = [];
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - 6);
  for (let day = 0; day < 6; day++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day);
    const weekday = date.getDay();
    if (weekday === 0 || weekday === 6) continue; // weekdays only
    for (const user of USERS) {
      const inAt = new Date(date);
      inAt.setHours(7, 55 + (user.uid * 3) % 9, (user.uid * 7) % 60, 0);
      const outAt = new Date(date);
      outAt.setHours(17, 2 + (user.uid * 5) % 13, (user.uid * 11) % 60, 0);
      out.push({
        userSn: user.uid,
        deviceUserId: user.userId,
        verifyType: 1,
        state: 0,
        time: inAt,
      });
      out.push({
        userSn: user.uid,
        deviceUserId: user.userId,
        verifyType: 1,
        state: 1,
        time: outAt,
      });
    }
  }
  return out;
}

export async function seedStore(
  store: Store,
  profile: SeedProfile,
  now: Date = new Date(),
): Promise<{ users: number; attendance: number; templates: number }> {
  await store.init();
  if (profile === 'empty') return { users: 0, attendance: 0, templates: 0 };

  for (const user of USERS) await store.upsertUser(user);
  const attendance = seedAttendance(now);
  for (const rec of attendance) await store.addAttendance(rec);

  const templates: FingerprintTemplate[] = [];
  for (const user of USERS) {
    // Two fingers per employee (index + thumb), like a real enrolment.
    for (const finger of [1, 0]) {
      templates.push({
        uid: user.uid,
        finger,
        template: syntheticTemplate(user.uid, finger),
        flag: 1,
        format: 'synthetic',
      });
    }
  }
  for (const t of templates) await store.saveTemplate(t);

  return { users: USERS.length, attendance: attendance.length, templates: templates.length };
}

export const SEED_USERS = USERS;
