# Matcher sidecar (ADR-010)

Out-of-process fingerprint matcher for the biometric substitute (Phases 6+): SourceAFIS 3.18
behind a tiny localhost HTTP API, so a JVM crash can never take the protocol engine down and a
future engine can replace it without touching device logic. **Optional at boot** — the
simulator serves BITS perfectly with the sidecar absent (biometric endpoints then report 503,
NFR-12).

## Run

```text
java -cp "sidecar/lib/*" sidecar/MatcherSidecar.java [port]    # default port 28090
```

Requires JDK 17+ (single-file source launcher — no build step; it compiles in memory on
start, ~4 s cold). Wire it into the app with `ZK_MATCHER_URL=http://127.0.0.1:28090`.

## Contract

| Method & path | Purpose |
|---|---|
| `GET /health` | liveness + enrolled-candidate count |
| `POST /extract?dpi=500` | raw image body → ISO 19794-2 template (base64 JSON) |
| `GET /synthetic?seed=N&rot=&jitter=&drop=` | deterministic synthetic ISO template fixture (NFR-07 — synthetic minutiae, never real) |
| `POST /templates?uid&finger&kind=template\|image` | enroll/replace a candidate template |
| `POST /identify?kind=&top=` | probe body → ranked candidates `[{uid,finger,score}]` |
| `POST /verify?uid&finger&kind=` | probe body → 1:1 score against one candidate |
| `POST /match` | two length-prefixed templates (u32 LE each) → consistency score |
| `DELETE /templates` | clear all candidates (the app's purge flow, ADR-011 §5) |
| `DELETE /templates/{uid}/{finger}` | remove one candidate |

Template bytes cross the boundary as **ISO 19794-2** only (`FingerprintCompatibility` at the
edge; SourceAFIS native format stays internal). Errors are
`{"ok":false,"error":"…"}` with sanitized messages — no template bytes ever appear in
errors or logs (ADR-011).

## Vendored libraries (`lib/`)

Pinned, unmodified Maven Central artifacts, kept in-repo so the biometric demo runs offline:
`sourceafis-3.18.0` (Apache-2.0), `fingerprintio-1.3.0`, `noexception-1.9.0`,
`fastutil-8.5.6`, `slf4j-api/simple-2.0.13`, `jackson-*` 2.17.2, `commons-io-2.11.0`,
`gson-2.10.1`, `stagean-1.3.0`, `closeablescope-1.0.0`. If cloning without `lib/`, fetch the
listed artifacts from Maven Central into `sidecar/lib/`.
