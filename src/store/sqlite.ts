/**
 * SQLite store (Phase 5, ADR-008) — `node:sqlite` (built into Node 22+), no
 * native dependency. Same contract as `MemoryStore`; selected by ZK_STORE=sqlite.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FingerprintTemplate, StoreCounts } from './types.js';
import { decodeUser, encodeUser, encodeAttendance, decodeAttendance, type AttendanceRecord, type UserRecord } from '../protocol/records.js';
import { encodeTime, decodeTime } from '../protocol/timecodec.js';

export class SqliteStore {
  private db!: DatabaseSync;

  constructor(private readonly filePath: string) {}

  readonly kind = 'sqlite' as const;

  async init(): Promise<void> {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        uid INTEGER PRIMARY KEY,
        role INTEGER NOT NULL DEFAULT 0,
        password TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        card INTEGER NOT NULL DEFAULT 0,
        user_id TEXT NOT NULL DEFAULT '',
        raw BLOB
      );
      CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_sn INTEGER NOT NULL,
        device_user_id TEXT NOT NULL,
        verify_type INTEGER NOT NULL,
        state INTEGER NOT NULL,
        seconds INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS templates (
        uid INTEGER NOT NULL,
        finger INTEGER NOT NULL,
        flag INTEGER NOT NULL DEFAULT 1,
        format TEXT NOT NULL DEFAULT 'synthetic',
        template BLOB NOT NULL,
        PRIMARY KEY (uid, finger)
      );
      CREATE TABLE IF NOT EXISTS options (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async getUsers(): Promise<UserRecord[]> {
    const rows = this.db.prepare('SELECT raw FROM users ORDER BY uid').all() as Array<{ raw: Uint8Array }>;
    return rows.map((r) => decodeUser(Buffer.from(r.raw), 0));
  }

  async getUser(uid: number): Promise<UserRecord | undefined> {
    const row = this.db.prepare('SELECT raw FROM users WHERE uid = ?').get(uid) as { raw: Uint8Array } | undefined;
    return row ? decodeUser(Buffer.from(row.raw), 0) : undefined;
  }

  async getUserByUserId(userId: string): Promise<UserRecord | undefined> {
    const row = this.db
      .prepare('SELECT raw FROM users WHERE user_id = ? ORDER BY uid LIMIT 1')
      .get(userId) as { raw: Uint8Array } | undefined;
    return row ? decodeUser(Buffer.from(row.raw), 0) : undefined;
  }

  async upsertUser(user: UserRecord): Promise<UserRecord> {
    const raw = encodeUser(user);
    this.db
      .prepare(
        `INSERT INTO users (uid, role, password, name, card, user_id, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET role=excluded.role, password=excluded.password,
           name=excluded.name, card=excluded.card, user_id=excluded.user_id, raw=excluded.raw`,
      )
      .run(user.uid, user.role, user.password, user.name, user.card, user.userId, raw);
    return user;
  }

  async deleteUser(uid: number): Promise<boolean> {
    const info = this.db.prepare('DELETE FROM users WHERE uid = ?').run(uid);
    return Number(info.changes) > 0;
  }

  async nextUid(): Promise<number> {
    const row = this.db.prepare('SELECT COALESCE(MAX(uid), 0) + 1 AS next FROM users').get() as { next: number };
    return row.next;
  }

  async getAttendance(): Promise<AttendanceRecord[]> {
    const rows = this.db
      .prepare('SELECT user_sn, device_user_id, verify_type, state, seconds FROM attendance ORDER BY seconds')
      .all() as Array<{ user_sn: number; device_user_id: string; verify_type: number; state: number; seconds: number }>;
    return rows.map((r) => ({
      userSn: r.user_sn,
      deviceUserId: r.device_user_id,
      verifyType: r.verify_type,
      state: r.state,
      time: decodeTime(r.seconds),
    }));
  }

  async addAttendance(rec: AttendanceRecord): Promise<AttendanceRecord> {
    this.db
      .prepare('INSERT INTO attendance (user_sn, device_user_id, verify_type, state, seconds) VALUES (?, ?, ?, ?, ?)')
      .run(rec.userSn, rec.deviceUserId, rec.verifyType, rec.state, encodeTime(rec.time));
    return rec;
  }

  async clearAttendance(): Promise<number> {
    const info = this.db.prepare('DELETE FROM attendance').run();
    return Number(info.changes);
  }

  async getTemplates(): Promise<FingerprintTemplate[]> {
    const rows = this.db
      .prepare('SELECT uid, finger, flag, format, template FROM templates ORDER BY uid, finger')
      .all() as Array<{ uid: number; finger: number; flag: number; format: string; template: Uint8Array }>;
    return rows.map((r) => ({
      uid: r.uid,
      finger: r.finger,
      flag: r.flag,
      format: r.format as FingerprintTemplate['format'],
      template: Buffer.from(r.template),
    }));
  }

  async getTemplate(uid: number, finger: number): Promise<FingerprintTemplate | undefined> {
    const row = this.db
      .prepare('SELECT uid, finger, flag, format, template FROM templates WHERE uid = ? AND finger = ?')
      .get(uid, finger) as { uid: number; finger: number; flag: number; format: string; template: Uint8Array } | undefined;
    return row
      ? {
          uid: row.uid,
          finger: row.finger,
          flag: row.flag,
          format: row.format as FingerprintTemplate['format'],
          template: Buffer.from(row.template),
        }
      : undefined;
  }

  async saveTemplate(t: FingerprintTemplate): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO templates (uid, finger, flag, format, template) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(uid, finger) DO UPDATE SET flag=excluded.flag, format=excluded.format, template=excluded.template`,
      )
      .run(t.uid, t.finger, t.flag, t.format, t.template);
  }

  async deleteTemplate(uid: number, finger: number): Promise<boolean> {
    const info = this.db.prepare('DELETE FROM templates WHERE uid = ? AND finger = ?').run(uid, finger);
    return Number(info.changes) > 0;
  }

  async deleteTemplatesForUser(uid: number): Promise<number> {
    const info = this.db.prepare('DELETE FROM templates WHERE uid = ?').run(uid);
    return Number(info.changes);
  }

  async getOption(key: string): Promise<string | undefined> {
    const row = this.db.prepare('SELECT value FROM options WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  async setOption(key: string, value: string): Promise<void> {
    this.db
      .prepare('INSERT INTO options (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }

  async getOptions(): Promise<Record<string, string>> {
    const rows = this.db.prepare('SELECT key, value FROM options').all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async counts(): Promise<StoreCounts> {
    const one = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { n: number };
      return Number(row.n);
    };
    return {
      users: one('SELECT COUNT(*) AS n FROM users'),
      attendance: one('SELECT COUNT(*) AS n FROM attendance'),
      templates: one('SELECT COUNT(*) AS n FROM templates'),
      fingers: one('SELECT COUNT(DISTINCT uid) AS n FROM templates'),
    };
  }
}
