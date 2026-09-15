/**
 * Biometric service (Phase 6) — enrollment, 1:N identify, 1:1 verify.
 *
 * Sits between REST v2 and the two halves of the substitute core:
 *  - the matcher sidecar (ADR-010) for decisions, and
 *  - the encrypted biometric store (ADR-011) as the canonical template record.
 *
 * The device store receives the same template as a plain FR-8 record
 * (format `iso19794-2`), so `CMD_USERTEMP_RRQ` — and therefore the BITS
 * backend's `getFingerTemplate` — returns real data with no engine changes
 * (biometric-core §4). The protocol engine itself never learns about biometrics.
 *
 * Decision rules (configurable, ADR-011 §7):
 *  - `ZK_MATCH_THRESHOLD` (default 40): top candidate must exceed it,
 *  - `ZK_MATCH_SEPARATION` (default 20): runner-up must trail by at least this
 *    much, else the presentation is rejected as ambiguous (never silently pick).
 */

import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Store } from '../store/types.js';
import type { BiometricRecord, BiometricSource, BiometricStore } from '../store/biometric-store.js';
import type { MatcherClient } from './matcher.js';
import { MatcherUnavailableError } from './matcher.js';

export const DEFAULT_MATCH_THRESHOLD = 40;
export const DEFAULT_MATCH_SEPARATION = 20;

export type BiometricDecision = 'match' | 'no-match' | 'ambiguous' | 'not-enrolled' | 'unavailable';

export interface IdentifyResult {
  decision: BiometricDecision;
  uid?: number | undefined;
  userId?: string | undefined;
  score?: number | undefined;
  runnerUpScore?: number | undefined;
  reason?: string | undefined;
}

export interface VerifyResult {
  decision: 'match' | 'no-match' | 'not-enrolled' | 'unavailable';
  score?: number | undefined;
  reason?: string | undefined;
}

export interface BiometricStatus {
  enabled: boolean;
  matcherUp: boolean;
  matcherTemplates: number;
  enrolled: number;
  threshold: number;
  separation: number;
}

export class BiometricServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface EnrollInput {
  userId: string;
  finger: number;
  /** ISO 19794-2 template bytes */
  template: Buffer;
  /** explicit, logged consent — mandatory (ADR-011 §4) */
  consent: boolean;
  quality?: number | undefined;
  source?: BiometricSource | undefined;
}

export class BiometricService {
  constructor(
    private readonly deps: {
      config: Config;
      store: Store;
      bio: BiometricStore;
      matcher: MatcherClient;
      logger: Logger;
    },
  ) {}

  private get threshold(): number {
    return this.deps.config.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
  }

  private get separation(): number {
    return this.deps.config.matchSeparation ?? DEFAULT_MATCH_SEPARATION;
  }

  async status(): Promise<BiometricStatus> {
    const health = await this.deps.matcher.health();
    return {
      enabled: true,
      matcherUp: health !== null,
      matcherTemplates: health?.templates ?? 0,
      enrolled: (await this.deps.bio.list()).length,
      threshold: this.threshold,
      separation: this.separation,
    };
  }

  /** Store an enrolled template: encrypted copy + FR-8 wire record + sidecar candidate. */
  async enroll(input: EnrollInput): Promise<{ uid: number; finger: number; userId: string }> {
    if (!input.consent) {
      throw new BiometricServiceError(400, 'enrollment requires explicit consent (ADR-011 §4)');
    }
    if (!Number.isInteger(input.finger) || input.finger < 0 || input.finger > 9) {
      throw new BiometricServiceError(400, 'finger must be an integer 0-9');
    }
    if (!Buffer.isBuffer(input.template) || input.template.length < 8) {
      throw new BiometricServiceError(400, 'template payload missing or too short');
    }
    const user = await this.deps.store.getUserByUserId(input.userId);
    if (!user) {
      throw new BiometricServiceError(404, `unknown employee: ${input.userId}`);
    }

    const record: BiometricRecord = {
      uid: user.uid,
      finger: input.finger,
      template: input.template,
      flag: 1,
      format: 'iso19794-2',
      userId: user.userId,
      quality: Math.max(0, Math.min(100, Math.round(input.quality ?? 0))),
      source: input.source ?? 'imported',
      createdAt: new Date().toISOString(),
    };
    await this.deps.bio.put(record);
    await this.deps.store.saveTemplate({
      uid: user.uid,
      finger: input.finger,
      template: input.template,
      flag: 1,
      format: 'iso19794-2',
    });
    try {
      await this.deps.matcher.enrollTemplate(user.uid, input.finger, input.template);
    } catch (err) {
      // roll the canonical copy back so the three stores never disagree
      await this.deps.bio.remove(user.uid, input.finger);
      await this.deps.store.deleteTemplate(user.uid, input.finger);
      throw err instanceof MatcherUnavailableError
        ? new BiometricServiceError(503, 'matcher sidecar unreachable — enrollment aborted')
        : err;
    }
    this.deps.logger.info('biometric enrollment stored', {
      userId: user.userId,
      uid: user.uid,
      finger: input.finger,
      bytes: input.template.length,
      source: record.source,
      quality: record.quality,
    });
    return { uid: user.uid, finger: input.finger, userId: user.userId };
  }

  /** Remove one enrollment (employee-initiated delete / admin action). */
  async removeEnrollment(userId: string, finger: number): Promise<boolean> {
    const user = await this.deps.store.getUserByUserId(userId);
    if (!user) return false;
    const removed = await this.deps.bio.remove(user.uid, finger);
    await this.deps.store.deleteTemplate(user.uid, finger);
    await this.deps.matcher.removeTemplate(user.uid, finger).catch(() => undefined);
    return removed;
  }

  async identify(template: Buffer): Promise<IdentifyResult> {
    if (!Buffer.isBuffer(template) || template.length < 8) {
      throw new BiometricServiceError(400, 'template payload missing or too short');
    }
    const candidates = await this.deps.matcher.identifyTemplate(template, 5);
    const top = candidates[0];
    if (!top) return { decision: 'no-match', reason: 'no enrolled candidates' };
    const runnerUp = candidates.find((c) => c.uid !== top.uid);
    if (top.score < this.threshold) {
      return { decision: 'no-match', score: top.score, runnerUpScore: runnerUp?.score, reason: 'below threshold' };
    }
    if (runnerUp && runnerUp.score >= this.threshold && top.score - runnerUp.score < this.separation) {
      return {
        decision: 'ambiguous',
        score: top.score,
        runnerUpScore: runnerUp.score,
        reason: 'runner-up too close — present the finger again',
      };
    }
    const user = await this.deps.store.getUser(top.uid);
    if (!user) {
      // retention rule (ADR-011 §5): templates exist only while the employee does
      await this.deps.bio.remove(top.uid, top.finger).catch(() => undefined);
      await this.deps.matcher.removeTemplate(top.uid, top.finger).catch(() => undefined);
      this.deps.logger.warn('orphaned biometric template removed on identify', { uid: top.uid, finger: top.finger });
      return { decision: 'not-enrolled', reason: 'template belonged to a deleted employee' };
    }
    return {
      decision: 'match',
      uid: top.uid,
      userId: user.userId,
      score: top.score,
      runnerUpScore: runnerUp?.score,
    };
  }

  async verify(userId: string, finger: number, template: Buffer): Promise<VerifyResult> {
    if (!Buffer.isBuffer(template) || template.length < 8) {
      throw new BiometricServiceError(400, 'template payload missing or too short');
    }
    const user = await this.deps.store.getUserByUserId(userId);
    if (!user) return { decision: 'not-enrolled', reason: `unknown employee: ${userId}` };
    const score = await this.deps.matcher.verifyTemplate(user.uid, finger, template);
    if (score === undefined) return { decision: 'not-enrolled', reason: `no template for ${userId} finger ${finger}` };
    return score >= this.threshold
      ? { decision: 'match', score }
      : { decision: 'no-match', score };
  }

  /** Full biometric wipe (ADR-011 §5): encrypted copies + matcher + FR-8 wire copies. */
  async purge(): Promise<number> {
    const purged = await this.deps.bio.purge();
    await this.deps.matcher.clearAll().catch(() => undefined);
    let wire = 0;
    for (const t of await this.deps.store.getTemplates()) {
      if (t.format === 'iso19794-2') {
        await this.deps.store.deleteTemplate(t.uid, t.finger);
        wire += 1;
      }
    }
    this.deps.logger.info('biometric purge complete', { encrypted: purged, wire: wire });
    return purged;
  }

  /**
   * Boot-time consistency sweep (retention rule, ADR-011 §5): drop biometric
   * records whose employee or FR-8 wire copy no longer exists, then repopulate
   * the sidecar's candidate table (it is memory-only across sidecar restarts).
   */
  async reconcile(): Promise<{ removed: number; synced: number }> {
    let removed = 0;
    for (const rec of await this.deps.bio.list()) {
      const user = await this.deps.store.getUser(rec.uid);
      const wire = user ? await this.deps.store.getTemplate(rec.uid, rec.finger) : undefined;
      if (!user || !wire) {
        await this.deps.bio.remove(rec.uid, rec.finger);
        await this.deps.matcher.removeTemplate(rec.uid, rec.finger).catch(() => undefined);
        removed += 1;
      }
    }
    let synced = 0;
    for (const rec of await this.deps.bio.list()) {
      await this.deps.matcher.enrollTemplate(rec.uid, rec.finger, rec.template).catch(() => undefined);
      synced += 1;
    }
    if (removed > 0) this.deps.logger.warn('biometric reconcile removed orphans', { removed: removed });
    this.deps.logger.info('biometric reconcile synced matcher', { synced: synced });
    return { removed: removed, synced: synced };
  }
}
