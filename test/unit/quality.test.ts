/**
 * Phase 7 unit tests — the quality gate's policy layer (verdicts + score from
 * sidecar-measured metrics). No sidecar, no images: measurement is the sidecar's
 * job; this only tests the configurable decision rules (FR-16.1, ADR-011 §7).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import { assessQuality, qualityThresholds, type QualityMetrics } from '../../src/capture/quality.js';

const M = (over: Partial<QualityMetrics> = {}): QualityMetrics => ({
  brightness: 140,
  sharpness: 300,
  coverage: 0.7,
  ...over,
});

const T = qualityThresholds(loadConfig([])); // defaults: 60 / 25 / 18%

test('quality gate accepts a well-lit, sharp, textured frame', () => {
  const v = assessQuality(M(), T);
  assert.equal(v.pass, true);
  assert.ok(v.score >= 80, `score=${v.score}`);
  assert.equal(v.reason, undefined);
});

test('quality gate rejects dark frames as too-dark', () => {
  const v = assessQuality(M({ brightness: 30 }), T);
  assert.equal(v.pass, false);
  assert.equal(v.reason, 'too-dark');
  assert.equal(v.score, 0);
});

test('quality gate rejects smooth frames as too-blurry', () => {
  const v = assessQuality(M({ sharpness: 5 }), T);
  assert.equal(v.pass, false);
  assert.equal(v.reason, 'too-blurry');
});

test('quality gate rejects frames without ridge texture as partial-finger', () => {
  const v = assessQuality(M({ coverage: 0.05 }), T);
  assert.equal(v.pass, false);
  assert.equal(v.reason, 'partial-finger');
});

test('quality gate boundary: exactly at the thresholds passes', () => {
  const v = assessQuality(M({ brightness: 60, sharpness: 25, coverage: 0.18 }), T);
  assert.equal(v.pass, true);
});

test('quality score is bounded and reflects the metrics', () => {
  const strong = assessQuality(M({ brightness: 160, sharpness: 200, coverage: 0.6 }), T);
  const weak = assessQuality(M({ brightness: 70, sharpness: 30, coverage: 0.2 }), T);
  assert.ok(strong.score > weak.score, `${strong.score} vs ${weak.score}`);
  for (const v of [strong, weak]) {
    assert.ok(v.score >= 0 && v.score <= 100, `score=${v.score}`);
    assert.equal(v.pass, true);
  }
});

test('thresholds are configurable, never hard-coded (ADR-011 §7)', () => {
  const strict = qualityThresholds(loadConfig(['--zk-quality-min-brightness', '100', '--zk-quality-min-sharpness', '150', '--zk-quality-min-coverage', '40']));
  assert.equal(assessQuality(M({ brightness: 80 }), strict).reason, 'too-dark');
  assert.equal(assessQuality(M({ sharpness: 100 }), strict).reason, 'too-blurry');
  assert.equal(assessQuality(M({ coverage: 0.3 }), strict).reason, 'partial-finger');
  assert.equal(assessQuality(M({ brightness: 150, sharpness: 300, coverage: 0.8 }), strict).pass, true);
});
