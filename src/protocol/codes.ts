/**
 * ZKTeco standalone protocol — command, event and acknowledgement codes.
 *
 * Source of truth: `node-zklib@1.3.0/constants.js` (the pinned acceptance oracle)
 * cross-checked against pyzk and the adrobinoga/zk-protocol spec.
 * See docs/simulator-docs/research/zk-protocol-notes.md §4.
 */

export const COMMANDS = {
  // reads / writes
  CMD_DB_RRQ: 7,
  CMD_USER_WRQ: 8,
  CMD_USERTEMP_RRQ: 9,
  CMD_USERTEMP_WRQ: 10,
  CMD_OPTIONS_RRQ: 11,
  CMD_OPTIONS_WRQ: 12,
  CMD_ATTLOG_RRQ: 13,
  CMD_CLEAR_DATA: 14,
  CMD_CLEAR_ATTLOG: 15,
  CMD_DELETE_USER: 18,
  CMD_DELETE_USERTEMP: 19,
  CMD_CLEAR_ADMIN: 20,
  CMD_UNLOCK: 31,
  CMD_GET_FREE_SIZES: 50,
  CMD_ENABLE_CLOCK: 57,
  CMD_STARTVERIFY: 60,
  CMD_STARTENROLL: 61,
  CMD_CANCELCAPTURE: 62,
  CMD_STATE_RRQ: 64,
  CMD_WRITE_LCD: 66,
  CMD_CLEAR_LCD: 67,
  CMD_GET_PINWIDTH: 69,
  CMD_GET_TIME: 201,
  CMD_SET_TIME: 202,
  // session / device control
  CMD_CONNECT: 1000,
  CMD_EXIT: 1001,
  CMD_ENABLEDEVICE: 1002,
  CMD_DISABLEDEVICE: 1003,
  CMD_RESTART: 1004,
  CMD_POWEROFF: 1005,
  CMD_SLEEP: 1006,
  CMD_RESUME: 1007,
  CMD_CAPTUREFINGER: 1009,
  CMD_TEST_TEMP: 1011,
  CMD_CAPTUREIMAGE: 1012,
  CMD_REFRESHDATA: 1013,
  CMD_REFRESHOPTION: 1014,
  CMD_TESTVOICE: 1017,
  CMD_GET_VERSION: 1100,
  CMD_CHANGE_SPEED: 1101,
  CMD_AUTH: 1102,
  // bulk data
  CMD_PREPARE_DATA: 1500,
  CMD_DATA: 1501,
  CMD_FREE_DATA: 1502,
  CMD_DATA_WRRQ: 1503,
  CMD_DATA_RDY: 1504,
  // fingerprint template write flow (BITS driver sequence — FR-8)
  CMD_TMP_WRITE: 87,
  CMD_CHECKSUM_BUFFER: 119,
  // realtime
  CMD_REG_EVENT: 500,
  // replies
  CMD_ACK_OK: 2000,
  CMD_ACK_ERROR: 2001,
  CMD_ACK_DATA: 2002,
  CMD_ACK_RETRY: 2003,
  CMD_ACK_REPEAT: 2004,
  CMD_ACK_UNAUTH: 2005,
  CMD_ACK_UNKNOWN: 65535,
  CMD_ACK_ERROR_CMD: 65533,
  CMD_ACK_ERROR_INIT: 65532,
  CMD_ACK_ERROR_DATA: 65531,
} as const;

export type CommandName = keyof typeof COMMANDS;

/** event flag bits (CMD_REG_EVENT payload / EF_* names) */
export const EVENTS = {
  EF_ATTLOG: 1,
  EF_FINGER: 2,
  EF_ENROLLUSER: 4,
  EF_ENROLLFINGER: 8,
  EF_BUTTON: 16,
  EF_UNLOCK: 32,
  EF_VERIFY: 128,
  EF_FPFTR: 256,
  EF_ALARM: 512,
} as const;

export const USHRT_MAX = 65535;
/** chunk size used by node-zklib's chunked reader (ADR-004) */
export const MAX_CHUNK = 65472;

/**
 * TCP packet prefix magic — every packet (both directions) is wrapped by an
 * 8-byte prefix `50 50 82 7d | frameLen u16 LE | 00 00`.
 *
 * Verified in the pinned oracle: `utils.createTCPHeader` prepends exactly these
 * bytes and `utils.removeTcpHeader` strips them only when the magic matches.
 * See docs/simulator-docs/research/zk-protocol-notes.md §3.
 */
export const TCP_PREFIX = Buffer.from([0x50, 0x50, 0x82, 0x7d]);

/**
 * Payloads the pinned oracle uses for its own data requests. The simulator
 * identifies a `CMD_DATA_WRRQ` by these exact bytes, so they must stay byte-identical.
 */
export const REQUEST_DATA = {
  DISABLE_DEVICE: Buffer.from([0, 0, 0, 0]),
  GET_REAL_TIME_EVENT: Buffer.from([0x01, 0x00, 0x00, 0x00]),
  GET_ATTENDANCE_LOGS: Buffer.from([0x01, 0x0d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  GET_USERS: Buffer.from([0x01, 0x09, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
} as const;

/** fingerprint-template request tag used inside `CMD_DATA_WRRQ` (tag 9 = user data / templates) */
export const WRRQ_TAG = {
  USERS: 0x09,
  ATTLOG: 0x0d,
  TEMPLATE: 0x05,
} as const;

export function commandName(code: number): string {
  for (const [name, value] of Object.entries(COMMANDS)) {
    if (value === code) return name;
  }
  return `UNKNOWN(0x${code.toString(16)})`;
}
