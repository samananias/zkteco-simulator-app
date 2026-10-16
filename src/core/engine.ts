/**
 * Protocol engine — the "device" itself (Phases 1–3).
 *
 * Speaks the ZKTeco standalone protocol on TCP :4370 so the pinned oracle
 * (node-zklib@1.3.0 as used by the BITS backend) connects and works unmodified.
 * Byte-level decisions come from docs/simulator-docs/research/zk-protocol-notes.md
 * and ADR-003/004/005/006:
 *
 *  - framing: 8-byte TCP prefix + 8-byte frame header, payload at offset 16
 *  - reads:   CMD_DATA_WRRQ → ACK_OK(+data-stat) → single CMD_DATA dataset frame
 *             (direct burst — what the oracle's readWithBuffer collects)
 *  - replies: echo the request's replyId; the session field carries the assigned
 *             session id (CONNECT) or the request's session (everything else)
 *  - events:  EF_ATTLOG only to sessions that registered (CMD_REG_EVENT),
 *             queued while an exchange is in flight (ADR-006)
 *  - checksums: inbound accepted leniently by default (ADR-005), outbound classic
 */

import net from 'node:net';
import { COMMANDS, EVENTS } from '../protocol/codes.js';
import { encodePacket, FrameParser, type Frame } from '../protocol/frame.js';
import { computeChecksum, type ChecksumVariant } from '../protocol/checksum.js';
import {
  encodeAttendance,
  encodeDataset,
  encodeEventRecord,
  encodeTemplateEntry,
  encodeUser,
  decodeUserWrite,
  type AttendanceRecord,
} from '../protocol/records.js';
import { decodeTime, encodeTime } from '../protocol/timecodec.js';
import { syntheticTemplate } from '../store/seed.js';
import type { Store } from '../store/types.js';
import type { DeviceState } from './device.js';
import type { EventBus } from './events.js';
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';

const EVENT_GAP_MS = 20; /** spacing between back-to-back event packets */

/** [A] Commkey scramble per zk-protocol-notes.md §8 — unused by the pinned backend (no key). */
function makeCommKey(key: number, sessionId: number, ticks = 50): Buffer {
  let reversed = 0;
  const source = key >>> 0;
  for (let i = 0; i < 32; i += 1) {
    if (source & (1 << i)) reversed |= 1 << (31 - i);
  }
  const sum = (reversed + sessionId) >>> 0;
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(sum, 0);
  const zkso = Buffer.from([0x5a, 0x4b, 0x53, 0x4f]); // "ZKSO"
  for (let i = 0; i < 4; i += 1) buf[i] = (buf[i] ?? 0) ^ zkso[i]!;
  const swapped = [buf[2]!, buf[3]!, buf[0]!, buf[1]!];
  swapped[2] = ticks & 0xff; // byte 2 is replaced by the tick value
  return Buffer.from(swapped);
}

interface Session {
  id: number;
  socket: net.Socket;
  parser: FrameParser;
  sessionKey: number; // assigned device session id (0 until CONNECT)
  eventFlags: number; // CMD_REG_EVENT payload
  pendingWrite: { size: number; chunks: Buffer[] };
  pendingDataset: Buffer | null; // chunked read mode (ADR-004)
  pendingEnrollmentTimer?: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

interface ReplySpec {
  command: number;
  payload?: Buffer;
  /** override the session-field value (CONNECT assigns; STATE_RRQ returns state) */
  sessionField?: number;
  /** suppress the automatic reply (handler writes its own packets) */
  silent?: boolean;
  /** close the connection after replying (EXIT / failed AUTH) */
  closeAfter?: boolean;
}

export interface FaultConfig {
  /** If true, incoming TCP connections are immediately closed or rejected. */
  refuseConnections?: boolean;
  /** Artificial latency added to every TCP frame reply (in ms). */
  latencyMs?: number;
  /** Drop the connection on specific command without replying. */
  dropOnCommand?: number;
  /** Return CMD_ACK_ERROR for specific command */
  errorOnCommand?: number;
}

export interface EngineOptions {
  config: Config;
  store: Store;
  device: DeviceState;
  bus: EventBus;
  logger: Logger;
  pendingEnrollmentTimers?: Set<ReturnType<typeof setTimeout>>;
}

export class ProtocolEngine {
  private readonly server = net.createServer();
  private readonly sessions = new Map<number, Session>();
  private readonly pendingEnrollments = new Set<ReturnType<typeof setTimeout>>();
  private faultConfig: FaultConfig = {};
  private nextSessionKey = 30646; // plausible-looking device session ids
  private nextSessionId = 1;
  private listening = false;
  private punchListener: ((rec: AttendanceRecord) => void) | null = null;

  getFaults(): FaultConfig {
    return { ...this.faultConfig };
  }

  setFault(f: FaultConfig): void {
    this.faultConfig = { ...this.faultConfig, ...f };
  }

  clearFaults(): void {
    this.faultConfig = {};
  }

  constructor(private readonly opts: EngineOptions) {
    this.opts.pendingEnrollmentTimers = this.pendingEnrollments;
    this.server.on('connection', (socket) => this.onConnection(socket));
    this.server.on('error', (err) => this.opts.logger.error('tcp server error', { err: String(err) }));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once('error', onError);
      this.server.listen(this.opts.config.tcpPort, this.opts.config.tcpHost ?? '127.0.0.1', () => {
        this.server.removeListener('error', onError);
        this.listening = true;
        this.opts.logger.info('protocol engine listening', {
          host: this.opts.config.tcpHost ?? '127.0.0.1',
          port: (this.server.address() as net.AddressInfo).port,
        });
        resolve();
      });
    });
    this.punchListener = (rec) => this.broadcastAttendance(rec);
    this.opts.bus.on('punch', this.punchListener);
  }

  async stop(): Promise<void> {
    if (this.punchListener) this.opts.bus.off('punch', this.punchListener);
    for (const t of this.pendingEnrollments) {
      clearTimeout(t);
    }
    this.pendingEnrollments.clear();
    for (const session of this.sessions.values()) {
      session.pendingEnrollmentTimer = null;
      session.closed = true;
      session.socket.destroy();
    }
    this.sessions.clear();
    if (!this.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.listening = false;
  }

  get tcpPort(): number {
    const addr = this.server.address();
    return typeof addr === 'object' && addr ? addr.port : this.opts.config.tcpPort;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  // ------------------------------------------------------------ connections

  private onConnection(socket: net.Socket): void {
    if (this.faultConfig.refuseConnections) {
      this.opts.logger.warn('connection refused by fault injection', {
        peer: `${socket.remoteAddress}:${socket.remotePort}`,
      });
      socket.destroy();
      return;
    }

    // Security: Guard against TCP socket exhaustion attacks
    const MAX_CONCURRENT_SESSIONS = 24;
    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      this.opts.logger.warn('connection rejected — max concurrent sessions exceeded', {
        peer: `${socket.remoteAddress}:${socket.remotePort}`,
        activeSessions: this.sessions.size,
      });
      socket.destroy();
      return;
    }

    socket.setNoDelay(true);
    // Security: 60-second idle timeout to clean up abandoned TCP connections
    socket.setTimeout(60000, () => {
      this.opts.logger.debug('session timed out due to inactivity', { peer: `${socket.remoteAddress}:${socket.remotePort}` });
      socket.destroy();
    });

    const session: Session = {
      id: this.nextSessionId++,
      socket,
      parser: new FrameParser(),
      sessionKey: 0,
      eventFlags: 0,
      pendingWrite: { size: 0, chunks: [] },
      pendingDataset: null,
      closed: false,
    };
    this.sessions.set(session.id, session);
    this.opts.logger.info('session connected', {
      session: session.id,
      peer: `${socket.remoteAddress}:${socket.remotePort}`,
    });

    socket.on('data', (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = session.parser.push(chunk);
      } catch (err) {
        this.opts.logger.warn('frame parse failure', { session: session.id, err: String(err) });
        return;
      }
      for (const frame of frames) void this.handleFrame(session, frame);
    });
    socket.on('error', (err) =>
      this.opts.logger.debug('session socket error', { session: session.id, err: String(err) }),
    );
    socket.on('close', () => {
      // Note: do not cancel pendingEnrollmentTimer on socket disconnect.
      // Physical terminals perform enrollment on-device independently of the TCP connection.
      session.closed = true;
      this.sessions.delete(session.id);
      this.opts.logger.info('session closed', { session: session.id });
    });
  }

  /** Validate (ADR-005), dispatch, and answer one inbound frame. */
  private async handleFrame(session: Session, frame: Frame): Promise<void> {
    if (session.closed) return;
    const { config, logger } = this.opts;

    if (config.checksumStrict) {
      const frameBuf = Buffer.alloc(8 + frame.payload.length);
      frameBuf.writeUInt16LE(frame.command, 0);
      frameBuf.writeUInt16LE(0, 2); // checksum field zeroed for computation
      frameBuf.writeUInt16LE(frame.sessionId, 4);
      frameBuf.writeUInt16LE(frame.replyId, 6);
      frame.payload.copy(frameBuf, 8);
      const classic = computeChecksum(frameBuf, 'classic');
      const oracle = computeChecksum(frameBuf, 'oracle');
      if (frame.checksum !== classic && frame.checksum !== oracle) {
        logger.warn('inbound checksum mismatch — packet dropped (strict mode)', {
          session: session.id,
          expected: [classic, oracle],
          received: frame.checksum,
        });
        return;
      }
    }

    if (this.faultConfig.dropOnCommand === frame.command) {
      this.opts.logger.warn('dropping connection on command by fault injection', {
        session: session.id,
        cmd: frame.command,
      });
      session.closed = true;
      session.socket.destroy();
      return;
    }

    let reply: ReplySpec | null = null;
    try {
      if (this.faultConfig.errorOnCommand === frame.command) {
        this.opts.logger.warn('reply error injected on command', { session: session.id, cmd: frame.command });
        reply = { command: COMMANDS.CMD_ACK_ERROR };
      } else {
        reply =
          (await handleCore(this.opts, session, frame)) ??
          (await handleData(this.opts, session, frame)) ??
          (await handleUsers(this.opts, session, frame));
      }
    } catch (err) {
      logger.error('handler failure', { session: session.id, cmd: frame.command, err: String(err) });
      reply = { command: COMMANDS.CMD_ACK_ERROR };
    }
    if (reply === null) {
      logger.debug('unhandled command — ACK_UNKNOWN', { session: session.id, cmd: frame.command });
      reply = { command: COMMANDS.CMD_ACK_UNKNOWN };
    }

    const latency = this.faultConfig.latencyMs ?? 0;
    if (latency > 0) {
      setTimeout(() => {
        if (!reply!.silent && !session.closed) this.writeReply(session, frame, reply!);
        if (reply!.closeAfter && !session.closed) {
          session.closed = true;
          setTimeout(() => session.socket.end(), 50);
        }
      }, latency);
      return;
    }

    if (!reply.silent && !session.closed) this.writeReply(session, frame, reply);
    if (reply.closeAfter && !session.closed) {
      session.closed = true;
      setTimeout(() => session.socket.end(), 50);
    }
  }

  private writeReply(session: Session, request: Frame, reply: ReplySpec): void {
    const packet = encodePacket({
      command: reply.command,
      sessionId: reply.sessionField ?? request.sessionId,
      replyId: request.replyId,
      payload: reply.payload ?? Buffer.alloc(0),
      checksumVariant: this.opts.config.checksumVariant as ChecksumVariant,
    });
    this.writeRaw(session, packet);
  }

  private writeRaw(session: Session, packet: Buffer): void {
    if (session.closed) return;
    session.socket.write(packet);
  }

  /** EF_ATTLOG to every session that registered for it (ADR-006 gating). */
  private broadcastAttendance(rec: AttendanceRecord): void {
    for (const session of this.sessions.values()) {
      if (session.closed || !(session.eventFlags & EVENTS.EF_ATTLOG)) continue;
      const packet = encodePacket({
        command: COMMANDS.CMD_REG_EVENT,
        sessionId: EVENTS.EF_ATTLOG,
        replyId: 0,
        payload: encodeEventRecord(rec, this.opts.device.now(), this.opts.config.timeZone),
        checksumVariant: this.opts.config.checksumVariant as ChecksumVariant,
      });
      this.writeRaw(session, packet);
      this.opts.logger.debug('EF_ATTLOG sent', { session: session.id, userId: rec.deviceUserId });
    }
  }
}


// ------------------------------------------------------------- connections

/** Dependency view passed to the file-scope command handlers. */
type Deps = EngineOptions;

type MaybeReply = ReplySpec | null;

function ascii(buf: Buffer): string {
  const end = buf.indexOf(0x00);
  return buf.toString('ascii', 0, end === -1 ? buf.length : end);
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Session/device/time/options/LCD/event-registration commands. */
async function handleCore(deps: Deps, session: Session, frame: Frame): Promise<MaybeReply> {
  const C = COMMANDS;
  const { config, store, device, logger } = deps;
  const payload = frame.payload;
  const ack: ReplySpec = { command: C.CMD_ACK_OK };
  const err: ReplySpec = { command: C.CMD_ACK_ERROR };
  const unknown: ReplySpec = { command: C.CMD_ACK_UNKNOWN };

  switch (frame.command) {
    case C.CMD_CONNECT: {
      session.sessionKey = depsNextSessionKey();
      if (config.commKey > 0) {
        return { command: C.CMD_ACK_UNAUTH, sessionField: session.sessionKey };
      }
      logger.info('client connected', { session: session.id, sessionKey: session.sessionKey });
      return { command: C.CMD_ACK_OK, sessionField: session.sessionKey };
    }
    case C.CMD_AUTH: {
      const expected = makeCommKey(config.commKey, session.sessionKey);
      if (payload.length >= 4 && payload.subarray(0, 4).equals(expected)) {
        logger.info('commkey auth ok', { session: session.id });
        return ack;
      }
      logger.warn('commkey auth failed', { session: session.id });
      return { ...err, closeAfter: true };
    }
    case C.CMD_EXIT:
      return { ...ack, closeAfter: true };
    case C.CMD_ENABLEDEVICE:
      device.setEnabled(true);
      return ack;
    case C.CMD_DISABLEDEVICE:
      device.setEnabled(false);
      return ack;
    case C.CMD_RESTART:
      logger.info('restart requested — closing session', { session: session.id });
      return { ...ack, closeAfter: true };
    case C.CMD_GET_TIME:
      return { command: C.CMD_ACK_OK, payload: u32(encodeTime(device.now(), config.timeZone)) };
    case C.CMD_SET_TIME:
      if (payload.length >= 4) device.setNow(decodeTime(payload.readUInt32LE(0), config.timeZone));
      return ack;
    case C.CMD_GET_VERSION:
      return { command: C.CMD_ACK_OK, payload: Buffer.from('BITS-VIRTUAL-K14 8.0.4.1-2026\0', 'ascii') };
    case C.CMD_CHANGE_SPEED:
      return ack;
    case C.CMD_GET_FREE_SIZES: {
      const counts = await store.counts();
      const userCap = config.userCapacity ?? 3000;
      const tplCap = config.templateCapacity ?? 3000;
      const logCap = config.logCapacity ?? 100000;
      // node-zklib getInfo() reads TCP frame offsets 24/40/72 (payload offsets 16/32/64).
      // pyzk read_sizes() unpacks '20i' from payload:
      // index 4 (16) = users, index 6 (24) = fingers, index 8 (32) = records,
      // index 14 (56) = fingers_cap, index 15 (60) = users_cap, index 16 (64) = rec_cap,
      // index 17 (68) = fingers_av, index 18 (72) = users_av, index 19 (76) = rec_av.
      const buf = Buffer.alloc(80);
      buf.writeUInt32LE(counts.users, 16); // index 4: users (frame offset 24)
      buf.writeUInt32LE(counts.templates, 20); // index 5: tpl
      buf.writeUInt32LE(counts.templates, 24); // index 6: fingers (pyzk)
      buf.writeUInt32LE(counts.attendance, 32); // index 8: records/logs (frame offset 40)
      buf.writeUInt32LE(userCap, 48); // index 12: user cap
      buf.writeUInt32LE(tplCap, 52); // index 13: fp cap
      buf.writeUInt32LE(tplCap, 56); // index 14: fingers_cap (pyzk)
      buf.writeUInt32LE(userCap, 60); // index 15: users_cap (pyzk)
      buf.writeUInt32LE(logCap, 64); // index 16: logCapacity (frame offset 72)
      buf.writeUInt32LE(Math.max(0, tplCap - counts.templates), 68); // index 17: fingers_av
      buf.writeUInt32LE(Math.max(0, userCap - counts.users), 72); // index 18: users_av
      buf.writeUInt32LE(Math.max(0, logCap - counts.attendance), 76); // index 19: rec_av
      return { command: C.CMD_ACK_OK, payload: buf };
    }
    case C.CMD_STATE_RRQ:
      // spec: the state travels in the session field of the reply (notes §3)
      return { command: C.CMD_ACK_OK, sessionField: device.isEnabled() ? 1 : 5 };
    case C.CMD_OPTIONS_RRQ: {
      const key = ascii(payload).replace(/=$/, '');
      const value = await lookupOption(deps, key);
      if (value === undefined) return unknown;
      return { command: C.CMD_ACK_OK, payload: Buffer.from(`${value}\0`, 'ascii') };
    }
    case C.CMD_OPTIONS_WRQ: {
      const kv = ascii(payload);
      const eq = kv.indexOf('=');
      if (eq < 0) return err;
      const key = kv.slice(0, eq);
      const value = kv.slice(eq + 1);
      if (key === '~DeviceName') device.setDeviceName(value);
      await store.setOption(key, value);
      deps.bus.emit('users', { reason: 'option-write' });
      return ack;
    }
    case C.CMD_WRITE_LCD: {
      const lines = ascii(payload).split(/[\0\n]/).map((l) => l.trim()).filter(Boolean).slice(0, 2);
      device.setLcdLines(lines);
      return ack;
    }
    case C.CMD_CLEAR_LCD:
      device.clearLcd();
      return ack;
    case C.CMD_REG_EVENT:
      session.eventFlags = payload.length >= 4 ? payload.readUInt32LE(0) : 0;
      logger.debug('event registration', { session: session.id, flags: session.eventFlags });
      return ack;
    default:
      return null;
  }
}

let sessionKeyCounter = 30646;
function depsNextSessionKey(): number {
  sessionKeyCounter = (sessionKeyCounter % 60000) + 1000;
  return sessionKeyCounter;
}

async function lookupOption(deps: Deps, key: string): Promise<string | undefined> {
  const identity = deps.device.getIdentity();
  if (key === '~DeviceName' || key === 'DeviceName') return identity.name;
  if (key === '~SerialNumber' || key === '~SerialNumberLinux') return identity.serial;
  if (key === '~Platform' || key === 'Platform') return identity.platform;
  if (key === '~ZKFPVersion') return identity.fpVersion;
  if (key === '~OS') return identity.osVersion;
  if (key === '~MaxUserCount') return String(deps.config.userCapacity ?? 3000);
  if (key === '~MaxAttLogCount') return String(deps.config.logCapacity ?? 100000);
  if (key === '~MaxFingerCount') return String(deps.config.templateCapacity ?? 3000);
  return deps.store.getOption(key);
}

/** Bulk-data flows: dataset reads (ADR-004) and the template write sequence (FR-8). */
async function handleData(deps: Deps, session: Session, frame: Frame): Promise<MaybeReply> {
  const C = COMMANDS;
  const { store, logger, config } = deps;
  const payload = frame.payload;
  const ack: ReplySpec = { command: C.CMD_ACK_OK };
  const err: ReplySpec = { command: C.CMD_ACK_ERROR };

  /** raw packet write with this request's addressing */
  const write = (command: number, buf?: Buffer): void => {
    session.socket.write(encodePacket({
      command,
      sessionId: frame.sessionId,
      replyId: frame.replyId,
      payload: buf ?? Buffer.alloc(0),
      checksumVariant: config.checksumVariant as ChecksumVariant,
    }));
  };

  switch (frame.command) {
    case C.CMD_DATA_WRRQ: {
      let dataset: Buffer;
      let what: string;
      if (payload.length >= 2 && payload[1] === 0x09) {
        const users = await store.getUsers();
        dataset = encodeDataset(users.map(encodeUser));
        what = 'users';
      } else if (payload.length >= 2 && payload[1] === 0x0d) {
        const records = await store.getAttendance();
        dataset = encodeDataset(records.map((r) => encodeAttendance(r, config.timeZone)));
        what = 'attendance';
      } else {
        logger.warn('unrecognised DATA_WRRQ request', { session: session.id, hex: payload.toString('hex') });
        return { command: C.CMD_ACK_UNKNOWN };
      }

      if (config.readMode === 'direct') {
        // DIRECT BURST (the oracle's actual working path, ADR-004): the reply is a
        // single CMD_DATA frame and NOTHING else. requestData() resolves on the
        // first non-event packet; because it decodes as CMD_DATA, readWithBuffer
        // returns { data: packet.subarray(16) } = the dataset (u32 total + records)
        // and getUsers/getAttendances slice off the 4-byte total. An ACK before the
        // data would be consumed as the dataset by the same resolver — do not send one.
        session.pendingDataset = null;
        write(C.CMD_DATA, dataset);
        logger.debug('dataset served (direct burst)', { session: session.id, what, bytes: dataset.length });
        return { silent: true, command: 0 };
      }

      // CHUNKED mode (ADR-004): ACK_OK + data-stat, then the client drives with
      // CMD_DATA_RDY per chunk (handled in CMD_DATA_RDY below).
      session.pendingDataset = dataset;
      const stat = Buffer.alloc(9);
      stat.writeUInt8(0, 0);
      stat.writeUInt32LE(dataset.length, 1); // readWithBuffer: recvData.readUIntLE(1, 4)
      return { command: C.CMD_ACK_OK, payload: stat };
    }
    case C.CMD_DATA_RDY: {
      // [A] chunked continuation. The oracle's collector slices an 8-byte per-chunk
      // sub-header off each CMD_DATA payload (realTotalBuffer.length === chunk+8),
      // so each chunk payload is 8 opaque bytes + data. One single CMD_DATA frame
      // per DATA_RDY — the collector processes one packet per TCP event.
      const dataset = session.pendingDataset;
      if (!dataset || payload.length < 8) return err;
      const start = payload.readUInt32LE(0);
      const size = payload.readUInt32LE(4);
      const slice = dataset.subarray(start, Math.min(start + size, dataset.length));
      const chunkPayload = Buffer.alloc(8 + slice.length);
      chunkPayload.writeUInt32LE(slice.length, 0);
      chunkPayload.writeUInt32LE(0, 4);
      slice.copy(chunkPayload, 8);
      if (start + slice.length >= dataset.length) session.pendingDataset = null;
      write(C.CMD_DATA, chunkPayload);
      return { silent: true, command: 0 };
    }
    case C.CMD_USERTEMP_RRQ: {
      if (payload.length < 3) return err;
      const uid = payload.readUInt16LE(0);
      const finger = payload.readUInt8(2);
      const tpl = await store.getTemplate(uid, finger);
      if (!tpl) {
        // empty slot: plain ACK_ERROR with no data — the driver probes this way (FR-8)
        return err;
      }
      return { command: C.CMD_DATA, payload: encodeTemplateEntry(uid, finger, tpl.flag, tpl.template) };
    }
    case C.CMD_PREPARE_DATA:
      // client → device write: [size u16][00 00]
      session.pendingWrite = { size: payload.length >= 2 ? payload.readUInt16LE(0) : 0, chunks: [] };
      return ack;
    case C.CMD_DATA:
      if (session.pendingWrite.size > 0 || session.pendingWrite.chunks.length > 0) {
        session.pendingWrite.chunks.push(Buffer.from(payload));
      }
      return ack;
    case C.CMD_CHECKSUM_BUFFER:
      return ack;
    case C.CMD_TMP_WRITE: {
      // [uid u16][fid u8][flag u8][size u16]
      if (payload.length < 6) return err;
      const uid = payload.readUInt16LE(0);
      const finger = payload.readUInt8(2);
      const flag = payload.readUInt8(3);
      const blob = Buffer.concat(session.pendingWrite.chunks);
      session.pendingWrite = { size: 0, chunks: [] };
      const existing = await store.getTemplate(uid, finger);
      if (!existing) {
        const counts = await store.counts();
        const maxTemplates = config.templateCapacity ?? 3000;
        if (counts.templates >= maxTemplates) {
          logger.warn('template write rejected: capacity exceeded', {
            session: session.id, count: counts.templates, max: maxTemplates,
          });
          return err;
        }
      }
      await store.saveTemplate({ uid, finger, flag, template: blob, format: 'synthetic' });
      deps.bus.emit('template', { uid, finger, action: 'write' });
      logger.info('template written', { session: session.id, uid, finger, bytes: blob.length });
      return ack;
    }
    case C.CMD_FREE_DATA:
      session.pendingWrite = { size: 0, chunks: [] };
      return ack;
    default:
      return null;
  }
}

// __USERS_HANDLER__

/** Users, templates housekeeping, and cosmetic ACK-only commands. */
async function handleUsers(deps: Deps, session: Session, frame: Frame): Promise<MaybeReply> {
  const C = COMMANDS;
  const { store, bus, logger, config } = deps;
  const payload = frame.payload;
  const ack: ReplySpec = { command: C.CMD_ACK_OK };
  const err: ReplySpec = { command: C.CMD_ACK_ERROR };

  switch (frame.command) {
    case C.CMD_USER_WRQ: {
      const user = decodeUserWrite(payload);
      if (!user) return err;
      const existing = await store.getUser(user.uid);
      if (!existing) {
        const counts = await store.counts();
        const maxUsers = config.userCapacity ?? 3000;
        if (counts.users >= maxUsers) {
          logger.warn('user write rejected: capacity exceeded', {
            session: session.id, count: counts.users, max: maxUsers,
          });
          return err;
        }
      }
      await store.upsertUser(user);
      bus.emit('users', { reason: 'user-write' });
      logger.info('user written', {
        session: session.id, uid: user.uid, userId: user.userId, name: user.name,
      });
      return ack;
    }
    case C.CMD_DELETE_USER: {
      if (payload.length < 2) return err;
      const uid = payload.readUInt16LE(0);
      await store.deleteTemplatesForUser(uid);
      const removed = await store.deleteUser(uid);
      bus.emit('users', { reason: 'user-delete' });
      logger.info('user deleted', { session: session.id, uid, removed });
      return removed ? ack : err;
    }
    case C.CMD_DELETE_USERTEMP: {
      if (payload.length < 3) return err;
      const uid = payload.readUInt16LE(0);
      const finger = payload.readUInt8(2);
      await store.deleteTemplate(uid, finger);
      bus.emit('template', { uid, finger, action: 'delete' });
      return ack;
    }
    case C.CMD_CLEAR_ATTLOG: {
      await store.clearAttendance();
      bus.emit('users', { reason: 'clear-attlog' });
      logger.info('attendance cleared', { session: session.id });
      return ack;
    }
    case C.CMD_CLEAR_DATA: {
      // Real firmware wipes stored data; a type byte of 2 limits the wipe to
      // templates (the form the BITS backend uses).
      const type = payload.length >= 1 ? payload.readUInt8(0) : 0;
      if (type === 2) {
        for (const t of await store.getTemplates()) await store.deleteTemplate(t.uid, t.finger);
      } else {
        await store.clearAttendance();
        for (const t of await store.getTemplates()) await store.deleteTemplate(t.uid, t.finger);
      }
      bus.emit('users', { reason: 'clear-data' });
      logger.info('data cleared', { session: session.id, type });
      return ack;
    }
    case C.CMD_STARTENROLL: {
      // TCP Format (from pyzk / BITS zk-driver):
      //   pack('<24sbb', visibleUserId, fingerIndex, overwriteFlag)
      //   24 bytes: visible userId string
      //   1 byte:   finger index (0-9)
      //   1 byte:   overwrite flag (1 = allow overwrite)
      if (payload.length < 25) return err;
      const visibleId = ascii(payload.subarray(0, 24)).trim();
      const finger = payload.readUInt8(24);
      const overwrite = payload.length >= 26 ? payload.readUInt8(25) : 1;

      if (finger < 0 || finger > 9) {
        logger.warn('STARTENROLL rejected: invalid finger slot', { session: session.id, finger });
        return err;
      }

      let user = await store.getUserByUserId(visibleId);
      if (!user) {
        const parsedUid = Number.parseInt(visibleId, 10);
        if (!Number.isNaN(parsedUid)) {
          user = await store.getUser(parsedUid);
        }
      }

      if (!user) {
        logger.warn('STARTENROLL rejected: user not found on device', { session: session.id, visibleId });
        return err;
      }

      const existing = await store.getTemplate(user.uid, finger);
      if (existing && overwrite !== 1) {
        logger.warn('STARTENROLL rejected: slot occupied and overwrite disabled', {
          session: session.id,
          uid: user.uid,
          finger,
        });
        return err;
      }

      if (!existing) {
        const counts = await store.counts();
        const maxTemplates = config.templateCapacity ?? 3000;
        if (counts.templates >= maxTemplates) {
          logger.warn('STARTENROLL rejected: template capacity exceeded', {
            session: session.id, count: counts.templates, max: maxTemplates,
          });
          return err;
        }
      }

      if (session.pendingEnrollmentTimer) {
        clearTimeout(session.pendingEnrollmentTimer);
        deps.pendingEnrollmentTimers?.delete(session.pendingEnrollmentTimer);
        session.pendingEnrollmentTimer = null;
      }

      const uid = user.uid;
      const delayMs = config.enrollDelayMs ?? 1500;
      const timer = setTimeout(async () => {
        session.pendingEnrollmentTimer = null;
        deps.pendingEnrollmentTimers?.delete(timer);
        try {
          const blob = syntheticTemplate(uid, finger);
          await store.saveTemplate({ uid, finger, flag: 1, template: blob, format: 'synthetic' });
          bus.emit('template', { uid, finger, action: 'write' });
          logger.info('synthetic enrollment completed', { session: session.id, uid, finger, bytes: blob.length });
        } catch (e) {
          logger.error('failed to save synthetic template', { err: String(e) });
        }
      }, delayMs);
      session.pendingEnrollmentTimer = timer;
      deps.pendingEnrollmentTimers?.add(timer);

      logger.info('synthetic enrollment started', { session: session.id, uid, finger, delayMs });
      return ack;
    }
    case C.CMD_CANCELCAPTURE: {
      if (session.pendingEnrollmentTimer) {
        clearTimeout(session.pendingEnrollmentTimer);
        deps.pendingEnrollmentTimers?.delete(session.pendingEnrollmentTimer);
        session.pendingEnrollmentTimer = null;
        logger.info('pending enrollment cancelled', { session: session.id });
      }
      return ack;
    }
    case C.CMD_STARTVERIFY:
      return ack;
    case C.CMD_REFRESHDATA:
    case C.CMD_REFRESHOPTION:
    case C.CMD_UNLOCK:
    case C.CMD_CLEAR_ADMIN: {
      const users = await store.getUsers();
      let cleared = 0;
      for (const u of users) {
        if ((u.role ?? 0) > 0) {
          await store.upsertUser({ ...u, role: 0 });
          cleared++;
        }
      }
      bus.emit('users', { reason: 'clear-admin' });
      logger.info('admins cleared', { session: session.id, cleared });
      return ack;
    }
    case C.CMD_GET_PINWIDTH:
    case C.CMD_ENABLE_CLOCK:
    case C.CMD_CAPTUREFINGER:
    case C.CMD_CAPTUREIMAGE:
    case C.CMD_TEST_TEMP:
    case C.CMD_TESTVOICE:
    case C.CMD_POWEROFF:
    case C.CMD_SLEEP:
    case C.CMD_RESUME:
      return ack;
    default:
      return null;
  }
}

