/**
 * Encrypted biometric store (Phase 6, ADR-011) — file-backed AES-256-GCM.
 *
 * One ciphertext file per (uid, finger) under the configured data dir
 * (`ZK_BIOMETRIC_DATA`, default ./data/biometric). The plaintext envelope is a
 * JSON record (metadata + base64 template) so listing can surface metadata
 * without ever writing plaintext to disk. Only `.bio` files are recognized;
 * unknown files are ignored, never deleted.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BiometricKey } from './crypto.js';
import { decrypt, encrypt } from './crypto.js';
import type { BiometricRecord, BiometricStore } from '../store/biometric-store.js';

interface Envelope {
  uid: number;
  finger: number;
  userId: string;
  format: BiometricRecord['format'];
  flag: number;
  quality: number;
  source: BiometricRecord['source'];
  createdAt: string;
  templateB64: string;
}

export class EncryptedBiometricStore implements BiometricStore {
  readonly kind = 'encrypted' as const;

  constructor(
    private readonly dir: string,
    private readonly key: BiometricKey,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private fileFor(uid: number, finger: number): string {
    return path.join(this.dir, `${uid}-${finger}.bio`);
  }

  private async write(record: BiometricRecord): Promise<void> {
    const envelope: Envelope = {
      uid: record.uid,
      finger: record.finger,
      userId: record.userId,
      format: record.format,
      flag: record.flag,
      quality: record.quality,
      source: record.source,
      createdAt: record.createdAt,
      templateB64: record.template.toString('base64'),
    };
    await mkdir(this.dir, { recursive: true }); // defensive — init() normally did this
    const blob = encrypt(this.key, Buffer.from(JSON.stringify(envelope), 'utf8'));
    await writeFile(this.fileFor(record.uid, record.finger), blob);
  }

  private async read(uid: number, finger: number): Promise<BiometricRecord | undefined> {
    let blob: Buffer;
    try {
      blob = await readFile(this.fileFor(uid, finger));
    } catch {
      return undefined;
    }
    const envelope = JSON.parse(decrypt(this.key, blob).toString('utf8')) as Envelope;
    return {
      uid: envelope.uid,
      finger: envelope.finger,
      userId: envelope.userId,
      format: envelope.format,
      flag: envelope.flag,
      quality: envelope.quality,
      source: envelope.source,
      createdAt: envelope.createdAt,
      template: Buffer.from(envelope.templateB64, 'base64'),
    };
  }

  async put(record: BiometricRecord): Promise<void> {
    await this.write(record);
  }

  async get(uid: number, finger: number): Promise<BiometricRecord | undefined> {
    return this.read(uid, finger);
  }

  async list(): Promise<BiometricRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: BiometricRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.bio')) continue;
      const [uidRaw, rest] = name.slice(0, -4).split('-', 2);
      const uid = Number.parseInt(uidRaw ?? '', 10);
      const finger = Number.parseInt(rest ?? '', 10);
      if (!Number.isFinite(uid) || !Number.isFinite(finger)) continue;
      const rec = await this.read(uid, finger).catch(() => undefined);
      if (rec) out.push(rec);
    }
    return out.sort((a, b) => a.uid - b.uid || a.finger - b.finger);
  }

  async remove(uid: number, finger: number): Promise<boolean> {
    const existed = await this.read(uid, finger).catch(() => undefined);
    await rm(this.fileFor(uid, finger), { force: true });
    return existed !== undefined;
  }

  async removeUser(uid: number): Promise<number> {
    const all = await this.list();
    const mine = all.filter((r) => r.uid === uid);
    for (const r of mine) await rm(this.fileFor(r.uid, r.finger), { force: true });
    return mine.length;
  }

  async purge(): Promise<number> {
    const all = await this.list();
    for (const r of all) await rm(this.fileFor(r.uid, r.finger), { force: true });
    return all.length;
  }
}
