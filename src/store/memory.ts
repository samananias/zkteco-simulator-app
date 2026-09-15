/**
 * In-memory store — the default (ADR-008). Fast, zero-dependency, and the
 * reference implementation that the SQLite store must match behaviourally.
 */
import type { AttendanceRecord, UserRecord } from '../protocol/records.js';
import {
  DEFAULT_OPTIONS,
  type FingerprintTemplate,
  type Store,
  type StoreCounts,
} from './types.js';

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;

  private users = new Map<number, UserRecord>();
  private attendance: AttendanceRecord[] = [];
  private templates = new Map<string, FingerprintTemplate>();
  private options: Record<string, string> = {};
  private lastUid = 0;

  init(): Promise<void> {
    this.options = { ...DEFAULT_OPTIONS };
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.users.clear();
    this.attendance = [];
    this.templates.clear();
    return Promise.resolve();
  }

  private key(uid: number, finger: number): string {
    return `${uid}:${finger}`;
  }

  getUsers(): Promise<UserRecord[]> {
    return Promise.resolve([...this.users.values()].sort((a, b) => a.uid - b.uid));
  }

  getUser(uid: number): Promise<UserRecord | undefined> {
    return Promise.resolve(this.users.get(uid));
  }

  getUserByUserId(userId: string): Promise<UserRecord | undefined> {
    for (const u of this.users.values()) {
      if (u.userId === userId) return Promise.resolve(u);
    }
    return Promise.resolve(undefined);
  }

  upsertUser(user: UserRecord): Promise<UserRecord> {
    this.users.set(user.uid, { ...user });
    if (user.uid > this.lastUid) this.lastUid = user.uid;
    return Promise.resolve({ ...user });
  }

  deleteUser(uid: number): Promise<boolean> {
    const existed = this.users.delete(uid);
    for (const k of [...this.templates.keys()]) {
      if (k.startsWith(`${uid}:`)) this.templates.delete(k);
    }
    return Promise.resolve(existed);
  }

  nextUid(): Promise<number> {
    let candidate = this.lastUid + 1;
    while (this.users.has(candidate)) candidate++;
    this.lastUid = candidate;
    return Promise.resolve(candidate);
  }

  getAttendance(): Promise<AttendanceRecord[]> {
    return Promise.resolve(this.attendance.map((r) => ({ ...r })));
  }

  addAttendance(rec: AttendanceRecord): Promise<AttendanceRecord> {
    this.attendance.push({ ...rec });
    return Promise.resolve({ ...rec });
  }

  clearAttendance(): Promise<number> {
    const n = this.attendance.length;
    this.attendance = [];
    return Promise.resolve(n);
  }

  getTemplates(): Promise<FingerprintTemplate[]> {
    return Promise.resolve([...this.templates.values()].map((t) => ({ ...t })));
  }

  getTemplate(uid: number, finger: number): Promise<FingerprintTemplate | undefined> {
    const found = this.templates.get(this.key(uid, finger));
    return Promise.resolve(found ? { ...found } : undefined);
  }

  saveTemplate(t: FingerprintTemplate): Promise<void> {
    this.templates.set(this.key(t.uid, t.finger), { ...t, template: Buffer.from(t.template) });
    return Promise.resolve();
  }

  deleteTemplate(uid: number, finger: number): Promise<boolean> {
    return Promise.resolve(this.templates.delete(this.key(uid, finger)));
  }

  deleteTemplatesForUser(uid: number): Promise<number> {
    let n = 0;
    for (const k of [...this.templates.keys()]) {
      if (k.startsWith(`${uid}:`)) {
        this.templates.delete(k);
        n++;
      }
    }
    return Promise.resolve(n);
  }

  getOption(key: string): Promise<string | undefined> {
    return Promise.resolve(this.options[key]);
  }

  setOption(key: string, value: string): Promise<void> {
    this.options[key] = value;
    return Promise.resolve();
  }

  getOptions(): Promise<Record<string, string>> {
    return Promise.resolve({ ...this.options });
  }

  /** Test/demo helper: replace the option table wholesale. */
  setOptionsAll(values: Record<string, string>): void {
    this.options = { ...values };
  }

  /** Test/demo helper: drop everything (used by CLEAR_DATA / purge flows). */
  reset(): void {
    this.users.clear();
    this.attendance = [];
    this.templates.clear();
    this.options = { ...DEFAULT_OPTIONS };
    this.lastUid = 0;
  }

  counts(): Promise<StoreCounts> {
    let fingers = 0;
    const fingerSet = new Set<number>();
    for (const t of this.templates.values()) {
      fingers++;
      fingerSet.add(t.uid);
    }
    return Promise.resolve({
      users: this.users.size,
      attendance: this.attendance.length,
      templates: this.templates.size,
      fingers: fingerSet.size,
    });
  }
}
