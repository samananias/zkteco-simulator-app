/**
 * HTTP + WebSocket layer (Phases 3–4).
 *
 * REST surface per docs/simulator-docs/architecture/api-and-events.md §1 and the
 * WS messages of web-ui.md §3. The store never learns about sockets — this layer
 * subscribes to the EventBus and adapts domain events to JSON fan-out.
 */

import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Store } from '../store/types.js';
import type { BiometricService } from '../biometric/service.js';
import { BiometricServiceError } from '../biometric/service.js';
import { MatcherUnavailableError } from '../biometric/matcher.js';
import type { DeviceState } from './device.js';
import type { EventBus } from './events.js';
import type { AttendanceRecord } from '../protocol/records.js';
import type { FaultConfig } from './engine.js';

export interface HttpOptions {
  config: Config;
  store: Store;
  device: DeviceState;
  bus: EventBus;
  logger: Logger;
  /** Phase 6+ biometric core — present only when ZK_MATCHER_URL is configured (NFR-12) */
  biometric?: BiometricService | undefined;
  getFaults?(): FaultConfig;
  setFault?(f: FaultConfig): void;
  clearFaults?(): void;
  /** restore the seed state (POST /api/reset) */
  reset(): Promise<void>;
}

interface PunchBody {
  userId?: string | number;
  verifyType?: number;
  state?: number;
  timestamp?: string | number;
  forceFail?: boolean;
  force?: boolean;
  cancel?: boolean;
  cancelled?: boolean;
  disabled?: boolean;
}

function getWebDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const siblingWeb = path.join(currentDir, '..', 'web');
  if (existsSync(siblingWeb)) return siblingWeb;
  const srcWeb = path.join(currentDir, '..', '..', 'src', 'web');
  if (existsSync(srcWeb)) return srcWeb;
  return siblingWeb;
}

const WEB_DIR = getWebDir();

const ALLOWED_ORIGINS = new Set([
  'http://localhost:3030',
  'http://127.0.0.1:3030',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : []),
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()) : []),
]);

export class HttpServer {
  private readonly server = http.createServer((req, res) => void this.route(req, res));
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly rateLimitWindow = new Map<string, number[]>();
  private listening = false;

  private checkRateLimit(ip: string, maxRequests = 40, windowMs = 5000): boolean {
    const now = Date.now();
    const timestamps = (this.rateLimitWindow.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (timestamps.length >= maxRequests) {
      return false;
    }
    timestamps.push(now);
    this.rateLimitWindow.set(ip, timestamps);
    return true;
  }

  constructor(private readonly deps: HttpOptions) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.deps.config.httpPort, this.deps.config.httpHost, () => {
        this.server.removeListener('error', reject);
        this.listening = true;
        resolve();
      });
    });
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url === '/ws') {
        this.wss.handleUpgrade(req, socket as never, head, (ws) => this.onConnection(ws));
      } else {
        socket.destroy();
      }
    });
    // domain events → WS JSON fan-out
    this.deps.bus.on('state', (e) => this.broadcast({ type: 'state', state: serializeState(e) }));
    this.deps.bus.on('verify', (e) =>
      this.broadcast({
        type: 'verify',
        result: e.result,
        user: e.user ? { name: e.user.name, userId: e.user.userId } : undefined,
        userId: e.userId,
        verifyType: e.verifyType,
        at: e.at.toISOString(),
      }),
    );
    this.deps.bus.on('punch', (rec) => this.broadcast({ type: 'punch', record: serializeRecord(rec) }));
    this.deps.bus.on('users', () => void this.pushUsers());
    this.deps.bus.on('lcd', (e) => this.broadcast({ type: 'lcd', lines: e.lines }));
    this.deps.logger.info('http server listening', {
      port: (this.server.address() as { port: number }).port,
    });
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    if (!this.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.listening = false;
  }

  get port(): number {
    const addr = this.server.address();
    return typeof addr === 'object' && addr ? addr.port : this.deps.config.httpPort;
  }

  // -------------------------------------------------------------- routing

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Security: Check origin to block CSRF and cross-origin attacks from untrusted domains
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      this.deps.logger.warn('blocked untrusted cross-origin request', { origin, path: url.pathname });
      res.writeHead(403, {
        'content-type': 'application/json',
        'x-content-type-options': 'nosniff',
      });
      res.end(JSON.stringify({ error: 'Forbidden: untrusted origin' }));
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': origin ?? 'http://localhost:3000',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'Content-Type',
        'x-content-type-options': 'nosniff',
      });
      res.end();
      return;
    }

    // Security: Rate-limit sensitive modification endpoints against flood DoS
    if ((url.pathname === '/api/punch' || url.pathname === '/api/reset') && req.method === 'POST') {
      const clientIp = req.socket.remoteAddress || '127.0.0.1';
      if (!this.checkRateLimit(clientIp)) {
        this.deps.logger.warn('rate limit exceeded for client', { clientIp, path: url.pathname });
        res.writeHead(429, {
          'content-type': 'application/json',
          'x-content-type-options': 'nosniff',
        });
        res.end(JSON.stringify({ error: 'Too Many Requests — rate limit exceeded' }));
        return;
      }
    }

    try {
      if (url.pathname === '/api/device/state' && req.method === 'GET') {
        return await this.json(res, { ...this.stateBody(), counts: await this.counts() });
      }
      if (url.pathname === '/api/users' && req.method === 'GET') {
        return await this.json(res, { users: await this.deps.store.getUsers() });
      }
      if (url.pathname === '/api/attendance') {
        if (req.method === 'GET') {
          const records = await this.deps.store.getAttendance();
          const desc = [...records].sort((a, b) => b.time.getTime() - a.time.getTime());
          return await this.json(res, { attendance: desc.map(serializeRecord) });
        }
        if (req.method === 'DELETE') {
          await this.deps.store.clearAttendance();
          this.deps.bus.emit('users', { reason: 'clear-attlog' });
          return await this.json(res, { ok: true, cleared: true });
        }
      }
      if (url.pathname === '/api/punch' && req.method === 'POST') {
        return await this.punch(req, res);
      }
      if (url.pathname === '/api/lcd' && req.method === 'POST') {
        const body = await readJson<{ lines?: string[] }>(req);
        const lines = Array.isArray(body.lines) ? body.lines.map(String).slice(0, 2) : [];
        this.deps.device.setLcdLines(lines);
        return await this.json(res, { ok: true, lines });
      }
      if (url.pathname === '/api/clock') {
        if (req.method === 'GET') {
          return await this.json(res, {
            deviceTime: this.deps.device.now().toISOString(),
            hostTime: new Date().toISOString(),
            offsetMinutes: this.deps.device.getTimeOffsetMinutes(),
          });
        }
        if (req.method === 'POST') {
          const body = await readJson<{ offsetMinutes?: number; now?: string }>(req);
          if (body.offsetMinutes !== undefined) {
            this.deps.device.setNow(new Date(Date.now() + body.offsetMinutes * 60_000));
          } else if (body.now) {
            this.deps.device.setNow(new Date(body.now));
          }
          return await this.json(res, {
            ok: true,
            deviceTime: this.deps.device.now().toISOString(),
            offsetMinutes: this.deps.device.getTimeOffsetMinutes(),
          });
        }
      }
      if (url.pathname === '/api/fault' || url.pathname === '/api/fault/clear') {
        if (req.method === 'GET') {
          return await this.json(res, { faults: this.deps.getFaults?.() ?? {} });
        }
        if (req.method === 'POST') {
          if (url.pathname === '/api/fault/clear') {
            this.deps.clearFaults?.();
            return await this.json(res, { ok: true, faults: {} });
          }
          const body = await readJson<FaultConfig & { clear?: boolean }>(req);
          if (body.clear) {
            this.deps.clearFaults?.();
            return await this.json(res, { ok: true, faults: {} });
          }
          this.deps.setFault?.(body);
          return await this.json(res, { ok: true, faults: this.deps.getFaults?.() ?? {} });
        }
        if (req.method === 'DELETE') {
          this.deps.clearFaults?.();
          return await this.json(res, { ok: true, faults: {} });
        }
      }
      if (url.pathname === '/api/reset' && req.method === 'POST') {
        await this.deps.reset();
        return await this.json(res, { ok: true });
      }
      if (url.pathname.startsWith('/api/biometric/')) {
        return await this.biometricRoute(req, res, url.pathname);
      }
      if (req.method === 'GET') {
        if (url.pathname === '/enroll' || url.pathname === '/scan' || url.pathname === '/biometric') {
          if (!this.deps.biometric) {
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><html><head><title>Biometrics Disabled</title><link rel="stylesheet" href="/style.css"></head>
              <body style="padding:40px;font-family:sans-serif;background:#111;color:#eee;text-align:center;">
                <h2>Biometric Real-Capture Suite Disabled</h2>
                <p>This virtual terminal operates with synthetic credentials by default (privacy & compliance policy).</p>
                <p>To enable the SourceAFIS sidecar, launch with <code>ZK_BIOMETRIC_REAL=true</code> and <code>ZK_MATCHER_URL</code> configured.</p>
                <p style="margin-top:20px;"><a href="/" style="color:#00ff88;text-decoration:none;">&larr; Return to Terminal Face</a></p>
              </body></html>`);
            return;
          }
          return await this.serveStatic(res, `${url.pathname}.html`); // station + admin pages (Phase 7–8)
        }
        return await this.serveStatic(res, url.pathname);
      }
      res.writeHead(405).end();
    } catch (err) {
      this.deps.logger.warn('http error', { path: url.pathname, err: String(err) });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  }

  private async punch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJson<PunchBody>(req);
    const userId = String(body.userId ?? '').trim();
    const verifyType = body.verifyType ?? 1;
    const state = body.state ?? 0;
    const at = body.timestamp !== undefined ? new Date(body.timestamp) : this.deps.device.now();

    // Security: Validate userId format (alphanumeric/dashes only, max 24 chars)
    if (!/^[a-zA-Z0-9_-]{1,24}$/.test(userId)) {
      res.writeHead(400, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify({ result: 'fail', reason: 'invalid or malformed userId format' }));
      return;
    }

    // Security: Validate timestamp sanity bounds (must be year 2000+ and not >24h in future)
    const nowMs = Date.now();
    const atMs = at.getTime();
    if (isNaN(atMs) || at.getFullYear() < 2000 || atMs > nowMs + 86_400_000) {
      res.writeHead(400, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify({ result: 'fail', reason: 'timestamp out of acceptable bounds' }));
      return;
    }

    // R1: Capacity limit check
    const counts = await this.deps.store.counts();
    const maxLogs = this.deps.config.logCapacity ?? 100000;
    if (counts.attendance >= maxLogs) {
      this.deps.bus.emit('verify', { result: 'fail', userId, verifyType, at });
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: 'fail', reason: 'device log capacity exceeded' }));
      return;
    }

    // R2: Cancelled scan
    if (body.cancel || body.cancelled) {
      this.deps.bus.emit('verify', { result: 'fail', userId, verifyType, at });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: 'fail', reason: 'cancelled scan' }));
      return;
    }

    if (!this.deps.device.isEnabled()) {
      this.deps.bus.emit('verify', { result: 'fail', userId, verifyType, at });
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: 'fail', error: 'device disabled by admin' }));
      return;
    }

    const user = await this.deps.store.getUserByUserId(userId);
    if (!user || body.forceFail) {
      this.deps.bus.emit('verify', { result: 'fail', userId, verifyType, at });
      res.writeHead(user ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: 'fail', reason: user ? 'forced' : 'unknown user' }));
      return;
    }

    // R2: Disabled or inactive user
    if (user.enabled === false || body.disabled || user.role === -1) {
      this.deps.bus.emit('verify', { result: 'fail', user, userId: user.userId, verifyType, at });
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: 'fail', reason: 'user disabled or inactive' }));
      return;
    }

    // R2: Unsupported credential/verification type
    if (![0, 1, 2, 3, 4, 15].includes(verifyType)) {
      this.deps.bus.emit('verify', { result: 'fail', user, userId: user.userId, verifyType, at });
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: 'fail', reason: `unsupported verification mode: ${verifyType}` }));
      return;
    }

    // Realistic credential verification (M1 / M3 R2)
    if (verifyType === 1) {
      const templates = await this.deps.store.getTemplates();
      const userTemplates = templates.filter((t) => t.uid === user.uid);
      if (userTemplates.length === 0) {
        this.deps.bus.emit('verify', { result: 'fail', user, userId: user.userId, verifyType, at });
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: 'fail', reason: 'no enrolled fingerprint template' }));
        return;
      }
    } else if (verifyType === 2) {
      if (!user.card || user.card <= 0) {
        this.deps.bus.emit('verify', { result: 'fail', user, userId: user.userId, verifyType, at });
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: 'fail', reason: 'no registered card' }));
        return;
      }
    }

    // R3: Device-level duplicate punch suppression window
    const suppressionSec = this.deps.config.duplicatePunchWindowSeconds ?? 60;
    if (suppressionSec > 0 && !body.force) {
      const allLogs = await this.deps.store.getAttendance();
      const recent = allLogs.find((r) => {
        if (r.deviceUserId !== user.userId && r.userSn !== user.uid) return false;
        return Math.abs(at.getTime() - r.time.getTime()) < suppressionSec * 1000;
      });
      if (recent) {
        this.deps.logger.info('duplicate punch suppressed by device', {
          userId: user.userId,
          suppressionSec,
        });
        this.deps.bus.emit('verify', {
          result: 'suppressed',
          user,
          userId: user.userId,
          verifyType,
          at,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          result: 'suppressed',
          reason: 'duplicate punch within device suppression window',
          existingRecord: serializeRecord(recent),
        }));
        return;
      }
    }

    const record = await this.deps.store.addAttendance({
      userSn: user.uid,
      deviceUserId: user.userId,
      verifyType,
      state,
      time: at,
    });
    this.deps.bus.emit('attendance', record);
    this.deps.bus.emit('punch', record);
    this.deps.bus.emit('verify', { result: 'pass', user, userId: user.userId, verifyType, at });
    this.deps.logger.info('punch accepted', { userId: user.userId, name: user.name, state });
    await this.json(res, { result: 'pass', record: serializeRecord(record) });
  }

  // ------------------------------------------------ biometric REST v2 (Phase 6)
  //
  // The open REST surface any system can integrate with (FR-14…FR-18). Template
  // bytes ride request/response bodies only — they are never logged or echoed
  // in errors (ADR-011 §3). All decision endpoints answer 200 with a decision;
  // infrastructure problems answer 503 (NFR-12: never auto-accept).

  private async biometricRoute(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    const svc = this.deps.biometric;
    if (pathname === '/api/biometric/status' && req.method === 'GET') {
      if (!svc) return await this.json(res, { enabled: false, matcherUp: false, enrolled: 0 });
      return await this.json(res, await svc.status());
    }
    if (!svc) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'biometric features disabled — set ZK_BIOMETRIC_REAL=true (NFR-12)' }));
      return;
    }
    try {
      if (pathname === '/api/biometric/consent' && req.method === 'GET') {
        // the statement the enrollment page renders — served, never hard-coded in the page
        return await this.json(res, svc.consentStatement());
      }
      if (pathname === '/api/biometric/enrollments' && req.method === 'GET') {
        // metadata only — the encrypted templates never cross this boundary (ADR-011 §3)
        return await this.json(res, { enrollments: await svc.enrollments() });
      }
      if (pathname === '/api/biometric/consents' && req.method === 'GET') {
        return await this.json(res, { consents: await svc.consents() });
      }
      if (pathname === '/api/biometric/withdraw' && req.method === 'POST') {
        // employee-initiated deletion path (ADR-011 §5 / NFR-10)
        const body = await readJson<{ userId?: string; reason?: string }>(req);
        const result = await svc.withdrawEmployee(String(body.userId ?? ''), body.reason);
        return await this.json(res, { ok: true, ...result });
      }
      if (pathname === '/api/biometric/capture' && req.method === 'POST') {
        // raw image body (octet-stream) — measured + extracted in the sidecar, judged here
        const image = await readRaw(req);
        const verdict = await svc.captureProbe(image);
        if (verdict.decision === 'reject') {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, decision: 'reject', reason: verdict.reason, quality: verdict.quality, score: verdict.score }));
          return;
        }
        return await this.json(res, {
          ok: true,
          decision: 'accept',
          templateB64: verdict.template.toString('base64'),
          quality: verdict.quality,
          score: verdict.score,
        });
      }
      if (pathname === '/api/biometric/punch' && req.method === 'POST') {
        // the punch-controller composition point (biometric-core §2): identify → record
        const body = await readJson<{ templateB64?: string; state?: number; station?: string }>(req);
        const template = body.templateB64 ? Buffer.from(body.templateB64, 'base64') : Buffer.alloc(0);
        const station = body.station ?? this.deps.config.stationId;
        const verdict = await svc.identify(template);
        if (verdict.decision !== 'match') {
          const at = this.deps.device.now();
          this.deps.bus.emit('verify', { result: 'fail', userId: verdict.userId ?? '', verifyType: 1, at });
          this.deps.logger.info('biometric punch rejected', {
            decision: verdict.decision,
            reason: verdict.reason,
            score: verdict.score,
            station,
          });
          return await this.json(res, { result: 'fail', decision: verdict.decision, reason: verdict.reason, score: verdict.score });
        }
        if (!this.deps.device.isEnabled()) {
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ result: 'fail', error: 'device disabled by admin' }));
          return;
        }
        const user = await this.deps.store.getUserByUserId(String(verdict.userId));
        if (!user) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ result: 'fail', error: 'unknown employee' }));
          return;
        }
        const record = await this.recordPunch(user, { verifyType: 1, state: body.state ?? 0 });
        this.deps.logger.info('biometric punch accepted', {
          userId: user.userId,
          name: user.name,
          score: verdict.score,
          station,
        });
        return await this.json(res, {
          result: 'pass',
          decision: 'match',
          score: verdict.score,
          name: user.name,
          record: serializeRecord(record),
        });
      }
      if (pathname === '/api/biometric/enroll' && req.method === 'POST') {
        const body = await readJson<{
          userId?: string;
          finger?: number;
          templateB64?: string;
          samples?: string[];
          quality?: number;
          source?: 'camera' | 'usb-otg' | 'pc-scanner' | 'imported';
          consent?: boolean;
          consentVersion?: string;
          station?: string;
        }>(req);
        if (Array.isArray(body.samples) && body.samples.length > 0) {
          // N-sample ceremony (FR-14) — samples are capture-endpoint outputs
          const result = await svc.enrollWithSamples({
            userId: String(body.userId ?? ''),
            finger: Number(body.finger),
            consent: body.consent === true,
            samples: body.samples.map((s) => Buffer.from(String(s), 'base64')),
            consentVersion: body.consentVersion,
            station: body.station,
            quality: body.quality,
            source: body.source,
          });
          return await this.json(res, { ok: true, ...result });
        }
        const template = body.templateB64 ? Buffer.from(body.templateB64, 'base64') : Buffer.alloc(0);
        const result = await svc.enroll({
          userId: String(body.userId ?? ''),
          finger: Number(body.finger),
          template,
          consent: body.consent === true,
          consentVersion: body.consentVersion,
          station: body.station,
          quality: body.quality,
          source: body.source,
        });
        return await this.json(res, { ok: true, ...result });
      }
      if (pathname === '/api/biometric/identify' && req.method === 'POST') {
        const body = await readJson<{ templateB64?: string }>(req);
        const template = body.templateB64 ? Buffer.from(body.templateB64, 'base64') : Buffer.alloc(0);
        return await this.json(res, await svc.identify(template));
      }
      if (pathname === '/api/biometric/verify' && req.method === 'POST') {
        const body = await readJson<{ userId?: string; finger?: number; templateB64?: string }>(req);
        const template = body.templateB64 ? Buffer.from(body.templateB64, 'base64') : Buffer.alloc(0);
        return await this.json(res, await svc.verify(String(body.userId ?? ''), Number(body.finger), template));
      }
      if (pathname === '/api/biometric/remove' && req.method === 'POST') {
        const body = await readJson<{ userId?: string; finger?: number }>(req);
        const removed = await svc.removeEnrollment(String(body.userId ?? ''), Number(body.finger));
        return await this.json(res, { ok: removed });
      }
      if (pathname === '/api/biometric/purge' && req.method === 'POST') {
        const body = await readJson<{ confirm?: boolean }>(req);
        if (body.confirm !== true) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'purge requires { confirm: true }' }));
          return;
        }
        return await this.json(res, { ok: true, purged: await svc.purge() });
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
      if (err instanceof BiometricServiceError) {
        res.writeHead(err.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      if (err instanceof MatcherUnavailableError) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'matcher sidecar unavailable' }));
        return;
      }
      this.deps.logger.warn('biometric http error', { path: pathname, err: String(err) });
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
    }
  }

  private stateBody(): Record<string, unknown> {
    const identity = this.deps.device.getIdentity();
    return {
      enabled: this.deps.device.isEnabled(),
      deviceName: identity.name,
      serial: identity.serial,
      deviceTime: this.deps.device.now().toISOString(),
      lcd: this.deps.device.getLcdLines(),
    };
  }

  private async counts(): Promise<{ users: number; attendance: number; templates: number }> {
    const c = await this.deps.store.counts();
    return { users: c.users, attendance: c.attendance, templates: c.templates };
  }

  private async json(res: http.ServerResponse, body: unknown, status = 200): Promise<void> {
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'referrer-policy': 'strict-origin-when-cross-origin',
    });
    res.end(JSON.stringify(body, null, 2));
  }

  private async serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const file = path.normalize(path.join(WEB_DIR, rel));
    if (!file.startsWith(WEB_DIR)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await readFile(file);
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8'
        : file.endsWith('.css') ? 'text/css; charset=utf-8'
        : file.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  }

  // ----------------------------------------------------------- websocket

  private onConnection(ws: WebSocket): void {
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string } & PunchBody;
        if (msg.type === 'punch') void this.punchFromWs(msg);
        // 'subscribe' and anything else: the snapshot was already pushed on connect
      } catch {
        /* ignore malformed frames — the UI must never be able to crash the device */
      }
    });
    ws.on('error', () => undefined);
    void (async () => {
      this.send(ws, { type: 'state', state: { ...this.stateBody(), counts: await this.counts() } });
      await this.pushUsers(ws);
    })();
  }

  /** Attendance write + fan-out shared by the WS trigger and the biometric punch path. */
  private async recordPunch(
    user: { uid: number; userId: string; name: string; role: number; card: number; password: string },
    opts: { verifyType: number; state: number },
  ): Promise<AttendanceRecord> {
    const at = this.deps.device.now();
    const record = await this.deps.store.addAttendance({
      userSn: user.uid,
      deviceUserId: user.userId,
      verifyType: opts.verifyType,
      state: opts.state,
      time: at,
    });
    this.deps.bus.emit('attendance', record);
    this.deps.bus.emit('punch', record);
    this.deps.bus.emit('verify', { result: 'pass', user, userId: user.userId, verifyType: opts.verifyType, at });
    return record;
  }

  private async punchFromWs(msg: PunchBody): Promise<void> {
    const userId = String(msg.userId ?? '');
    const user = await this.deps.store.getUserByUserId(userId);
    const at = this.deps.device.now();
    if (!this.deps.device.isEnabled() || !user || msg.forceFail) {
      this.deps.bus.emit('verify', { result: 'fail', userId, verifyType: msg.verifyType ?? 1, at });
      return;
    }
    const record = await this.deps.store.addAttendance({
      userSn: user.uid,
      deviceUserId: user.userId,
      verifyType: msg.verifyType ?? 1,
      state: msg.state ?? 0,
      time: at,
    });
    this.deps.bus.emit('attendance', record);
    this.deps.bus.emit('punch', record);
    this.deps.bus.emit('verify', { result: 'pass', user, userId: user.userId, verifyType: msg.verifyType ?? 1, at });
  }

  private async pushUsers(target?: WebSocket): Promise<void> {
    const users = await this.deps.store.getUsers();
    const counts = await this.counts();
    const message = {
      type: 'users',
      users: users.map((u) => ({ uid: u.uid, userId: u.userId, name: u.name, role: u.role })),
      counts,
    };
    if (target) this.send(target, message);
    else this.broadcast(message);
  }

  private send(ws: WebSocket, message: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  private broadcast(message: unknown): void {
    for (const client of this.wss.clients) this.send(client, message);
  }
}

function serializeState(e: { enabled: boolean; deviceName: string; deviceTime: Date }): Record<string, unknown> {
  return { enabled: e.enabled, deviceName: e.deviceName, deviceTime: e.deviceTime.toISOString() };
}

function serializeRecord(rec: AttendanceRecord): Record<string, unknown> {
  return {
    userSn: rec.userSn,
    deviceUserId: rec.deviceUserId,
    verifyType: rec.verifyType,
    state: rec.state,
    time: rec.time.toISOString(),
  };
}

async function readJson<T>(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      throw new Error('Payload Too Large: exceeded 64KB ceiling');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('Malformed JSON payload');
  }
}

async function readRaw(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
