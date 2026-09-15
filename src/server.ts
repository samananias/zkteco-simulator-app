/**
 * Composition root (ADR-001) — wires store + device + bus + engine + HTTP and
 * exposes a handle for graceful shutdown. Kept separate from `index.ts` so the
 * integration tests can boot the whole simulator in-process.
 */

import { loadConfig, type Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { MemoryStore } from './store/memory.js';
import { SqliteStore } from './store/sqlite.js';
import { seedStore, type SeedProfile } from './store/seed.js';
import { DEFAULT_OPTIONS } from './store/types.js';
import type { Store } from './store/types.js';
import { EventBus } from './core/events.js';
import { DeviceState } from './core/device.js';
import { ProtocolEngine } from './core/engine.js';
import { HttpServer } from './core/http.js';

export interface SimulatorHandle {
  stop(): Promise<void>;
  tcpPort: number;
  httpPort: number;
}

function createStore(config: Config): Store {
  return config.store === 'sqlite' ? new SqliteStore(config.sqlitePath) : new MemoryStore();
}

export async function startSimulator(config: Config, logger: Logger = createLogger(config.logLevel)): Promise<SimulatorHandle> {
  const bus = new EventBus();
  const store = createStore(config);
  await store.init();

  // device options (~DeviceName & co) — required by CMD_OPTIONS_RRQ
  for (const [key, value] of Object.entries(DEFAULT_OPTIONS)) {
    if ((await store.getOption(key)) === undefined) await store.setOption(key, String(value));
  }

  const device = new DeviceState(
    {
      name: config.deviceName,
      serial: config.serial,
      platform: 'ZEM560_TFT',
      fpVersion: '10',
      osVersion: '9.0.1',
    },
    config.timeOffsetMin,
    bus,
  );

  if (config.seed === 'standard') {
    const seeded = await seedStore(store, 'standard' as SeedProfile, device.now());
    logger.info('seed loaded', seeded);
  }

  const engine = new ProtocolEngine({ config, store, device, bus, logger });
  await engine.start();

  const http = new HttpServer({
    config,
    store,
    device,
    bus,
    logger,
    reset: async () => {
      await store.clearAttendance();
      for (const t of await store.getTemplates()) await store.deleteTemplate(t.uid, t.finger);
      for (const u of await store.getUsers()) await store.deleteUser(u.uid);
      if (config.seed === 'standard') await seedStore(store, 'standard' as SeedProfile, device.now());
      bus.emit('users', { reason: 'clear-data' });
      device.publishState();
      logger.info('state reset to seed');
    },
  });
  await http.start();

  return {
    tcpPort: engine.tcpPort,
    httpPort: http.port,
    stop: async () => {
      await http.stop();
      await engine.stop();
      await store.close();
    },
  };
}

/** CLI entry — parse args/env, boot, wait for SIGINT/SIGTERM. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(argv);
  } catch (err) {
    console.error(`configuration error: ${String(err)}`);
    process.exitCode = 2;
    return;
  }
  const logger = createLogger(config.logLevel);
  const sim = await startSimulator(config, logger);
  logger.info('simulator ready', {
    tcp: sim.tcpPort,
    http: sim.httpPort,
    ui: `http://localhost:${sim.httpPort}/`,
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { signal });
    await sim.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
