/**
 * Matcher sidecar client (ADR-010) — thin HTTP wrapper around the SourceAFIS
 * sidecar (`sidecar/MatcherSidecar.java`). All template payloads cross as
 * ISO 19794-2 bytes; errors are sanitized by the sidecar so no template bytes
 * can leak through here (ADR-011 §3).
 */

import type { Logger } from '../logger.js';

export class MatcherUnavailableError extends Error {
  constructor(message = 'matcher sidecar unreachable') {
    super(message);
    this.name = 'MatcherUnavailableError';
  }
}

export class MatcherError extends Error {}

export interface MatchCandidate {
  uid: number;
  finger: number;
  score: number;
}

export interface MatcherHealth {
  ok: boolean;
  engine: string;
  templates: number;
}

/** Extract timeouts must tolerate a cold JVM (~6 s JIT warmup on first extract). */
const EXTRACT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 5_000;

export class MatcherClient {
  constructor(
    private readonly baseUrl: string,
    private readonly logger: Logger,
  ) {}

  private async call(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const { timeoutMs = CALL_TIMEOUT_MS, ...rest } = init;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new MatcherUnavailableError(`${this.baseUrl}: ${String(err)}`);
    }
    if (!res.ok) {
      let error = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) error = body.error;
      } catch {
        /* keep the status-line error */
      }
      throw new MatcherError(error);
    }
    return res;
  }

  private async json<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const res = await this.call(path, init);
    return (await res.json()) as T;
  }

  async health(): Promise<MatcherHealth | null> {
    try {
      return await this.json<MatcherHealth>('/health', { method: 'GET', timeoutMs: 3_000 });
    } catch {
      return null;
    }
  }

  /** Raw fingerprint image → ISO 19794-2 template (capture-normalization entry, ADR-009). */
  async extractImage(image: Buffer, dpi = 500): Promise<Buffer> {
    const out = await this.json<{ templateB64: string }>(
      `/extract?dpi=${dpi}`,
      { method: 'POST', body: image, headers: { 'content-type': 'application/octet-stream' }, timeoutMs: EXTRACT_TIMEOUT_MS },
    );
    return Buffer.from(out.templateB64, 'base64');
  }

  async enrollTemplate(uid: number, finger: number, template: Buffer): Promise<void> {
    await this.json(
      `/templates?uid=${uid}&finger=${finger}&kind=template`,
      { method: 'POST', body: template, headers: { 'content-type': 'application/octet-stream' } },
    );
  }

  async identifyTemplate(template: Buffer, top = 5): Promise<MatchCandidate[]> {
    const out = await this.json<{ candidates?: MatchCandidate[] }>(
      `/identify?kind=template&top=${top}`,
      { method: 'POST', body: template, headers: { 'content-type': 'application/octet-stream' } },
    );
    return out.candidates ?? [];
  }

  /** 1:1 score, or undefined when the (uid, finger) slot has no candidate enrolled. */
  async verifyTemplate(uid: number, finger: number, template: Buffer): Promise<number | undefined> {
    const res = await fetch(
      `${this.baseUrl}/verify?uid=${uid}&finger=${finger}&kind=template`,
      { method: 'POST', body: template, headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
    ).catch(() => { throw new MatcherUnavailableError(); });
    if (res.status === 404) return undefined; // no-template
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new MatcherError(body.error ?? `HTTP ${res.status}`);
    }
    const out = (await res.json()) as { score?: number };
    return out.score;
  }

  async removeTemplate(uid: number, finger: number): Promise<void> {
    await this.json(`/templates/${uid}/${finger}`, { method: 'DELETE' });
  }

  async clearAll(): Promise<void> {
    await this.json('/templates', { method: 'DELETE' });
  }

  /** Deterministic synthetic ISO template fixture (NFR-07 — synthetic minutiae, never real). */
  async syntheticTemplate(seed: number, rot = 0, jitter = 0, drop = 0): Promise<Buffer> {
    const out = await this.json<{ templateB64: string }>(
      `/synthetic?seed=${seed}&rot=${rot}&jitter=${jitter}&drop=${drop}`,
      { method: 'GET' },
    );
    return Buffer.from(out.templateB64, 'base64');
  }

  get url(): string {
    return this.baseUrl;
  }

  /** debug-only helper — never log templates through it */
  log(l: 'info' | 'debug', message: string, fields?: Record<string, unknown>): void {
    this.logger[l](message, fields);
  }
}
