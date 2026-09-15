/**
 * Biometric template encryption at rest (ADR-011 §2).
 *
 * AES-256-GCM with a fresh 96-bit IV per record; layout: [12 B iv][16 B tag][ciphertext].
 * The key comes from `ZK_BIOMETRIC_KEY` (hex or base64, 32 bytes); without it a session
 * key is generated with a loud warning — ciphertext then dies with the process, which is
 * the safe default (no plaintext ever, no silently-weak persisted key).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class BiometricKeyError extends Error {}

export interface BiometricKey {
  readonly bytes: Buffer;
  readonly source: 'env' | 'session';
}

/** Parses a user-provided key: 64 hex chars, base64 decoding to 32 bytes, or 32 raw UTF-8 bytes. */
export function loadBiometricKey(raw: string): BiometricKey {
  const trimmed = raw.trim();
  let bytes: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    bytes = Buffer.from(trimmed, 'hex');
  } else {
    try {
      const decoded = Buffer.from(trimmed, 'base64');
      if (decoded.length === 32 && /^[A-Za-z0-9+/=]+$/.test(trimmed)) bytes = decoded;
    } catch {
      /* fall through to utf-8 */
    }
    if (!bytes && Buffer.byteLength(trimmed, 'utf8') === 32) bytes = Buffer.from(trimmed, 'utf8');
  }
  if (!bytes || bytes.length !== 32) {
    throw new BiometricKeyError(
      'ZK_BIOMETRIC_KEY must be 32 bytes (64 hex chars, base64, or 32 raw utf-8 chars)',
    );
  }
  return { bytes, source: 'env' };
}

/** Dev/demo fallback when no key is configured — lives only for this process. */
export function generateSessionKey(): BiometricKey {
  return { bytes: randomBytes(32), source: 'session' };
}

export function encrypt(key: BiometricKey, plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.bytes, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decrypt(key: BiometricKey, blob: Buffer): Buffer {
  if (blob.length < 12 + 16) throw new BiometricKeyError('ciphertext truncated');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', key.bytes, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}
