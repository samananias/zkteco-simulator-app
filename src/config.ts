/**
 * Runtime configuration — env vars with optional CLI overrides (12-factor, ADR per
 * docs/simulator-docs/operations/configuration.md). Defaults are chosen so that
 * `npm run dev` with zero configuration runs the full demo.
 */

import type { ChecksumVariant } from './protocol/checksum.js';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
export type ReadMode = 'direct' | 'chunked';
export type SeedProfile = 'standard' | 'empty';
export type StoreKind = 'memory' | 'sqlite';

export interface Config {
  /** Protocol engine TCP port — the "device" port BITS connects to. */
  tcpPort: number;
  /** Web UI + REST + WebSocket port. */
  httpPort: number;
  httpHost: string;
  /** Comm key expected by CMD_AUTH; 0 = disabled (the BITS backend default). */
  commKey: number;
  checksumVariant: ChecksumVariant;
  checksumStrict: boolean;
  readMode: ReadMode;
  deviceName: string;
  serial: string;
  timeOffsetMin: number;
  seed: SeedProfile;
  store: StoreKind;
  sqlitePath: string;
  logLevel: LogLevel;
  /** Phase 6+ — empty disables biometric features entirely (NFR-12). */
  matcherUrl: string;
  biometricKey: string;
  biometricDataDir: string;
  matchThreshold: number | null;
  matchSeparation: number | null;
  captureSamples: number;
  qualityMinBrightness: number;
  qualityMinSharpness: number;
  qualityMinCoverage: number;
}

const DEFAULTS: Config = {
  tcpPort: 4370,
  httpPort: 3000,
  httpHost: '0.0.0.0',
  commKey: 0,
  checksumVariant: 'classic',
  checksumStrict: false,
  readMode: 'direct',
  deviceName: 'ACME HQ — Main Door',
  serial: 'CJ7X202660399',
  timeOffsetMin: 0,
  seed: 'standard',
  store: 'memory',
  sqlitePath: './data/device.sqlite',
  logLevel: 'info',
  matcherUrl: '',
  biometricKey: '',
  biometricDataDir: './data/biometric',
  matchThreshold: null,
  matchSeparation: null,
  captureSamples: 3,
  qualityMinBrightness: 60,
  qualityMinSharpness: 25,
  qualityMinCoverage: 18,
};

/** env var name -> config key */
const ENV_MAP: Record<string, keyof Config> = {
  ZK_TCP_PORT: 'tcpPort',
  ZK_HTTP_PORT: 'httpPort',
  ZK_HTTP_HOST: 'httpHost',
  ZK_COMM_KEY: 'commKey',
  ZK_CHECKSUM_VARIANT: 'checksumVariant',
  ZK_CHECKSUM_STRICT: 'checksumStrict',
  ZK_READ_MODE: 'readMode',
  ZK_DEVICE_NAME: 'deviceName',
  ZK_SERIAL: 'serial',
  ZK_TIME_OFFSET_MIN: 'timeOffsetMin',
  ZK_SEED: 'seed',
  ZK_STORE: 'store',
  ZK_SQLITE_PATH: 'sqlitePath',
  ZK_LOG_LEVEL: 'logLevel',
  ZK_MATCHER_URL: 'matcherUrl',
  ZK_BIOMETRIC_KEY: 'biometricKey',
  ZK_BIOMETRIC_DATA: 'biometricDataDir',
  ZK_MATCH_THRESHOLD: 'matchThreshold',
  ZK_MATCH_SEPARATION: 'matchSeparation',
  ZK_CAPTURE_SAMPLES: 'captureSamples',
  ZK_QUALITY_MIN_BRIGHTNESS: 'qualityMinBrightness',
  ZK_QUALITY_MIN_SHARPNESS: 'qualityMinSharpness',
  ZK_QUALITY_MIN_COVERAGE: 'qualityMinCoverage',
};

export class ConfigError extends Error {}

const INT_KEYS: ReadonlySet<keyof Config> = new Set([
  'tcpPort',
  'httpPort',
  'commKey',
  'timeOffsetMin',
  'matchThreshold',
  'matchSeparation',
  'captureSamples',
  'qualityMinBrightness',
  'qualityMinSharpness',
  'qualityMinCoverage',
]);

function coerce(key: keyof Config, raw: string): unknown {
  if (INT_KEYS.has(key)) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) throw new ConfigError(`${key}: expected an integer, received "${raw}"`);
    if (key === 'tcpPort' || key === 'httpPort') {
      if (n < 1 || n > 65535) throw new ConfigError(`${key}: port out of range 1-65535 (received ${n})`);
    }
    return n;
  }
  if (key === 'checksumStrict') {
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new ConfigError(`${key}: expected true|false, received "${raw}"`);
  }
  const enumerated: Partial<Record<keyof Config, readonly string[]>> = {
    checksumVariant: ['classic', 'oracle'],
    readMode: ['direct', 'chunked'],
    seed: ['standard', 'empty'],
    store: ['memory', 'sqlite'],
    logLevel: ['silent', 'error', 'warn', 'info', 'debug'],
  };
  const allowed = enumerated[key];
  if (allowed && !allowed.includes(raw)) {
    throw new ConfigError(`${key}: expected one of ${allowed.join(' | ')}, received "${raw}"`);
  }
  return raw;
}

/** CLI flag name (kebab) -> config key */
function flagKey(flag: string): keyof Config | null {
  const kebab = flag.replace(/^--/, '').replace(/^zk-/, '');
  const camel = kebab.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  for (const key of Object.keys(DEFAULTS) as (keyof Config)[]) {
    if (key.toLowerCase() === camel.toLowerCase()) return key;
  }
  return null;
}

export function loadConfig(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = { ...DEFAULTS };

  for (const [envName, key] of Object.entries(ENV_MAP)) {
    const raw = env[envName];
    if (raw === undefined || raw === '') continue;
    const value = coerce(key, raw) as never;
    (config as unknown as Record<string, unknown>)[key] = value;
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || !arg.startsWith('--')) continue;
    const [flag, inline] = arg.includes('=') ? (arg.split('=', 2) as [string, string]) : [arg, undefined];
    const key = flagKey(flag);
    if (!key) throw new ConfigError(`unknown flag "${flag}"`);
    const raw = inline ?? argv[i + 1];
    if (raw === undefined) throw new ConfigError(`flag "${flag}" requires a value`);
    if (inline === undefined) i += 1;
    const value = coerce(key, raw) as never;
    (config as unknown as Record<string, unknown>)[key] = value;
  }

  return config;
}
