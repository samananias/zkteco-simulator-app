/**
 * Event bus (Phase 3/4). The protocol engine, REST layer and WebSocket UI all
 * meet here — this is how a punch becomes visible on the "device face"
 * (docs/simulator-docs/architecture/api-and-events.md).
 */
import { EventEmitter } from 'node:events';
import type { AttendanceRecord, UserRecord } from '../protocol/records.js';

export interface VerifyEvent {
  result: 'pass' | 'fail';
  user?: UserRecord;
  userId: string;
  verifyType: number;
  at: Date;
}

export interface LcdEvent {
  lines: string[];
}

export interface DeviceStateEvent {
  enabled: boolean;
  deviceName: string;
  deviceTime: Date;
}

export interface StoreChangedEvent {
  reason: 'user-write' | 'user-delete' | 'clear-attlog' | 'clear-data' | 'option-write';
}

export interface SimulatorEvents {
  punch: [AttendanceRecord];
  attendance: [AttendanceRecord];
  verify: [VerifyEvent];
  users: [StoreChangedEvent];
  lcd: [LcdEvent];
  state: [DeviceStateEvent];
  template: [{ uid: number; finger: number; action: 'write' | 'delete' }];
}

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  on<K extends keyof SimulatorEvents>(
    event: K,
    listener: (...args: SimulatorEvents[K]) => void,
  ): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof SimulatorEvents>(
    event: K,
    listener: (...args: SimulatorEvents[K]) => void,
  ): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof SimulatorEvents>(event: K, ...args: SimulatorEvents[K]): void {
    this.emitter.emit(event, ...args);
  }
}
