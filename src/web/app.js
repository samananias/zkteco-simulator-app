/* Device-face client (vanilla JS — ADR-007).
   Clock runs on the DEVICE time pushed by the server; punches go through the
   same WS the backend-visible events flow from, so the screen and the wire
   never disagree. */

const $ = (id) => document.getElementById(id);
const PROMPTS = ['Please place finger', 'Welcome!', '1:N Identification', 'Punch to record time'];
let digitBuffer = '';
let deviceOffsetMs = 0; // device clock minus browser clock
let deviceName = '…';
let enabled = true;
let menuOpen = false;

function log(line, cls = 'info') {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = `[${new Date().toLocaleTimeString()}] ${line}`;
  $('log').prepend(el);
  while ($('log').children.length > 60) $('log').lastChild.remove();
}

function tick() {
  const now = new Date(Date.now() + deviceOffsetMs);
  $('clock').textContent = now.toTimeString().slice(0, 8);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  $('date').textContent =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${days[now.getDay()]}`;
}

setInterval(tick, 250);

function rotatePrompts() {
  if (menuOpen || !$('prompt').hidden) return;
  const current = PROMPTS.indexOf($('prompt').textContent);
  $('prompt').textContent = PROMPTS[(current + 1) % PROMPTS.length];
}
setInterval(rotatePrompts, 4000);

function showVerify(pass, who) {
  const passEl = $('verify-pass');
  const failEl = $('verify-fail');
  if (pass) {
    $('pass-name').textContent = who || '—';
    passEl.hidden = false;
  } else {
    $('fail-who').textContent = who || 'Unknown';
    failEl.hidden = false;
  }
  setTimeout(() => {
    passEl.hidden = true;
    failEl.hidden = true;
  }, 2000);
}

function applyState(state) {
  deviceName = state.deviceName || deviceName;
  enabled = state.enabled !== false;
  if (state.deviceTime) {
    deviceOffsetMs = new Date(state.deviceTime).getTime() - Date.now();
  }
  $('devname').textContent = deviceName;
  $('banner').hidden = enabled;
  $('glyph-lock').style.opacity = enabled ? '1' : '.25';
  if (state.lcd && state.lcd.length) {
    $('lcd').hidden = false;
    $('lcd').textContent = state.lcd.join('\n');
  } else {
    $('lcd').hidden = true;
  }
}

async function punch(userId, verifyType = 1) {
  try {
    const res = await fetch('/api/punch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, verifyType }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.result === 'pass') log(`punch ok: ${userId}`, 'pass');
    else log(`punch rejected: ${body.reason || body.error || res.status}`, 'fail');
  } catch (err) {
    log(`punch error: ${err.message}`, 'fail');
  }
}

// keypad: digits select the demo user (1-5), OK punches, MENU toggles the menu
document.querySelectorAll('.key.num').forEach((key) => {
  key.addEventListener('click', () => {
    if (key.dataset.digit) {
      digitBuffer = (digitBuffer + key.dataset.digit).slice(-9);
      $('prompt').hidden = false;
      $('prompt').textContent = `PIN: ${digitBuffer}`;
    }
  });
});

document.querySelectorAll('.key.fn').forEach((key) => {
  key.addEventListener('click', () => {
    const fn = key.dataset.fn;
    if (fn === 'menu') {
      menuOpen = !menuOpen;
      $('menu').hidden = !menuOpen;
    } else if (fn === 'esc') {
      menuOpen = false;
      $('menu').hidden = true;
      digitBuffer = '';
      $('prompt').textContent = PROMPTS[0];
    } else if (fn === 'ok') {
      if (digitBuffer) void punch(digitBuffer);
      digitBuffer = '';
    }
  });
});

// SCAN = fastest demo path: punch the first seeded user
$('key-scan').addEventListener('click', async () => {
  const res = await fetch('/api/users').catch(() => null);
  if (!res || !res.ok) return log('users unavailable', 'fail');
  const { users } = await res.json();
  if (!users || !users.length) return log('no users enrolled', 'fail');
  void punch(users[0].userId);
});

// keyboard mirror of the keypad (screencast convenience)
window.addEventListener('keydown', (e) => {
  if (/^[0-9]$/.test(e.key)) digitBuffer = (digitBuffer + e.key).slice(-9);
  if (e.key === 'Enter') { if (digitBuffer) void punch(digitBuffer); digitBuffer = ''; }
  if (e.key === 'Escape') { menuOpen = false; $('menu').hidden = true; digitBuffer = ''; }
});

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => log('device link up', 'info');
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'state') applyState(msg.state);
    if (msg.type === 'verify') {
      showVerify(msg.result === 'pass', msg.user ? msg.user.name : msg.userId);
      log(`verify ${msg.result}: ${msg.user ? `${msg.user.name} (${msg.user.userId})` : msg.userId || 'unknown'}`,
        msg.result === 'pass' ? 'pass' : 'fail');
    }
    if (msg.type === 'punch') log(`attendance: ${msg.record.deviceUserId} state=${msg.record.state}`, 'info');
    if (msg.type === 'users') log(`users: ${msg.counts ? `${msg.counts.users} enrolled` : 'updated'}`, 'info');
    if (msg.type === 'lcd') applyState({ ...{}, lcd: msg.lines, deviceName, enabled });
  };
  ws.onclose = () => {
    log('device link lost — retrying', 'fail');
    setTimeout(connect, 1500);
  };
}

(async function boot() {
  // REST snapshot first (WS may take a moment), then live updates
  try {
    const res = await fetch('/api/device/state');
    applyState(await res.json());
  } catch {
    log('state snapshot failed — is the simulator running?', 'fail');
  }
  connect();
  tick();
})();
