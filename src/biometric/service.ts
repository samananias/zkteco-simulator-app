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
import { assessQuality, qualityThresholds, type QualityMetrics } from '../capture/quality.js';

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
  captureSamples: number;
}

export type CaptureVerdict =
  | { decision: 'accept'; template: Buffer; quality: QualityMetrics; score: number }
  | { decision: 'reject'; reason: string; quality?: QualityMetrics | undefined; score: number };

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
      captureSamples: Math.max(2, this.deps.config.captureSamples),
    };
  }

  /**
   * Capture pipeline (FR-16.1): image → sidecar extraction (+ measurement) →
   * configurable quality verdict. Rejections carry an actionable reason so the
   * capture page can tell the user what to fix. The image exists only inside
   * this call — never stored (ADR-011 §1).
   */
  async captureProbe(image: Buffer): Promise<CaptureVerdict> {
    const { template, quality } = await this.deps.matcher.extractImage(image);
    if (!quality) return { decision: 'reject', reason: 'unreadable', score: 0 };
    const verdict = assessQuality(quality, qualityThresholds(this.deps.config));
    if (!verdict.pass) {
      this.deps.logger.info('capture rejected by quality gate', {
        reason: verdict.reason,
        quality,
      });
      return { decision: 'reject', reason: verdict.reason ?? 'poor-quality', quality, score: verdict.score };
    }
    return { decision: 'accept', template, quality, score: verdict.score };
  }

  /**
   * N-sample enrollment ceremony (FR-14): every sample pair must clear the accept
   * threshold on the engine's consistency check before anything is stored; the
   * most central sample (highest average pairwise score) becomes the template.
   * Samples arrive as already-extracted ISO templates (the capture endpoint's
   * output) — no image ever reaches here.
   */
  async enrollWithSamples(input: {
    userId: string;
    finger: number;
    consent: boolean;
    samples: Buffer[];
    quality?: number | undefined;
    source?: BiometricSource | undefined;
  }): Promise<{ uid: number; finger: number; userId: string; samples: number; consistency: number[] }> {
    if (!input.consent) {
      throw new BiometricServiceError(400, 'enrollment requires explicit consent (ADR-011 §4)');
    }
    if (!Number.isInteger(input.finger) || input.finger < 0 || input.finger > 9) {
      throw new BiometricServiceError(400, 'finger must be an integer 0-9');
    }
    const min = Math.max(2, this.deps.config.captureSamples);
    if (!Array.isArray(input.samples) || input.samples.length < min) {
      throw new BiometricServiceError(400, `at least ${min} samples are required (received ${input.samples?.length ?? 0})`);
    }
    for (const s of input.samples) {
      if (!Buffer.isBuffer(s) || s.length < 8) throw new BiometricServiceError(400, 'a sample template is missing or too short');
    }
    const user = await this.deps.store.getUserByUserId(input.userId);
    if (!user) throw new BiometricServiceError(404, `unknown employee: ${input.userId}`);

    const samples = input.samples;
    const pairScores: { i: number; j: number; score: number }[] = [];
    for (let i = 0; i < samples.length; i++) {
      for (let j = i + 1; j < samples.length; j++) {
        const si = samples[i];
        const sj = samples[j];
        if (!si || !sj) continue; // unreachable after the length checks above
        const score = await this.deps.matcher.matchTemplates(si, sj);
        pairScores.push({ i, j, score: Math.round(score * 100) / 100 });
      }
    }
    for (const p of pairScores) {
      if (p.score < this.threshold) {
        throw new BiometricServiceError(
          409,
          `samples are not mutually consistent (pair ${p.i}-${p.j}: ${p.score.toFixed(1)} < threshold ${this.threshold}) — recapture the finger`,
        );
      }
    }
    // representative sample: highest average pairwise score (the most central one)
    const totals = new Map<number, number>();
    for (const p of pairScores) {
      totals.set(p.i, (totals.get(p.i) ?? 0) + p.score);
      totals.set(p.j, (totals.get(p.j) ?? 0) + p.score);
    }
    let best = 0;
    let bestAvg = -1;
    for (let i = 0; i < samples.length; i++) {
      const a = (totals.get(i) ?? 0) / Math.max(1, samples.length - 1);
      if (a > bestAvg) {
        bestAvg = a;
        best = i;
      }
    }
    const template = samples[best];
    if (!template) throw new BiometricServiceError(400, 'sample selection failed');
    const consistency = pairScores.map((p) => p.score);
    const enrolled = await this.enroll({
      userId: input.userId,
      finger: input.finger,
      consent: input.consent,
      template,
      quality: input.quality,
      source: input.source ?? 'camera',
    });
    return { ...enrolled, samples: samples.length, consistency };
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
