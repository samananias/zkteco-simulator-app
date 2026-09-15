/**
 * HTTP + WebSocket layer (Phases 3–4).
 *
 * REST surface per docs/simulator-docs/architecture/api-and-events.md §1 and the
 * WS messages of web-ui.md §3. The store never learns about sockets — this layer
 * subscribes to the EventBus and adapts domain events to JSON fan-out.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Store } from '../store/types.js';
import type { DeviceState } from './device.js';
import type { EventBus } from './events.js';
import type { AttendanceRecord } from '../protocol/records.js';

export interface HttpOptions {
  config: Config;
  store: Store;
  device: DeviceState;
  bus: EventBus;
  logger: Logger;
  /** restore the seed state (POST /api/reset) */
  reset(): Promise<void>;
}

interface PunchBody {
  userId?: string | number;
  verifyType?: number;
  state?: number;
  forceFail?: boolean;
}

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

export class HttpServer {
  private readonly server = http.createServer((req, res) => void this.route(req, res));
  private readonly wss = new WebSocketServer({ noServer: true });
  private listening = false;

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
    try {
      if (url.pathname === '/api/device/state' && req.method === 'GET') {
        return await this.json(res, { ...this.stateBody(), counts: await this.counts() });
      }
      if (url.pathname === '/api/users' && req.method === 'GET') {
        return await this.json(res, { users: await this.deps.store.getUsers() });
      }
      if (url.pathname === '/api/attendance' && req.method === 'GET') {
        const records = await this.deps.store.getAttendance();
        const desc = [...records].sort((a, b) => b.time.getTime() - a.time.getTime());
        return await this.json(res, { attendance: desc.map(serializeRecord) });
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
      if (url.pathname === '/api/reset' && req.method === 'POST') {
        await this.deps.reset();
        return await this.json(res, { ok: true });
      }
      if (req.method === 'GET') return await this.serveStatic(res, url.pathname);
      res.writeHead(405).end();
    } catch (err) {
      this.deps.logger.warn('http error', { path: url.pathname, err: String(err) });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  }

  private async punch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJson<PunchBody>(req);
    const userId = String(body.userId ?? '');
    const verifyType = body.verifyType ?? 1;
    const state = body.state ?? 0;
    const at = this.deps.device.now();

    if (!this.deps.device.isEnabled()) {
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

  private async json(res: http.ServerResponse, body: unknown): Promise<void> {
    res.writeHead(200, { 'content-type': 'application/json' });
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

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return (raw ? JSON.parse(raw) : {}) as T;
}
