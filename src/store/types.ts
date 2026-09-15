/**
 * Store contract (docs/simulator-docs/architecture/data-model.md).
 *
 * Two implementations exist: `memory` (default, ADR-008) and `sqlite` (Phase 5).
 * The biometric store is a *separate* interface (`BiometricStore`) so the
 * forward-compatibility hook from ADR-009/ADR-011 exists from Phase 1 without
 * costing anything (see `biometric-store.ts`).
 */
import type { AttendanceRecord, UserRecord } from '../protocol/records.js';

export type TemplateFormat = 'synthetic' | 'iso19794-2';

export interface FingerprintTemplate {
  uid: number;
  finger: number;
  template: Buffer;
  flag: number;
  format: TemplateFormat;
}

export interface StoreCounts {
  users: number;
  attendance: number;
  templates: number;
  fingers: number;
}

export interface Store {
  readonly kind: 'memory' | 'sqlite';
  init(): Promise<void>;
  close(): Promise<void>;

  getUsers(): Promise<UserRecord[]>;
  getUser(uid: number): Promise<UserRecord | undefined>;
  getUserByUserId(userId: string): Promise<UserRecord | undefined>;
  upsertUser(user: UserRecord): Promise<UserRecord>;
  deleteUser(uid: number): Promise<boolean>;
  nextUid(): Promise<number>;

  getAttendance(): Promise<AttendanceRecord[]>;
  addAttendance(rec: AttendanceRecord): Promise<AttendanceRecord>;
  clearAttendance(): Promise<number>;

  getTemplates(): Promise<FingerprintTemplate[]>;
  getTemplate(uid: number, finger: number): Promise<FingerprintTemplate | undefined>;
  saveTemplate(t: FingerprintTemplate): Promise<void>;
  deleteTemplate(uid: number, finger: number): Promise<boolean>;
  deleteTemplatesForUser(uid: number): Promise<number>;

  getOption(key: string): Promise<string | undefined>;
  setOption(key: string, value: string): Promise<void>;
  getOptions(): Promise<Record<string, string>>;

  counts(): Promise<StoreCounts>;
}

export const DEFAULT_OPTIONS: Record<string, string> = {
  '~DeviceName': 'ACME HQ — Main Door',
  '~SerialNumber': 'CJ7X202660399',
  '~Platform': 'ZEM560_TFT',
  '~ZKFPVersion': '10',
  '~OS': '9.0.1',
  '~SerialNumberLinux': 'CJ7X202660399',
  'Lock1': '0',
  'VerifyMode': '1',
  'Language': '69',
  'Vol': '0',
  'DateTime': '',
};
