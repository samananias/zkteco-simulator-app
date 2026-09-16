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
import type { ConsentLedger, ConsentRecord } from './consent.js';
import { consentStatement, type ConsentStatement } from './consent-text.js';
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
  /** Phase 8 — consent records on file (count only, never contents) */
  consents: number;
  /** Phase 8 — 0 = templates live as long as the employee record does (ADR-011 §5) */
  retentionDays: number;
  /** Phase 8 — statement version this deployment collects consent against */
  consentVersion: string;
  /** Phase 8 — station identity stamped into consent/enrollment records */
  stationId: string;
}

/** Enrollment roster row — metadata only; template bytes never leave the service (ADR-011 §3). */
export interface EnrollmentMetadata {
  uid: number;
  userId: string;
  name: string;
  finger: number;
  format: string;
  source: string;
  /** station that produced it (`ZK_STATION_ID` or a per-request override) */
  station: string;
  quality: number;
  createdAt: string;
}

/** Consent roster row — a `ConsentRecord` enriched with the employee name for the admin view. */
export interface ConsentView extends ConsentRecord {
  name: string;
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
  /** statement version the enrollee actually read; a stale value is rejected (Phase 8) */
  consentVersion?: string | undefined;
  /** station that collected it — defaults to `ZK_STATION_ID` (Phase 8) */
  station?: string | undefined;
  quality?: number | undefined;
  source?: BiometricSource | undefined;
}

export class BiometricService {
  constructor(
    private readonly deps: {
      config: Config;
      store: Store;
      bio: BiometricStore;
      /** consent ledger (Phase 8, ADR-011 §4) */
      consent: ConsentLedger;
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

  private get station(): string {
    return this.deps.config.stationId;
  }

  /**
   * Consent gate (ADR-011 §4, NFR-10). The boolean was always mandatory; Phase 8
   * additionally pins *which statement text* the enrollee saw. A page presenting
   * an outdated statement is rejected — consent to text nobody read is not consent.
   */
  private consentFor(input: { consent: boolean; consentVersion?: string | undefined }): ConsentStatement {
    if (!input.consent) {
      throw new BiometricServiceError(400, 'enrollment requires explicit consent (ADR-011 §4)');
    }
    const current = this.deps.config.consentVersion;
    if (input.consentVersion !== undefined && input.consentVersion !== current) {
      throw new BiometricServiceError(
        409,
        `consent statement ${input.consentVersion} is outdated (current: ${current}) — reload the enrollment page`,
      );
    }
    const statement = consentStatement(current);
    if (!statement) throw new BiometricServiceError(500, `consent statement ${current} is not available`);
    return statement;
  }

  /** The statement the enrollment page must render — served, never hard-coded in the page. */
  consentStatement(): ConsentStatement {
    const statement = consentStatement(this.deps.config.consentVersion);
    if (!statement) throw new BiometricServiceError(500, `consent statement ${this.deps.config.consentVersion} is not available`);
    return statement;
  }

  /** Persist the accountability record for a completed, consented enrollment. */
  private async recordConsent(
    user: { uid: number; userId: string },
    statement: ConsentStatement,
    method: BiometricSource,
    station: string,
    at: Date = new Date(),
  ): Promise<void> {
    await this.deps.consent.put({
      userId: user.userId,
      uid: user.uid,
      statementVersion: statement.version,
      statementHash: statement.hash,
      purpose: statement.purpose,
      method,
      station,
      at: at.toISOString(),
    });
    this.deps.logger.info('biometric consent recorded', {
      userId: user.userId,
      uid: user.uid,
      statement: statement.version,
      method,
      station,
    });
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
      consents: (await this.deps.consent.list()).length,
      retentionDays: this.deps.config.retentionDays,
      consentVersion: this.deps.config.consentVersion,
      stationId: this.station,
    };
  }

  /**
   * Enrollment roster for the admin view (`GET /api/biometric/enrollments`) —
   * **metadata only**: templates never leave this method, not even base64.
   */
  async enrollments(): Promise<EnrollmentMetadata[]> {
    const out: EnrollmentMetadata[] = [];
    for (const rec of await this.deps.bio.list()) {
      const user = await this.deps.store.getUser(rec.uid);
      out.push({
        uid: rec.uid,
        userId: rec.userId || user?.userId || '',
        name: user?.name ?? '',
        finger: rec.finger,
        format: rec.format,
        source: rec.source,
        station: rec.station ?? '',
        quality: rec.quality,
        createdAt: rec.createdAt,
      });
    }
    return out;
  }

  /** Consent roster (`GET /api/biometric/consents`) — accountability metadata, no biometrics. */
  async consents(): Promise<ConsentView[]> {
    const out: ConsentView[] = [];
    for (const rec of await this.deps.consent.list()) {
      const user = await this.deps.store.getUser(rec.uid);
      out.push({ ...rec, name: user?.name ?? '' });
    }
    return out;
  }

  /**
   * Employee withdrawal (ADR-011 §5, NFR-10 — "a working deletion path per
   * employee"): every template for the employee is deleted from all three stores
   * and the consent record is marked withdrawn. Idempotent, so a repeated call
   * still reports success with `removed: 0`.
   */
  async withdrawEmployee(
    userId: string,
    reason = 'withdrawn by employee',
  ): Promise<{ userId: string; uid: number; removed: number; consentOnFile: boolean }> {
    const user = await this.deps.store.getUserByUserId(userId);
    if (!user) throw new BiometricServiceError(404, `unknown employee: ${userId}`);
    const mine = (await this.deps.bio.list()).filter((r) => r.uid === user.uid);
    for (const rec of mine) {
      await this.deps.bio.remove(rec.uid, rec.finger);
      await this.deps.store.deleteTemplate(rec.uid, rec.finger);
      await this.deps.matcher.removeTemplate(rec.uid, rec.finger).catch(() => undefined);
    }
    const withdrawn = await this.deps.consent.withdraw(userId, reason);
    this.deps.logger.info('biometric withdrawal complete', {
      userId,
      uid: user.uid,
      removed: mine.length,
      consentOnFile: withdrawn !== undefined,
    });
    return { userId, uid: user.uid, removed: mine.length, consentOnFile: withdrawn !== undefined };
  }

  /**
   * Retention sweep (ADR-011 §5, `ZK_RETENTION_DAYS`): with a positive window,
   * enrollments older than it are deleted from all three stores and their consent
   * record is marked withdrawn. The default `0` is the ADR-011 rule — templates
   * exist only while the employee record does — and sweeps nothing.
   */
  async retentionSweep(now: Date = new Date()): Promise<{ scanned: number; removed: number }> {
    const days = this.deps.config.retentionDays;
    const all = await this.deps.bio.list();
    if (days <= 0) return { scanned: all.length, removed: 0 };
    const cutoff = now.getTime() - days * 86_400_000;
    let removed = 0;
    for (const rec of all) {
      const created = Date.parse(rec.createdAt);
      if (!Number.isFinite(created) || created > cutoff) continue;
      try {
        await this.deps.bio.remove(rec.uid, rec.finger);
        await this.deps.store.deleteTemplate(rec.uid, rec.finger);
        await this.deps.matcher.removeTemplate(rec.uid, rec.finger).catch(() => undefined);
        await this.deps.consent.withdraw(rec.userId, `retention-expired (${days} days)`);
        removed += 1;
      } catch (err) {
        this.deps.logger.warn('retention sweep could not remove an enrollment', {
          uid: rec.uid,
          finger: rec.finger,
          err: String(err),
        });
      }
    }
    if (removed > 0) {
      this.deps.logger.info('biometric retention sweep removed expired enrollments', {
        removed,
        scanned: all.length,
        retentionDays: days,
      });
    }
    return { scanned: all.length, removed };
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
    consentVersion?: string | undefined;
    station?: string | undefined;
    quality?: number | undefined;
    source?: BiometricSource | undefined;
  }): Promise<{ uid: number; finger: number; userId: string; samples: number; consistency: number[] }> {
    this.consentFor(input); // gate before any matching work is done
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
      consentVersion: input.consentVersion,
      station: input.station,
      template,
      quality: input.quality,
      source: input.source ?? 'camera',
    });
    return { ...enrolled, samples: samples.length, consistency };
  }

  /** Store an enrolled template: encrypted copy + FR-8 wire record + sidecar candidate. */
  async enroll(input: EnrollInput): Promise<{ uid: number; finger: number; userId: string }> {
    const statement = this.consentFor(input);
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

    const station = input.station ?? this.station;
    const record: BiometricRecord = {
      uid: user.uid,
      finger: input.finger,
      template: input.template,
      flag: 1,
      format: 'iso19794-2',
      userId: user.userId,
      quality: Math.max(0, Math.min(100, Math.round(input.quality ?? 0))),
      source: input.source ?? 'imported',
      station,
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
      station,
      quality: record.quality,
    });
    await this.recordConsent(user, statement, record.source, station);
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
      const orphan = await this.deps.bio.get(top.uid, top.finger).catch(() => undefined);
      await this.deps.bio.remove(top.uid, top.finger).catch(() => undefined);
      await this.deps.matcher.removeTemplate(top.uid, top.finger).catch(() => undefined);
      // the consent record stays as accountability evidence, marked withdrawn
      if (orphan?.userId) await this.deps.consent.withdraw(orphan.userId, 'employee-deleted').catch(() => undefined);
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
    const consents = await this.deps.consent.purge();
    this.deps.logger.info('biometric purge complete', { encrypted: purged, wire: wire, consents: consents });
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
        await this.deps.consent
          .withdraw(rec.userId, user ? 'wire-copy-missing' : 'employee-deleted')
          .catch(() => undefined);
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
