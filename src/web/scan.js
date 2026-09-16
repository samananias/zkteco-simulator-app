// Scan station (Phase 7, FR-16.1/FR-15) — capture → quality gate → identify → punch.
// A pass goes through the same event bus as every other punch: the device face and
// BITS both see it (verifyType=1, genuinely earned).
const $ = (id) => document.getElementById(id);
const REASONS = {
  'too-dark': 'Too dark — add more light',
  'too-blurry': 'Too blurry — hold still',
  'partial-finger': 'Place the finger fully on the surface',
  'unreadable': 'Frame unreadable — try again',
};

let stream = null;
let busy = false;
// multi-station attribution (?station=scan-2); unset falls back to ZK_STATION_ID
const STATION = new URLSearchParams(location.search).get('station') ?? '';

const setVerdict = (text, cls) => { const v = $('verdict'); v.textContent = text; v.className = `verdict ${cls ?? ''}`; };

async function boot() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    $('video').srcObject = stream;
  } catch {
    setVerdict('camera unavailable — allow access or use the trigger punch on the device face', 'bad');
    $('shoot').disabled = true;
  }
  $('shoot').addEventListener('click', () => { if (!busy) void punch(); });
}

function grabFrame() {
  return new Promise((resolve, reject) => {
    const video = $('video');
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    if (!ctx || !video.videoWidth) return reject(new Error('camera not ready'));
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

async function punch() {
  busy = true;
  setVerdict('scanning…', '');
  try {
    const blob = await grabFrame();
    const cap = await fetch('/api/biometric/capture', { method: 'POST', body: blob, headers: { 'content-type': 'image/jpeg' } });
    const capJson = await cap.json();
    if (!cap.ok) {
      setVerdict(`✗ ${REASONS[capJson.reason] ?? capJson.reason ?? capJson.error ?? 'rejected'}`, 'bad');
      return;
    }
    setVerdict('identifying…', '');
    const res = await fetch('/api/biometric/punch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateB64: capJson.templateB64, ...(STATION ? { station: STATION } : {}) }),
    });
    const j = await res.json();
    if (res.status === 503) {
      showFail('Service unavailable', 'matcher offline — try again shortly');
      return;
    }
    if (j.result === 'pass') {
      $('idle').hidden = true;
      $('verify-pass').hidden = false;
      $('pass-name').textContent = j.name ?? j.record?.deviceUserId ?? '—';
      $('pass-detail').textContent = `matched (score ${Number(j.score).toFixed(1)})`;
      setTimeout(reset, 2200);
    } else {
      const label = j.decision === 'ambiguous' ? 'Ambiguous — present the finger again' : 'Not recognized';
      showFail(label, j.reason ?? '');
      setTimeout(reset, 2200);
    }
  } catch (err) {
    setVerdict(`✗ ${err.message}`, 'bad');
  } finally {
    busy = false;
  }
}

function showFail(who, msg) {
  $('idle').hidden = true;
  $('verify-fail').hidden = false;
  $('fail-who').textContent = who;
  $('fail-msg').textContent = msg || 'Please try again';
}

function reset() {
  $('verify-pass').hidden = true;
  $('verify-fail').hidden = true;
  $('idle').hidden = false;
  setVerdict('', '');
}

boot();
