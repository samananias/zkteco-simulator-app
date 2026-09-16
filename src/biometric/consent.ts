/**
 * Consent ledger (Phase 8, ADR-011 §4 / NFR-10).
 *
 * One JSON file per employee under `<biometricDataDir>/consent/`. A consent
 * record holds **no biometric data** — who consented, to which statement version
 * (hash-linked to the text they read), when, from which station, and whether it
 * was later withdrawn. Plaintext is deliberate: an accountability record must
 * stay readable even if the encryption key is lost, while the template
 * ciphertext is exactly the part that must not be.
 *
 * The encrypted store only recognizes `.bio` files, so both live in the same
 * data directory without interfering; `purge` is the one operation that deletes
 * both.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BiometricSource } from '../store/biometric-store.js';

export interface ConsentRecord {
  userId: string;
  uid: number;
  statementVersion: string;
  statementHash: string;
  purpose: string;
  /** which station collected it (`camera`, `imported`, …) — capture-stations.md */
  method: BiometricSource;
  /** station identity (`ZK_STATION_ID`) — multi-station attribution */
  station: string;
  /** when consent was given (ISO 8601) */
  at: string;
  /** set when the employee withdrew consent; templates are deleted by then */
  withdrawnAt?: string;
  withdrawReason?: string;
}

const SUFFIX = '.consent.json';

export class ConsentLedger {
  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /**
   * Keeps a hostile `userId` from escaping the directory (it is employee-supplied).
   * The dot is excluded too, so a name can never even *look* like `..` traversal.
   */
  private fileFor(userId: string): string {
    return path.join(this.dir, `${userId.replace(/[^A-Za-z0-9_-]/g, '_')}${SUFFIX}`);
  }

  /** Write-then-rename so a crash can never leave a half-written record. */
  private async write(record: ConsentRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true }); // defensive — init() normally did this
    const file = this.fileFor(record.userId);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
    await rename(tmp, file);
  }

  async put(record: ConsentRecord): Promise<void> {
    await this.write(record);
  }

  async get(userId: string): Promise<ConsentRecord | undefined> {
    try {
      const raw = await readFile(this.fileFor(userId), 'utf8');
      return JSON.parse(raw) as ConsentRecord;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<ConsentRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: ConsentRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(SUFFIX)) continue; // ignore .tmp and anything foreign
      try {
        out.push(JSON.parse(await readFile(path.join(this.dir, name), 'utf8')) as ConsentRecord);
      } catch {
        /* unreadable record is skipped, never deleted */
      }
    }
    return out.sort((a, b) => a.userId.localeCompare(b.userId));
  }

  /** Marks the consent withdrawn (ADR-011 §5). Returns the updated record, if any. */
  async withdraw(userId: string, reason: string, at: Date = new Date()): Promise<ConsentRecord | undefined> {
    const record = await this.get(userId);
    if (!record) return undefined;
    const updated: ConsentRecord = { ...record, withdrawnAt: at.toISOString(), withdrawReason: reason };
    await this.write(updated);
    return updated;
  }

  /** Full wipe — consent records are part of "purge leaves nothing behind". */
  async purge(): Promise<number> {
    const records = await this.list();
    for (const r of records) await rm(this.fileFor(r.userId), { force: true });
    return records.length;
  }
}
