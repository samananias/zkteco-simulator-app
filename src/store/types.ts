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
  '~DeviceName': 'BITS-VIRTUAL-K14 (Virtual Terminal)',
  '~SerialNumber': 'VIRT-K14-2026',
  '~Platform': 'ZEM560_TFT',
  '~ZKFPVersion': '10',
  '~OS': 'Linux',
  '~SerialNumberLinux': 'VIRT-K14-2026',
  '~OEMVendor': 'ZKTECO-VIRTUAL',
  'Platform': 'ZEM560_TFT',
  'DeviceName': 'BITS-VIRTUAL-K14 (Virtual Terminal)',
  'IPAddress': '127.0.0.1',
  'NetMask': '255.255.255.0',
  'GATEIPAddress': '127.0.0.1',
  'MAC': '00:17:61:14:20:26',
  'Firmware': 'Ver 8.0.4.1-2026',
  '~CardFP': '1',
  'CardFP': '1',
  '~MaxUserCount': '3000',
  '~MaxAttLogCount': '100000',
  '~MaxFingerCount': '3000',
  'Lock1': '0',
  'VerifyMode': '1',
  'Language': '69',
  'Vol': '0',
  'DateTime': '',
};
