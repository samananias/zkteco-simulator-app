// ADR-010 Phase-6 spike harness — full acceptance matrix (evidence recorded in ADR-010 + change-history).
// Probes come from the sidecar's /synthetic fixture generator: deterministic synthetic ISO
// 19794-2 minutiae (never real — NFR-07); rot/jitter/drop simulate re-presentations of the
// same finger. Self-contained: no file inputs.
const B = 'http://127.0.0.1:28090';
const get = async (path) => (await fetch(B + path, { signal: AbortSignal.timeout(30000) })).json();
const post = async (path, body) => { const t0 = performance.now(); const res = await fetch(B + path, { method: 'POST', body, signal: AbortSignal.timeout(30000) }); const j = await res.json(); return { ms: Math.round(performance.now() - t0), status: res.status, j }; };
const synth = async (seed, rot = 0, jitter = 0, drop = 0) => Buffer.from((await get(`/synthetic?seed=${seed}&rot=${rot}&jitter=${jitter}&drop=${drop}`)).templateB64, 'base64');

// enrolled population: 10 templates, 5 identities, fingers 0/1/2 (ADR-010 criterion 2)
const POP = [
  { uid: 1, finger: 0, seed: 1 }, { uid: 1, finger: 1, seed: 2 }, { uid: 1, finger: 2, seed: 3 },
  { uid: 2, finger: 0, seed: 4 }, { uid: 2, finger: 1, seed: 5 },
  { uid: 3, finger: 0, seed: 6 }, { uid: 3, finger: 1, seed: 7 },
  { uid: 4, finger: 0, seed: 8 },
  { uid: 5, finger: 0, seed: 9 }, { uid: 5, finger: 1, seed: 10 },
];
const ROTS = [5, -4, 3, -6, 2, -3, 6, -5, 4, -2];
const JIT = [2, 1, 3, 2, 1, 2, 1, 3, 2, 1];

// ---- warmup (JIT) — not measured
await post('/templates?uid=90&finger=0&kind=template', await synth(900));
await post('/identify?kind=template&top=1', await synth(901, 3, 1, 10));

// ---- enroll all 10
const t0 = performance.now();
for (const p of POP) {
  const r = await post(`/templates?uid=${p.uid}&finger=${p.finger}&kind=template`, await synth(p.seed));
  if (!r.j.ok) { console.log('ENROLL FAIL', JSON.stringify(p), JSON.stringify(r.j)); process.exit(1); }
}
console.log(`[1] enroll 10 templates (warm): ${Math.round(performance.now() - t0)}ms total, ${Math.round((performance.now() - t0) / POP.length)}ms avg/template`);
const meta = await get('/synthetic?seed=1');
console.log(`[1] synthetic template: ${meta.minutiae} minutiae, ${Buffer.from(meta.templateB64, 'base64').length} bytes (ISO 19794-2)`);

// ---- identify matrix: 10 probes, rotation ±2..6° + jitter + 10% drop-out
let pass = 0; const rows = []; const same = [], cross = [];
for (let i = 0; i < POP.length; i++) {
  const p = POP[i];
  const r = await post('/identify?kind=template&top=10', await synth(p.seed, ROTS[i], JIT[i], 10));
  const top = r.j.candidates?.[0];
  const ok = top && top.uid === p.uid;
  if (ok) pass++;
  for (const c of r.j.candidates) {
    if (c.uid === p.uid && c.finger === p.finger) same.push(c.score);
    else if (c.uid !== p.uid) cross.push(c.score);
  }
  rows.push(`uid${p.uid}f${p.finger} rot${ROTS[i] >= 0 ? '+' : ''}${ROTS[i]}° jit${JIT[i]} → ${ok ? 'PASS' : 'FAIL'} top=${top ? `uid${top.uid}@${top.score.toFixed(1)} (${r.ms}ms)` : 'none'}`);
}
console.log(`[2] identify matrix (rot + jitter + 10% drop): ${pass}/10 correct`);
for (const row of rows) console.log('    ' + row);
console.log(`[2] same-finger scores: min=${Math.min(...same).toFixed(1)} max=${Math.max(...same).toFixed(1)} n=${same.length}`);
console.log(`[2] cross-finger scores: max=${cross.length ? Math.max(...cross).toFixed(1) : 'n/a'} n=${cross.length}`);

// ---- impostor probes (seeds 98/99 not enrolled)
const imp1 = await post('/identify?kind=template&top=3', await synth(99, 3, 2, 10));
const imp2 = await post('/identify?kind=template&top=3', await synth(98, -5, 1, 10));
console.log(`[2] impostor 99 → top=${imp1.j.candidates?.[0]?.uid}@${imp1.j.candidates?.[0]?.score.toFixed(1)} | impostor 98 → top=${imp2.j.candidates?.[0]?.uid}@${imp2.j.candidates?.[0]?.score.toFixed(1)}`);

// ---- 1:1 verify
const vf = await post('/verify?uid=3&finger=0&kind=template', await synth(6, 4, 2, 10));
const vw = await post('/verify?uid=3&finger=0&kind=template', await synth(7, -3, 1, 10));
console.log(`[2] verify same(3:0): ${vf.j.score} ${vf.ms}ms | wrong-probe(7 vs 3:0): ${vw.j.score}`);

// ---- steady-state latency (5 identify calls + extract, warm)
const lat = [];
for (let i = 0; i < 5; i++) lat.push((await post('/identify?kind=template&top=3', await synth(POP[i].seed, ROTS[i], JIT[i], 10))).ms);
console.log(`[1] identify latency steady-state (10 templates): ${lat.join(', ')} ms`);

