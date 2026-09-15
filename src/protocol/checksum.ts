/**
 * Checksum codecs for the 8-byte in-frame header + data.
 *
 * Two published variants exist and differ by exactly 1:
 *   classic (spec / pyzk):  65535 - sum
 *   oracle  (node-zklib):   65535 - sum - 1
 *
 * Both reduce the little-endian u16 words the same way (an odd trailing byte is
 * added on its own; high-16 folding is equivalent to `mod 65535`).
 *
 * Policy (ADR-005):
 *   - inbound: accept EITHER variant (strict mode rejects packets matching neither)
 *   - outbound: `classic` by default, switchable via ZK_CHECKSUM_VARIANT
 *
 * Rationale: the pinned oracle never validates reply checksums, so it cannot break
 * either way; the classic variant is the one documented in the protocol spec.
 */

import { USHRT_MAX } from './codes.js';

export type ChecksumVariant = 'classic' | 'oracle';

/** Raw reduced sum of the u16-LE words of `buf` (checksum field expected to be zero). */
export function wordSum(buf: Buffer): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    const word = i === buf.length - 1 ? (buf[i] ?? 0) : buf.readUInt16LE(i);
    sum = (sum + word) % USHRT_MAX;
  }
  return sum;
}

export function classicChecksum(buf: Buffer): number {
  return (USHRT_MAX - wordSum(buf)) & 0xffff;
}

export function oracleChecksum(buf: Buffer): number {
  return (USHRT_MAX - wordSum(buf) - 1) & 0xffff;
}

export function computeChecksum(buf: Buffer, variant: ChecksumVariant): number {
  return variant === 'oracle' ? oracleChecksum(buf) : classicChecksum(buf);
}

export interface ChecksumVerdict {
  ok: boolean;
  /** which variant the packet's checksum matches, or null when neither does */
  matched: ChecksumVariant | null;
  actual: number;
  classic: number;
  oracle: number;
}

/** Evaluate an inbound packet. `buf` must be the 8-byte in-frame header + data. */
export function verifyChecksum(buf: Buffer, actual: number): ChecksumVerdict {
  const classic = classicChecksum(buf);
  const oracle = oracleChecksum(buf);
  const matched = actual === classic ? 'classic' : actual === oracle ? 'oracle' : null;
  return { ok: matched !== null, matched, actual, classic, oracle };
}
