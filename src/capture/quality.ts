/**
 * Capture quality gate (Phase 7, FR-16.1) — policy layer.
 *
 * The sidecar MEASURES (brightness / sharpness / coverage — see MatcherSidecar
 * `qualityJson`); this module applies the configurable thresholds and returns the
 * verdict with an actionable reason. Thresholds are env-tunable, never hard-coded
 * (ADR-011 §7). Images exist only in memory during capture — never persisted
 * (ADR-011 §1). Score is a demo-grade heuristic (0-100), not a certified metric.
 */

import type { Config } from '../config.js';

/** Metrics as measured by the sidecar over the decoded frame. */
export interface QualityMetrics {
  /** grayscale mean, 0-255 */
  brightness: number;
  /** Laplacian variance — collapses toward 0 for blurry/smooth frames */
  sharpness: number;
  /** fraction (0-1) of 8×8 blocks carrying texture (ridge presence) */
  coverage: number;
}

export interface QualityThresholds {
  minBrightness: number;
  minSharpness: number;
  /** stored as a percent in config; used as a 0-1 fraction here */
  minCoverage: number;
}

export type QualityReason = 'too-dark' | 'too-blurry' | 'partial-finger';

export interface QualityVerdict {
  pass: boolean;
  /** demo-grade 0-100 heuristic combining the three metrics */
  score: number;
  reason?: QualityReason | undefined;
}

export function qualityThresholds(config: Config): QualityThresholds {
  return {
    minBrightness: config.qualityMinBrightness,
    minSharpness: config.qualityMinSharpness,
    minCoverage: config.qualityMinCoverage / 100,
  };
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export function assessQuality(m: QualityMetrics, t: QualityThresholds): QualityVerdict {
  if (m.brightness < t.minBrightness) return { pass: false, score: 0, reason: 'too-dark' };
  if (m.sharpness < t.minSharpness) return { pass: false, score: 0, reason: 'too-blurry' };
  if (m.coverage < t.minCoverage) return { pass: false, score: 0, reason: 'partial-finger' };
  const score = Math.round(
    100 * (0.4 * clamp01(m.brightness / 160) + 0.4 * clamp01(m.sharpness / 200) + 0.2 * clamp01(m.coverage / 0.6)),
  );
  return { pass: true, score };
}
