/**
 * Biometric store seam (ADR-009 / ADR-011 forward-compatibility hook).
 *
 * Phase 1 ships only the synthetic implementation, but the *interface* exists
 * from the start so Phase 6 adds encryption + a real matcher without any
 * migration or refactor of the device logic. No real biometrics exist before
 * Phase 6 — see docs/simulator-docs/decisions/ADR-011-biometric-data-protection.md.
 */
import type { FingerprintTemplate } from '../store/types.js';

export interface BiometricStore {
  readonly kind: 'synthetic' | 'encrypted';
  put(template: FingerprintTemplate): Promise<void>;
  get(uid: number, finger: number): Promise<FingerprintTemplate | undefined>;
  remove(uid: number, finger: number): Promise<boolean>;
  removeUser(uid: number): Promise<number>;
  purge(): Promise<number>;
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

  put(template: FingerprintTemplate): Promise<void> {
    return this.store.saveTemplate(template);
  }

  get(uid: number, finger: number): Promise<FingerprintTemplate | undefined> {
    return this.store.getTemplate(uid, finger);
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
}
