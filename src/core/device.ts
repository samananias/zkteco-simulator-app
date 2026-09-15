/**
 * Device state: identity, clock offset, enabled flag, LCD lines.
 *
 * Device time is *not* host time: the terminal owns a 372-day clock
 * (docs/simulator-docs/research/zk-protocol-notes.md §6) and admins can set it.
 * `ZK_TIME_OFFSET_MIN` lets a demo start with a deliberately wrong clock.
 */
import type { EventBus } from './events.js';

export interface DeviceIdentity {
  name: string;
  serial: string;
  platform: string;
  fpVersion: string;
  osVersion: string;
}

export class DeviceState {
  private enabled = true;
  private timeOffsetMs: number;
  private lcdLines: string[] = [];
  private createdAt = new Date();

  constructor(
    private identity: DeviceIdentity,
    offsetMinutes: number,
    private readonly bus: EventBus,
  ) {
    this.timeOffsetMs = offsetMinutes * 60_000;
  }

  getIdentity(): DeviceIdentity {
    return { ...this.identity };
  }

  setDeviceName(name: string): void {
    this.identity.name = name;
    this.publishState();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    this.publishState();
  }

  /** Device clock = host clock + configured offset. */
  now(): Date {
    return new Date(Date.now() + this.timeOffsetMs);
  }

  getTimeOffsetMinutes(): number {
    return Math.round(this.timeOffsetMs / 60_000);
  }

  /** Sets the device clock by moving the offset (the host clock is never changed). */
  setNow(deviceTime: Date): void {
    this.timeOffsetMs = deviceTime.getTime() - Date.now();
    this.publishState();
  }

  getLcdLines(): string[] {
    return [...this.lcdLines];
  }

  setLcdLines(lines: string[]): void {
    this.lcdLines = [...lines];
    this.bus.emit('lcd', { lines: this.getLcdLines() });
  }

  clearLcd(): void {
    this.lcdLines = [];
    this.bus.emit('lcd', { lines: [] });
  }

  uptimeSeconds(): number {
    return Math.floor((Date.now() - this.createdAt.getTime()) / 1000);
  }

  publishState(): void {
    this.bus.emit('state', {
      enabled: this.enabled,
      deviceName: this.identity.name,
      deviceTime: this.now(),
    });
  }
}
