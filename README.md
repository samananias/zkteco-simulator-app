# ZKTeco Simulator App

A software simulator of a ZKTeco standalone biometric attendance terminal. It speaks the same binary protocol a real device speaks on **TCP port 4370**, so an existing attendance backend (Node.js + `node-zklib`) connects to it **with zero code changes** — and it renders a bezel-framed web UI that looks and behaves like the physical device for demos.

> **Status: Phase 0 — repository established, implementation not started.**
> The plan, protocol research, feasibility analysis and architecture live in the companion
> documentation repository: `../docs/simulator-docs/README.md`.
> Development starts at **Phase 1 (protocol core)** per `docs/simulator-docs/plan/roadmap.md`.

## Why a simulator?

We built an attendance/HR system that talks to a physical ZKTeco terminal over the network. Without the hardware, the system can't be demonstrated — so we reimplemented the device's wire protocol from the packet format up, byte-for-byte, well enough that our production backend can't tell the difference. That's the project: protocol-level engineering, plus a visual device replica for the demo.

**Honest scope:** no real biometric capture happens — a "scan" is a triggered event that produces exactly the data a real scan would. Everything else (session handshake, command handling, record layouts, realtime events) is protocol-faithful.

## Planned layout (Phase 1+)

```text
src/
├── index.ts            wiring: tcp engine + http/ws + config
├── config.ts           env/CLI configuration
├── protocol/           frame codec, checksum, session, command handlers, record codecs, time codec
├── device/             DeviceStore (in-memory | sqlite), event bus, seed data
├── transport/          net.Server TCP transport (:4370)
├── web/                static UI serving, REST API, WebSocket
public/                 device-face UI (bezel kiosk replica)
test/                   unit (golden bytes) + integration (pinned node-zklib oracle)
scripts/                demo punch CLI
```

## Validation oracle (pinned)

`node-zklib@1.3.0` — the exact npm artifact used by the BITS backend (`C:/bits/backend`), driven the way its `src/shared/lib/zk-driver.ts` drives it (TCP-only, no comm key, ~30 s attendance polling). Every protocol feature must pass against this client before it counts as done. Details: `docs/simulator-docs/research/client-libraries.md`.

## Quick start (once Phase 1 lands)

```bash
npm install
npm run dev     # device protocol on :4370, web UI on :3000
npm test        # unit + oracle integration tests
```

Point the backend at it with `ZK_HOST=127.0.0.1` (or the LAN IP) — no backend changes.

## Documentation

All "how and why" knowledge lives in the separate `docs` repository (`docs/simulator-docs/`):
requirements → research → architecture → decisions → plans → operations → status.
This README intentionally stays thin; do not copy documentation here.

## License

MIT — see `LICENSE`.
