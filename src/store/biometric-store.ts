/**
 * Biometric store seam (ADR-009 / ADR-011 forward-compatibility hook).
 *
 * Phase 1 ships only the synthetic implementation, but the *interface* exists
 * from the start so Phase 6 adds encryption + a real matcher without any
 * migration or refactor of the device logic. No real biometrics exist before
 * Phase 6 — see docs/simulator-docs/decisions/ADR-011-biometric-data-protection.md.
 */
import type { FingerprintTemplate, TemplateFormat } from './types.js';

export type BiometricSource = 'camera' | 'usb-otg' | 'pc-scanner' | 'imported';

/** A biometric template record — the encrypted stores' logical unit (ADR-011). */
export interface BiometricRecord extends FingerprintTemplate {
  /** employee userId on the wire (the device store's userId, not the internal uid) */
  userId: string;
  /** 0–100 quality verdict from the capture gate (0 = unknown) */
  quality: number;
  source: BiometricSource;
  /** enrollment timestamp (ISO 8601) */
  createdAt: string;
}

export function toBiometricRecord(t: FingerprintTemplate): BiometricRecord {
  return {
    uid: t.uid,
    finger: t.finger,
    template: t.template,
    flag: t.flag,
    format: (t.format ?? 'synthetic') as TemplateFormat,
    userId: '',
    quality: 0,
    source: 'imported',
    createdAt: new Date(0).toISOString(),
  };
}

export interface BiometricStore {
  readonly kind: 'synthetic' | 'encrypted';
  put(record: BiometricRecord): Promise<void>;
  get(uid: number, finger: number): Promise<BiometricRecord | undefined>;
  remove(uid: number, finger: number): Promise<boolean>;
  removeUser(uid: number): Promise<number>;
  purge(): Promise<number>;
  /** full listing (metadata + templates); callers must never log or echo template bytes (ADR-011) */
  list(): Promise<BiometricRecord[]>;
}

/** Phase 1-5 implementation: delegates to the device store, no encryption needed. */
export class SyntheticBiometricStore implements BiometricStore {
  readonly kind = 'synthetic' as const;

  constructor(
    private readonly store: {
      saveTemplate(t: FingerprintTemplate): Promise<void>;
      getTemplate(uid: number, finger: number): Promise<FingerprintTemplate | undefined>;
      deleteTemplate(uid: number, finger: number): Promise<boolean>;
      deleteTemplatesForUser(uid: number): Promise<number>;
      getTemplates(): Promise<FingerprintTemplate[]>;
    },
  ) {}

  put(record: BiometricRecord): Promise<void> {
    return this.store.saveTemplate(record);
  }

  async get(uid: number, finger: number): Promise<BiometricRecord | undefined> {
    const t = await this.store.getTemplate(uid, finger);
    return t ? toBiometricRecord(t) : undefined;
  }

  remove(uid: number, finger: number): Promise<boolean> {
    return this.store.deleteTemplate(uid, finger);
  }

  removeUser(uid: number): Promise<number> {
    return this.store.deleteTemplatesForUser(uid);
  }

  async purge(): Promise<number> {
    const all = await this.store.getTemplates();
    for (const t of all) await this.store.deleteTemplate(t.uid, t.finger);
    return all.length;
  }

  async list(): Promise<BiometricRecord[]> {
    return (await this.store.getTemplates()).map(toBiometricRecord);
  }
}
