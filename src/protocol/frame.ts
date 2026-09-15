/**
 * ZKTeco TCP framing.
 *
 * A TCP packet on the wire is TWO nested structures (verified against the pinned
 * oracle `node-zklib@1.3.0` — see docs/simulator-docs/research/zk-protocol-notes.md §3):
 *
 *   ┌─ prefix (8 B) ────────────┬─ frame (8 B) ────────────────────────┬─ payload ─┐
 *   │ 50 50 82 7d               │ command   u16 LE                     │           │
 *   │ totalLen  u16 LE @4       │ checksum  u16 LE                     │           │
 *   │ 00 00 @6                  │ sessionId u16 LE                     │           │
 *   │                           │ replyId   u16 LE                     │           │
 *   └───────────────────────────┴──────────────────────────────────────┴───────────┘
 *
 * `totalLen` = the length of the FRAME (8 + payload), NOT including the prefix.
 * The oracle's `removeTcpHeader()` strips the prefix only when the magic matches,
 * and its `decodeTCPHeader()`/`readWithBuffer()` both read the frame from offset 8
 * (`reply.subarray(16)` === payload). Both directions must therefore carry it.
 */

import { computeChecksum, type ChecksumVariant } from './checksum.js';
import { TCP_PREFIX } from './codes.js';

export const PREFIX_LEN = 8;
export const FRAME_HEADER_LEN = 8;
/** prefix + frame header — the offset at which payload data begins in a packet. */
export const PACKET_HEADER_LEN = PREFIX_LEN + FRAME_HEADER_LEN;

export interface Frame {
  command: number;
  checksum: number;
  sessionId: number;
  replyId: number;
  payload: Buffer;
}

export interface EncodeOptions {
  command: number;
  sessionId: number;
  replyId: number;
  payload?: Buffer;
  checksumVariant?: ChecksumVariant;
}

/** Build a complete on-wire packet (prefix + frame + payload). */
export function encodePacket(options: EncodeOptions): Buffer {
  const payload = options.payload ?? Buffer.alloc(0);
  const frame = Buffer.alloc(FRAME_HEADER_LEN + payload.length);
  frame.writeUInt16LE(options.command, 0);
  frame.writeUInt16LE(0, 2);
  frame.writeUInt16LE(options.sessionId, 4);
  frame.writeUInt16LE(options.replyId, 6);
  payload.copy(frame, FRAME_HEADER_LEN);
  frame.writeUInt16LE(computeChecksum(frame, options.checksumVariant ?? 'classic'), 2);

  const prefix = Buffer.alloc(PREFIX_LEN);
  TCP_PREFIX.copy(prefix, 0);
  prefix.writeUInt16LE(frame.length, 4);
  return Buffer.concat([prefix, frame]);
}

/** Build a payload-free packet and parse it back — used by the golden-bytes tests. */
export function encodeFrame(options: EncodeOptions): Buffer {
  return encodePacket(options);
}

/**
 * Incremental TCP stream parser.
 *
 * The oracle may coalesce or split writes arbitrarily, so packets are extracted
 * from a rolling buffer. A packet is accepted either prefixed (the normal case)
 * or bare — in the bare case the frame carries no length field, so the whole
 * buffered chunk is treated as one packet (lenient by design, ADR-005).
 */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];

    for (;;) {
      if (this.buffer.length < PREFIX_LEN) break;
      const prefixed =
        this.buffer.length >= TCP_PREFIX.length && this.buffer.subarray(0, TCP_PREFIX.length).equals(TCP_PREFIX);
      const offset = prefixed ? PREFIX_LEN : 0;
      if (this.buffer.length < offset + FRAME_HEADER_LEN) break;

      let frameLength: number;
      if (prefixed) {
        frameLength = this.buffer.readUInt16LE(4);
        if (frameLength < FRAME_HEADER_LEN) {
          // Malformed length — drop the prefix and resynchronise on the next byte.
          this.buffer = this.buffer.subarray(1);
          continue;
        }
      } else {
        frameLength = this.buffer.length - offset;
      }

      if (this.buffer.length < offset + frameLength) {
        if (prefixed) break;
        frameLength = this.buffer.length - offset;
      }

      const frame = this.buffer.subarray(offset, offset + frameLength);
      frames.push({
        command: frame.readUInt16LE(0),
        checksum: frame.readUInt16LE(2),
        sessionId: frame.readUInt16LE(4),
        replyId: frame.readUInt16LE(6),
        payload: Buffer.from(frame.subarray(FRAME_HEADER_LEN)),
      });
      this.buffer = this.buffer.subarray(offset + frameLength);
      if (!prefixed) break;
    }

    return frames;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
