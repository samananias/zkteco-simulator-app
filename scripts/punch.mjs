#!/usr/bin/env node
/**
 * Demo trigger without the UI: `npm run punch -- 1` or `node scripts/punch.mjs 1 1 0`.
 * args: [userId] [verifyType 0|1|2] [state 0-5]
 */

const userId = process.argv[2] ?? '1';
const verifyType = Number.parseInt(process.argv[3] ?? '1', 10);
const state = Number.parseInt(process.argv[4] ?? '0', 10);
const base = process.env.ZK_HTTP_URL ?? 'http://localhost:3030';

const res = await fetch(`${base}/api/punch`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ userId, verifyType, state }),
});
const body = await res.json().catch(() => ({}));
console.log(res.status, JSON.stringify(body, null, 2));
if (!res.ok || body.result !== 'pass') process.exitCode = 1;
