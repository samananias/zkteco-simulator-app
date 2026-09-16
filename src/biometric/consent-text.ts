/**
 * Consent statement as data (Phase 8, ADR-011 §4 / NFR-10).
 *
 * The text an enrollee reads is served by `GET /api/biometric/consent` and
 * identified by a version + SHA-256 hash. The consent ledger stores that
 * version/hash, so the record proves *which text* was agreed to. Editing the
 * statement therefore requires bumping the version — and a page presenting an
 * outdated version is rejected rather than silently collecting consent for text
 * nobody read.
 */

import { createHash } from 'node:crypto';

/** Purpose binding (NFR-10): the only use this project may make of a template. */
export const CONSENT_PURPOSE = 'attendance-identification';

export interface ConsentStatement {
  version: string;
  purpose: string;
  text: string;
  /** SHA-256 of `text` — links a stored consent record to the exact wording */
  hash: string;
}

/** Versioned statements. Append, never edit: a published version must stay stable. */
const STATEMENTS: Record<string, string> = {
  v1: [
    'I consent to having my fingerprint captured for attendance identification only.',
    'A camera image of my finger is taken, reduced to a mathematical template, and the image is discarded immediately — it is never stored.',
    'The template is encrypted, kept only while my employee record exists, and deleted when I withdraw consent.',
    'I understand that I may withdraw this consent at any time; after withdrawal my template is deleted and I record attendance another way.',
  ].join(' '),
};

/** Version served by default — override with `ZK_CONSENT_VERSION` (must exist here). */
export const LATEST_CONSENT_VERSION = 'v1';

export function consentTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Resolves a version to its statement, or `undefined` for an unknown version. */
export function consentStatement(version: string): ConsentStatement | undefined {
  const text = STATEMENTS[version];
  if (!text) return undefined;
  return { version, purpose: CONSENT_PURPOSE, text, hash: consentTextHash(text) };
}

export function consentVersions(): string[] {
  return Object.keys(STATEMENTS);
}
