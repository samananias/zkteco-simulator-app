// Enroll station (Phase 7, FR-16.1) — camera → quality gate → N-sample ceremony.
// The page holds the ceremony state; the server stays stateless and never stores images.
const $ = (id) => document.getElementById(id);
const REASONS = {
  'too-dark': 'Too dark — add more light on the finger',
  'too-blurry': 'Too blurry — hold still and let the camera focus',
  'partial-finger': 'Not enough finger visible — place it fully on the surface',
  'unreadable': 'Frame unreadable — try again',
};

let samples = [];
let scores = [];
let needed = 3;
let stream = null;
let busy = false;
// the statement text comes from the server, never hard-coded here: the page and
// the consent record must point at the same wording (Phase 8)
let consentVersion = null;
// multi-station attribution (?station=camera-2); unset falls back to ZK_STATION_ID
const STATION = new URLSearchParams(location.search).get('station') ?? '';

const setVerdict = (text, cls) => { const v = $('verdict'); v.textContent = text; v.className = `verdict ${cls ?? ''}`; };

async function boot() {
  const users = await (await fetch('/api/users')).json();
  const sel = $('user');
  for (const u of users.users ?? []) {
    const o = document.createElement('option');
    o.value = u.userId;
    o.textContent = `${u.name} (${u.userId})`;
    sel.appendChild(o);
  }
  try {
    const statement = await (await fetch('/api/biometric/consent')).json();
    consentVersion = statement.version;
    $('consent-text').textContent = statement.text;
    $('consent-version').textContent = `statement ${statement.version} · purpose: ${statement.purpose}${STATION ? ` · station ${STATION}` : ''}`;
  } catch {
    // no statement ⇒ no consent ⇒ no enrollment (ADR-011 §4)
    $('consent-text').textContent = 'Consent statement unavailable — enrollment is disabled until it can be shown.';
  }
  try {
    const status = await (await fetch('/api/biometric/status')).json();
    needed = status.captureSamples ?? 3;
    $('progress').textContent = `Sample 0 of ${needed}`;
  } catch { /* biometrics disabled — start button will surface the 503 */ }
  $('consent').addEventListener('change', () => { $('start').disabled = !($('consent').checked && consentVersion); });
  $('start').addEventListener('click', startCapture);
  $('shoot').addEventListener('click', () => { if (!busy) void capture(); });
}

async function startCapture() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    $('video').srcObject = stream;
    $('setup').hidden = true;
    $('capture').hidden = false;
    setVerdict('Place the finger fully on a plain white surface', '');
  } catch {
    $('setup').hidden = true;
    $('nocam').hidden = false;
  }
}

function grabFrame() {
  return new Promise((resolve, reject) => {
    const video = $('video');
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    if (!ctx || !video.videoWidth) return reject(new Error('camera not ready'));
    // cover-fit the video into the frame, mirrored like the preview
    const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
    const w = video.videoWidth * scale, h = video.videoHeight * scale;
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    ctx.restore();
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('frame encode failed'))), 'image/jpeg', 0.92);
  });
}

async function capture() {
  busy = true;
  setVerdict('capturing…', '');
  try {
    const blob = await grabFrame();
    const res = await fetch('/api/biometric/capture', { method: 'POST', body: blob, headers: { 'content-type': 'image/jpeg' } });
    const j = await res.json();
    if (!res.ok) {
      setVerdict(`✗ ${REASONS[j.reason] ?? j.reason ?? j.error ?? 'rejected — try again'}`, 'bad');
      return;
    }
    samples.push(j.templateB64);
    scores.push(j.score ?? 0);
    $('progress').textContent = `Sample ${samples.length} of ${needed}`;
    setVerdict(`✓ sample accepted (quality ${j.score})`, 'good');
    if (samples.length >= needed) await commit();
  } catch (err) {
    setVerdict(`✗ ${err.message}`, 'bad');
  } finally {
    busy = false;
  }
}

async function commit() {
  setVerdict('checking consistency…', '');
  const res = await fetch('/api/biometric/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userId: $('user').value,
      finger: Number($('finger').value),
      consent: true,
      consentVersion,
      samples,
      quality: Math.min(...scores),
      source: 'camera',
      ...(STATION ? { station: STATION } : {}),
    }),
  });
  const j = await res.json();
  if (!res.ok) {
    setVerdict(`✗ ${j.error ?? 'enrollment failed'}`, 'bad');
    return;
  }
  stop();
  $('capture').hidden = true;
  $('done').hidden = false;
  $('done-name').textContent = ($('user').selectedOptions[0]?.textContent ?? $('user').value);
  $('done-detail').textContent = `finger ${j.finger} · ${j.samples} consistent samples`;
}

function stop() {
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null;
}

boot();
