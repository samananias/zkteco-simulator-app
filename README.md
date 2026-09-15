# ZKTeco Simulator App

A software simulator of a ZKTeco standalone biometric attendance terminal. It speaks the same binary protocol a real device speaks on **TCP port 4370**, so an existing attendance backend (Node.js + `node-zklib`) connects to it **with zero code changes** — and it renders a bezel-framed web UI that looks and behaves like the physical device for demos.

> **Status: Phases 1–5 IMPLEMENTED and gate-tested (2026-09-15).** The full protocol core, data
> layer, realtime events, device-face UI and persistence are working; the pinned oracle suite
> (real `node-zklib` + the BITS driver's call patterns) passes 25/25. The plan, protocol research,
> feasibility analysis and architecture live in the companion documentation repository:
> **[samananias/zkteco-simulator-docs](https://github.com/samananias/zkteco-simulator-docs)**
> (start at `simulator-docs/README.md`).
>
> **Planned scope extension (Phases 6–8):** real fingerprint enrollment and matching — camera
> capture first (zero hardware), USB-OTG scanner later — with the ZK protocol surface frozen so
> the backend and base demo never depend on it. Two items are permanently out of scope, with
> reasons documented: phone built-in/in-display sensor capture (platform isolation) and template
> interop with real ZKTeco firmware (proprietary formats).

## Why a simulator?

We built an attendance/HR system that talks to a physical ZKTeco terminal over the network. Without the hardware, the system can't be demonstrated — so we reimplemented the device's wire protocol from the packet format up, byte-for-byte, well enough that our production backend can't tell the difference. That's the project: protocol-level engineering, plus a visual device replica for the demo.

**Honest scope:** in v1 no real biometric capture happens — a "scan" is a triggered event that produces exactly the data a real scan would. Everything else (session handshake, command handling, record layouts, realtime events) is protocol-faithful. **From Phase 6 the punch becomes genuinely matched** (real ISO 19794-2 templates + an out-of-process matcher), while the wire protocol stays byte-identical; what still never happens is parity with a capacitive sensor or template interop with ZKTeco firmware — see the docs repo's `status/known-limitations.md`.

## Layout (as implemented)

```text
src/
├── index.ts              CLI entry (npm run dev / npm start)
├── server.ts             composition root: store + device + bus + engine + http
├── config.ts             env/CLI configuration (12-factor, fail-fast)
├── logger.ts             leveled app log + redacting packet log (ADR-011)
├── protocol/             codes, frame codec (TCP prefix + frame), checksum (2 variants),
│                         record codecs (user 72 B / attendance 40 B / event 32 B), 372-day time codec
├── store/                Store contract: memory (default) + sqlite (node:sqlite), seed profiles,
│                         biometric-store seam (Phase 6)
├── core/                 protocol engine (TCP :4370), device state, event bus, HTTP+WS layer
├── web/                  device-face UI (vanilla HTML/CSS/JS — ADR-007)
test/
├── unit/                 golden-byte tests (checksum reference implemented independently)
└── integration/          pinned node-zklib oracle + sqlite gate
scripts/punch.mjs         demo punch CLI
```

## Validation oracle (pinned)

`node-zklib@1.3.0` — the exact npm artifact used by the BITS backend (`C:/bits/backend`), driven the way its `src/shared/lib/zk-driver.ts` drives it (TCP-only, no comm key, ~30 s attendance polling). Every protocol feature must pass against this client before it counts as done. Details: `docs/simulator-docs/research/client-libraries.md`.

## Quick start

```bash
npm install
npm run dev     # device protocol on :4370, web UI on :3000 (zero configuration)
npm test        # 11 golden-byte unit tests + 14 oracle integration tests (25 total)
```

Point the backend at it with `ZK_HOST=127.0.0.1` (or the LAN IP) — no backend changes.
Open the web UI for the device face; press **SCAN** (or `POST /api/punch {"userId":"1001"}`)
and watch the punch appear on the screen, over the realtime event stream, and in the
backend's next attendance poll.

## Documentation

All "how and why" knowledge lives in the separate documentation repository
**[samananias/zkteco-simulator-docs](https://github.com/samananias/zkteco-simulator-docs)**:
requirements → research → architecture → decisions → plans → operations → status.
This README intentionally stays thin; do not copy documentation here.

## License

MIT — see `LICENSE`.
