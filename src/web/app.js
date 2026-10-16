/* ==========================================================================
   ZKTeco K14 Embedded Firmware OS — Device Face Client v4
   Authentic ZKTeco Standalone Biometric Terminal Emulation
   - Standby Screen with Real ZKTeco Wallpaper, Status Bar & Optical Glow
   - Attendance Punch State Switching (F1: Check-In, F2: Check-Out)
   - Floating PIN Input Dialog Box on Standby
   - 3x2 (6-Tile) Main Menu System (User Mgt, Comm, System, Personal, Data, Sys Info)
   - Real-time Verification Pop-up Card with Audio Feedback
   - Live Wire Protocol Terminal Console
   ========================================================================== */

const $ = (id) => document.getElementById(id);
const PROMPTS = ['Please place finger', 'Welcome!', '1:N Identification', 'Punch to record time'];

// State Machine
let currentScreen = 'idle'; // 'idle' | 'admin' | 'menu' | 'users' | 'comm' | 'system' | 'personal' | 'data' | 'sys'
let menuIndex = 1; // 1 to 6
let punchState = 0; // 0: Check-In, 1: Check-Out, 2: Break-Out, 3: Break-In
let digitBuffer = '';
let adminPinBuffer = '';
let deviceOffsetMs = 0;
let deviceName = 'ZKTECO K14';
let enabled = true;
let enrolledUsers = [];
let recentLogs = [];
let selectedUserIdx = 0;

// State Names
const STATE_NAMES = ['Check-In', 'Check-Out', 'Break-Out', 'Break-In'];
const STATE_SHORT = ['IN', 'OUT', 'B-OUT', 'B-IN'];

// Audio Synthesis
let audioCtx = null;
function getAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!audioCtx) audioCtx = new AudioContextClass();
  if (audioCtx.state === 'suspended') void audioCtx.resume();
  return audioCtx;
}

function playBeep(freq = 1800, duration = 0.03, type = 'sine', gainVal = 0.09) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(gainVal, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration);
  } catch {}
}

function playKeyBeep() {
  playBeep(1800, 0.03, 'sine', 0.08);
}

function playMenuChirp() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1040, now);
    osc.frequency.setValueAtTime(1560, now + 0.05);
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.15);
  } catch {}
}

function playChime(pass) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    if (pass) {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1320, now + 0.1);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.36);
    } else {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(160, now);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.26);
    }
  } catch {}
}

// Terminal Console Logger
function log(line, cls = 'info') {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = `[${new Date().toLocaleTimeString()}] ${line}`;
  $('log').prepend(el);
  while ($('log').children.length > 80) $('log').lastChild.remove();
}

// Clock & Standby Refresh
function tick() {
  const now = new Date(Date.now() + deviceOffsetMs);
  $('clock').textContent = now.toTimeString().slice(0, 8);
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  $('date').textContent =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  $('day-name').textContent = days[now.getDay()];

  // Update scenario clock status pill
  const pill = $('mode-pill');
  if (pill) {
    const isLive = Math.abs(deviceOffsetMs) < 3000;
    pill.className = `mode-pill ${isLive ? 'mode-live' : 'mode-sim'}`;
    pill.textContent = isLive ? 'LIVE RTC' : 'SIMULATION';
  }
}
setInterval(tick, 250);

function rotatePrompts() {
  if (currentScreen !== 'idle' || digitBuffer.length > 0) return;
  const current = PROMPTS.indexOf($('prompt').textContent);
  $('prompt').textContent = PROMPTS[(current + 1) % PROMPTS.length];
}
setInterval(rotatePrompts, 4000);

// Attendance Punch State Switcher (Check-In / Check-Out)
function setPunchState(state) {
  punchState = state % 4;
  const pill = $('state-toggle');
  const label = $('state-label');
  const isCheckIn = punchState === 0;

  if (pill) {
    pill.className = `punch-state-pill ${isCheckIn ? 'state-in' : 'state-out'}`;
    pill.querySelector('.state-arrow').textContent = isCheckIn ? '➜]' : '[➜';
  }
  if (label) {
    label.textContent = STATE_NAMES[punchState] || 'Check-In';
  }

  // Update F-Key buttons in footer
  ['in', 'out', 'bout', 'bin'].forEach((id, idx) => {
    const btn = $(`fkey-${id}`);
    if (btn) btn.classList.toggle('active', idx === punchState);
  });
}

// State pill click toggles between Check-In (0) and Check-Out (1)
$('state-toggle')?.addEventListener('click', () => {
  playKeyBeep();
  setPunchState(punchState === 0 ? 1 : 0);
});

// Footer F-key button listeners
[0, 1, 2, 3].forEach((s) => {
  const ids = ['fkey-in', 'fkey-out', 'fkey-bout', 'fkey-bin'];
  const btn = $(ids[s]);
  if (btn) {
    btn.addEventListener('click', () => {
      playKeyBeep();
      setPunchState(s);
    });
  }
});

// Screen Switcher & View Management
function switchScreen(screen) {
  currentScreen = screen;
  const views = ['idle', 'admin', 'menu', 'users', 'comm', 'system', 'personal', 'data', 'sys'];
  views.forEach((v) => {
    const el = $(`view-${v}`);
    if (el) el.hidden = v !== screen;
  });

  // Reset PIN modal on screen switch
  closePinModal();

  if (screen === 'idle') {
    digitBuffer = '';
    $('prompt').textContent = PROMPTS[0];
  } else if (screen === 'admin') {
    adminPinBuffer = '';
    $('admin-pin-display').textContent = 'PIN: _';
    $('admin-prompt').textContent = 'Enter Admin PIN or press OK to verify';
    playMenuChirp();
  } else if (screen === 'menu') {
    highlightMenuTile(menuIndex);
    playMenuChirp();
  } else if (screen === 'users') {
    renderUsersView();
  } else if (screen === 'comm') {
    // static comm view
  } else if (screen === 'system') {
    // system rules view
  } else if (screen === 'personal') {
    // personalization view
  } else if (screen === 'data') {
    renderDataView();
  } else if (screen === 'sys') {
    renderSysView();
  }
}

// Standby Floating PIN Modal Management
function openPinModal(digit) {
  digitBuffer = (digitBuffer + digit).slice(-9);
  const modal = $('pin-modal');
  const display = $('pin-modal-display');
  if (modal) modal.hidden = false;
  if (display) display.textContent = `${digitBuffer}_`;
}

function closePinModal() {
  digitBuffer = '';
  const modal = $('pin-modal');
  if (modal) modal.hidden = true;
}

// Menu Grid Tile Highlighting (6 Tiles: 3 cols x 2 rows)
function highlightMenuTile(idx) {
  menuIndex = idx;
  for (let i = 1; i <= 6; i++) {
    const tile = $(`tile-${i}`);
    if (tile) tile.classList.toggle('active', i === idx);
  }
  const pageIndicator = $('menu-page-indicator');
  if (pageIndicator) pageIndicator.textContent = `[${idx}/6]`;
}

// Menu 3x2 Grid Navigation
function navigateMenu(direction) {
  playKeyBeep();
  if (direction === 'up') {
    menuIndex = menuIndex > 3 ? menuIndex - 3 : menuIndex + 3;
  } else if (direction === 'down') {
    menuIndex = menuIndex <= 3 ? menuIndex + 3 : menuIndex - 3;
  } else if (direction === 'left') {
    menuIndex = menuIndex === 1 ? 3 : menuIndex === 4 ? 6 : menuIndex - 1;
  } else if (direction === 'right') {
    menuIndex = menuIndex === 3 ? 1 : menuIndex === 6 ? 4 : menuIndex + 1;
  }
  highlightMenuTile(menuIndex);
}

// Menu Selection Executor
function executeMenuSelect(idx = menuIndex) {
  playMenuChirp();
  if (idx === 1) switchScreen('users');
  else if (idx === 2) switchScreen('comm');
  else if (idx === 3) switchScreen('system');
  else if (idx === 4) switchScreen('personal');
  else if (idx === 5) switchScreen('data');
  else if (idx === 6) switchScreen('sys');
}

// User Management View Rendering
function renderUsersView() {
  const listEl = $('users-list');
  const countBadge = $('users-count-badge');
  if (countBadge) countBadge.textContent = `${enrolledUsers.length} users`;
  if (!listEl) return;

  if (!enrolledUsers.length) {
    listEl.innerHTML = '<div class="list-empty">No enrolled users in device</div>';
    return;
  }

  listEl.innerHTML = enrolledUsers
    .map((u, idx) => {
      const isAdmin = u.privilege >= 14;
      const isSelected = idx === selectedUserIdx;
      return `
        <div class="user-item ${isSelected ? 'selected' : ''}" data-idx="${idx}">
          <div class="u-left">
            <span class="u-id">${u.userId}</span>
            <span class="u-name">${u.name}</span>
          </div>
          ${isAdmin ? '<span class="user-badge-admin">ADMIN</span>' : ''}
        </div>
      `;
    })
    .join('');

  const activeEl = listEl.querySelector('.user-item.selected');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

// Attendance Buffer View Rendering
async function renderDataView() {
  const container = $('k14-log-buffer');
  const countBadge = $('data-log-count');
  try {
    const res = await fetch('/api/attendance');
    if (!res.ok) throw new Error('Failed');
    const { attendance } = await res.json();
    recentLogs = attendance || [];
    if (countBadge) countBadge.textContent = `${recentLogs.length} records`;

    if (!recentLogs.length) {
      container.innerHTML = '<div class="list-empty">Attendance buffer empty</div>';
      return;
    }

    container.innerHTML = recentLogs.slice(0, 15).map((r) => {
      const timeStr = r.time ? new Date(r.time).toLocaleTimeString() : '--:--';
      const stateMap = ['IN', 'OUT', 'BRK-OUT', 'BRK-IN', 'OT-IN', 'OT-OUT'];
      const stateName = stateMap[r.state] || 'PUNCH';
      return `
        <div class="log-item">
          <span class="log-who">ID:${r.deviceUserId}</span>
          <span>${timeStr}</span>
          <span class="log-state">${stateName}</span>
        </div>
      `;
    }).join('');
  } catch {
    if (container) container.innerHTML = '<div class="list-empty">Failed to load logs</div>';
  }
}

// System Information View Rendering
function renderSysView() {
  const usersCap = $('sys-cap-users');
  const logsCap = $('sys-cap-logs');
  if (usersCap) usersCap.textContent = `${enrolledUsers.length} / 500`;
  if (logsCap) logsCap.textContent = `${recentLogs.length} / 50,000`;
}

// Mathematical Attendance Calculation Preview (Matches BITS attendance-calculator.ts)
function computeMathPreview(punchDate, stateIdx) {
  const hours = punchDate.getHours();
  const minutes = punchDate.getMinutes();
  const totalMins = hours * 60 + minutes;

  const startMins = 8 * 60; // 08:00 AM (480 mins)
  const graceLimitMins = 8 * 60 + 15; // 08:15 AM (495 mins)
  const endMins = 17 * 60; // 17:00 PM (1020 mins)

  if (stateIdx === 0) { // Check-In
    if (totalMins <= startMins) {
      return { text: 'Present (On-Time)', cls: '' };
    } else if (totalMins <= graceLimitMins) {
      return { text: 'Grace Applied · 0m late', cls: 'math-grace' };
    } else {
      const lateMins = totalMins - graceLimitMins;
      return { text: `Late by ${lateMins} mins`, cls: 'math-late' };
    }
  } else if (stateIdx === 1) { // Check-Out
    if (totalMins < endMins) {
      const undertimeMins = endMins - totalMins;
      return { text: `Early Out (${undertimeMins}m undertime)`, cls: 'math-undertime' };
    } else if (totalMins <= endMins + 60) {
      return { text: 'Shift Closed · 8.00 hrs', cls: '' };
    } else {
      const otMins = totalMins - endMins;
      return { text: `Shift End + ${otMins}m OT`, cls: '' };
    }
  }
  return { text: 'Punch Recorded', cls: '' };
}

// Authentic Verification Pop-up Result Card with Math Preview
function showVerifyPopup(pass, who, userId = null, stateIdx = punchState, punchDate = null) {
  playChime(pass);
  const popup = $('verify-popup');
  const box = $('verify-box');
  const icon = $('verify-icon');
  const nameEl = $('verify-name');
  const idEl = $('verify-id');
  const stateEl = $('verify-state');
  const timeEl = $('verify-time');
  const msgEl = $('verify-msg');
  const mathEl = $('verify-math');

  if (box) box.className = `verify-modal-box ${pass ? '' : 'fail'}`;
  if (icon) icon.textContent = pass ? '✔' : '✘';
  if (nameEl) nameEl.textContent = who || 'Employee';
  if (idEl) idEl.textContent = userId || '—';
  if (stateEl) {
    stateEl.textContent = STATE_NAMES[stateIdx] || 'Check-In';
    stateEl.className = `v-state-pill ${stateIdx === 0 ? '' : 'text-accent'}`;
  }

  const effectiveDate = punchDate || new Date(Date.now() + deviceOffsetMs);
  if (timeEl) timeEl.textContent = effectiveDate.toLocaleTimeString();

  if (mathEl) {
    if (pass) {
      const math = computeMathPreview(effectiveDate, stateIdx);
      mathEl.textContent = math.text;
      mathEl.className = `v-math-pill ${math.cls}`;
    } else {
      mathEl.textContent = 'Verification Failed';
      mathEl.className = 'v-math-pill math-late';
    }
  }

  if (msgEl) msgEl.textContent = pass ? 'Thank you!' : 'Please try again';

  if (popup) popup.hidden = false;
  setTimeout(() => {
    if (popup) popup.hidden = true;
  }, 2400);
}

// Hardware State Application
function applyState(state) {
  deviceName = state.deviceName || deviceName;
  enabled = state.enabled !== false;
  if (state.deviceTime) {
    deviceOffsetMs = new Date(state.deviceTime).getTime() - Date.now();
  }
  const devname = $('devname');
  if (devname) devname.textContent = deviceName;
  const banner = $('banner');
  if (banner) banner.hidden = enabled;
  const lock = $('glyph-lock');
  if (lock) lock.style.opacity = enabled ? '1' : '.25';
  const lcd = $('lcd');
  if (lcd) {
    if (state.lcd && state.lcd.length) {
      lcd.hidden = false;
      lcd.textContent = state.lcd.join('\n');
    } else {
      lcd.hidden = true;
    }
  }
}

// Punch Execution with Active Punch State and Custom Timestamps
async function punch(userId, verifyType = 1, state = punchState, customTimestamp = null) {
  try {
    const payload = { userId, verifyType, state };
    let punchDate = null;
    if (customTimestamp) {
      punchDate = new Date(customTimestamp);
      payload.timestamp = punchDate.toISOString();
      payload.force = true; // allow rapid testing without 60s duplicate lock
    } else {
      punchDate = new Date(Date.now() + deviceOffsetMs);
    }

    const res = await fetch('/api/punch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.result === 'pass') {
      const u = enrolledUsers.find((x) => String(x.userId) === String(userId));
      log(`punch ok: user ${userId} [${STATE_NAMES[state]}] @ ${punchDate.toLocaleTimeString()}`, 'pass');
      showVerifyPopup(true, u ? u.name : `User ${userId}`, userId, state, punchDate);
      void fetchUsersAndAttendance();
    } else {
      log(`punch rejected: ${body.reason || body.error || res.status}`, 'fail');
      showVerifyPopup(false, 'Unknown', userId, state, punchDate);
    }
  } catch (err) {
    log(`punch error: ${err.message}`, 'fail');
    showVerifyPopup(false, 'Error', userId, state);
  }
}

// Check if any enrolled employee has Device Admin privileges
function hasEnrolledAdmins() {
  return enrolledUsers.some((u) => u.privilege >= 14);
}

function verifyAdminAuth() {
  const sel = $('select-user');
  const selectedUser = enrolledUsers.find((u) => u.userId === sel?.value);
  const isSelectedAdmin = selectedUser && selectedUser.privilege >= 14;

  const pinMatchesAdmin = enrolledUsers.some((u) => {
    return u.privilege >= 14 && (String(u.userId) === adminPinBuffer || u.password === adminPinBuffer);
  });

  return pinMatchesAdmin || isSelectedAdmin || adminPinBuffer === '8888';
}

// Numeric Keypad Handlers (0-9)
document.querySelectorAll('.key.num').forEach((key) => {
  key.addEventListener('click', () => {
    playKeyBeep();
    const digit = key.dataset.digit;
    if (digit === undefined) return;

    if (currentScreen === 'idle') {
      openPinModal(digit);
    } else if (currentScreen === 'admin') {
      adminPinBuffer = (adminPinBuffer + digit).slice(-6);
      $('admin-pin-display').textContent = `PIN: ${'*'.repeat(adminPinBuffer.length) || '_'}`;
    } else if (currentScreen === 'menu') {
      const num = parseInt(digit, 10);
      if (num >= 1 && num <= 6) {
        highlightMenuTile(num);
        executeMenuSelect(num);
      } else if (digit === '2') {
        navigateMenu('up');
      } else if (digit === '8') {
        navigateMenu('down');
      } else if (digit === '4') {
        navigateMenu('left');
      } else if (digit === '6') {
        navigateMenu('right');
      }
    } else if (currentScreen === 'users') {
      if (digit === '2' && selectedUserIdx > 0) {
        selectedUserIdx--;
        renderUsersView();
      } else if (digit === '8' && selectedUserIdx < enrolledUsers.length - 1) {
        selectedUserIdx++;
        renderUsersView();
      }
    }
  });
});

// Function Keys Handlers (MENU, ESC, OK)
document.querySelectorAll('.key.fn').forEach((key) => {
  key.addEventListener('click', () => {
    const fn = key.dataset.fn;
    playKeyBeep();

    if (fn === 'menu') {
      if (currentScreen === 'idle') {
        if (hasEnrolledAdmins()) switchScreen('admin');
        else switchScreen('menu');
      } else if (currentScreen === 'menu') {
        switchScreen('idle');
      } else {
        switchScreen('menu');
      }
    } else if (fn === 'esc') {
      if (currentScreen === 'idle') {
        closePinModal();
      } else if (currentScreen === 'admin' || currentScreen === 'menu') {
        switchScreen('idle');
      } else if (['users', 'comm', 'system', 'personal', 'data', 'sys'].includes(currentScreen)) {
        switchScreen('menu');
      }
    } else if (fn === 'ok') {
      if (currentScreen === 'idle') {
        if (digitBuffer) {
          const pin = digitBuffer;
          closePinModal();
          void punch(pin, 3, punchState);
        }
      } else if (currentScreen === 'admin') {
        if (verifyAdminAuth()) {
          playChime(true);
          switchScreen('menu');
        } else {
          playChime(false);
          $('admin-prompt').textContent = '❌ Access Denied: Admin Required';
          setTimeout(() => {
            if (currentScreen === 'admin') switchScreen('idle');
          }, 1500);
        }
      } else if (currentScreen === 'menu') {
        executeMenuSelect(menuIndex);
      } else if (currentScreen === 'users') {
        const u = enrolledUsers[selectedUserIdx];
        if (u) {
          void punch(u.userId, 1, punchState);
          switchScreen('idle');
        }
      }
    }
  });
});

// Direct Clicks on Menu Tiles (1 to 6)
for (let i = 1; i <= 6; i++) {
  const tile = $(`tile-${i}`);
  if (tile) {
    tile.addEventListener('click', () => {
      highlightMenuTile(i);
      executeMenuSelect(i);
    });
  }
}

// User Selection in List (click handler)
const usersListEl = $('users-list');
if (usersListEl) {
  usersListEl.addEventListener('click', (e) => {
    const item = e.target.closest('.user-item');
    if (item && item.dataset.idx !== undefined) {
      playKeyBeep();
      selectedUserIdx = parseInt(item.dataset.idx, 10);
      renderUsersView();
    }
  });
}

// Enrolled Employees Directory Fetch
async function fetchUsersAndAttendance() {
  try {
    const [uRes, aRes] = await Promise.all([
      fetch('/api/users').catch(() => null),
      fetch('/api/attendance').catch(() => null),
    ]);

    if (uRes && uRes.ok) {
      const { users } = await uRes.json();
      enrolledUsers = users || [];
      populateUsersDropdown();
      if (currentScreen === 'users') renderUsersView();
    }

    if (aRes && aRes.ok) {
      const { attendance } = await aRes.json();
      recentLogs = attendance || [];
      if (currentScreen === 'data') renderDataView();
    }
  } catch {}
}

function populateUsersDropdown() {
  const sel = $('select-user');
  if (!sel) return;
  if (enrolledUsers && enrolledUsers.length) {
    const current = sel.value;
    sel.innerHTML = enrolledUsers
      .map((u) => {
        const isAdmin = u.privilege >= 14;
        return `<option value="${u.userId}" ${u.userId === current ? 'selected' : ''}>${u.name} (ID: ${u.userId})${isAdmin ? ' [ADMIN]' : ''}</option>`;
      })
      .join('');
  } else {
    sel.innerHTML = '<option value="">No enrolled employees</option>';
  }
  updateUserShiftBadge();
}

function updateUserShiftBadge() {
  const sel = $('select-user');
  const u = enrolledUsers.find((x) => String(x.userId) === String(sel?.value));
  const badge = $('user-shift-text');
  if (badge) {
    if (u) {
      badge.textContent = `Shift: Morning (08:00 – 17:00 · Grace: 15m) · ${u.name}`;
    } else {
      badge.textContent = 'Shift: Morning (08:00 – 17:00 · Grace: 15m)';
    }
  }
}

$('select-user')?.addEventListener('change', () => {
  updateUserShiftBadge();
});

// SCAN button punches the selected user in dropdown
const keyScan = $('key-scan');
if (keyScan) {
  keyScan.addEventListener('click', async () => {
    playKeyBeep();
    const sel = $('select-user');
    const targetId = sel && sel.value ? sel.value : enrolledUsers[0]?.userId;
    if (targetId) {
      void punch(targetId, 1, punchState);
    } else {
      log('no users enrolled', 'fail');
    }
  });
}

// Clear terminal log button
const btnClear = $('btn-clear-term');
if (btnClear) {
  btnClear.addEventListener('click', () => {
    $('log').innerHTML = '';
    log('Terminal console cleared', 'info');
  });
}

// Physical Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
  if (document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    return;
  }

  if (/^[0-9]$/.test(e.key)) {
    playKeyBeep();
    const digit = e.key;
    if (currentScreen === 'idle') {
      openPinModal(digit);
    } else if (currentScreen === 'admin') {
      adminPinBuffer = (adminPinBuffer + digit).slice(-6);
      $('admin-pin-display').textContent = `PIN: ${'*'.repeat(adminPinBuffer.length) || '_'}`;
    } else if (currentScreen === 'menu') {
      const num = parseInt(digit, 10);
      if (num >= 1 && num <= 6) {
        highlightMenuTile(num);
        executeMenuSelect(num);
      }
    }
  }

  if (e.key === 'ArrowUp') {
    if (currentScreen === 'menu') navigateMenu('up');
    else if (currentScreen === 'users' && selectedUserIdx > 0) {
      selectedUserIdx--;
      renderUsersView();
    }
  } else if (e.key === 'ArrowDown') {
    if (currentScreen === 'menu') navigateMenu('down');
    else if (currentScreen === 'users' && selectedUserIdx < enrolledUsers.length - 1) {
      selectedUserIdx++;
      renderUsersView();
    }
  } else if (e.key === 'ArrowLeft') {
    if (currentScreen === 'menu') navigateMenu('left');
  } else if (e.key === 'ArrowRight') {
    if (currentScreen === 'menu') navigateMenu('right');
  }

  if (e.key === 'Enter') {
    playKeyBeep();
    if (currentScreen === 'idle') {
      if (digitBuffer) {
        const pin = digitBuffer;
        closePinModal();
        void punch(pin, 3, punchState);
      }
    } else if (currentScreen === 'admin') {
      if (verifyAdminAuth()) {
        playChime(true);
        switchScreen('menu');
      } else {
        playChime(false);
        $('admin-prompt').textContent = '❌ Access Denied: Admin Required';
        setTimeout(() => {
          if (currentScreen === 'admin') switchScreen('idle');
        }, 1500);
      }
    } else if (currentScreen === 'menu') {
      executeMenuSelect(menuIndex);
    }
  }

  if (e.key === 'Escape') {
    playKeyBeep();
    if (currentScreen === 'idle') {
      closePinModal();
    } else if (currentScreen === 'admin' || currentScreen === 'menu') {
      switchScreen('idle');
    } else if (['users', 'comm', 'system', 'personal', 'data', 'sys'].includes(currentScreen)) {
      switchScreen('menu');
    }
  }

  if (e.key.toLowerCase() === 'm') {
    playKeyBeep();
    if (currentScreen === 'idle') {
      if (hasEnrolledAdmins()) switchScreen('admin');
      else switchScreen('menu');
    } else if (currentScreen === 'menu') {
      switchScreen('idle');
    } else {
      switchScreen('menu');
    }
  }

  // F1 to F4 hotkeys for state switching
  if (e.key === 'F1') { e.preventDefault(); setPunchState(0); }
  if (e.key === 'F2') { e.preventDefault(); setPunchState(1); }
  if (e.key === 'F3') { e.preventDefault(); setPunchState(2); }
  if (e.key === 'F4') { e.preventDefault(); setPunchState(3); }
});

// WebSocket Live Wire Link
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => log('wire up — listening on TCP :4370 & WS :3030', 'info');
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'state') applyState(msg.state);
    if (msg.type === 'punch') {
      log(`wire packet: att log user=${msg.record.deviceUserId} state=${STATE_NAMES[msg.record.state] || msg.record.state}`, 'info');
      void fetchUsersAndAttendance();
    }
    if (msg.type === 'users') {
      log(`wire packet: users sync (${msg.counts ? msg.counts.users : ''} enrolled)`, 'info');
      void fetchUsersAndAttendance();
    }
    if (msg.type === 'lcd') applyState({ ...{}, lcd: msg.lines, deviceName, enabled });
  };
  ws.onclose = () => {
    log('wire link disconnected — retrying', 'fail');
    setTimeout(connect, 1500);
  };
}

// ── Shift Scenario & Time-Travel Event Listeners ──
document.querySelectorAll('.scenario-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    playKeyBeep();
    const sel = $('select-user');
    const targetId = sel && sel.value ? sel.value : enrolledUsers[0]?.userId;
    if (!targetId) {
      log('No user selected for scenario punch', 'fail');
      return;
    }

    const timeStr = btn.dataset.time; // e.g. "08:10"
    const state = parseInt(btn.dataset.state, 10); // 0 or 1
    const [h, m] = timeStr.split(':').map(Number);

    // Build target date using custom-date picker or today
    const customDateInput = $('custom-date');
    let targetDate = new Date();
    if (customDateInput && customDateInput.value) {
      const [y, mon, d] = customDateInput.value.split('-').map(Number);
      targetDate = new Date(y, mon - 1, d);
    }
    targetDate.setHours(h, m, 0, 0);

    setPunchState(state);

    // Time-travel device clock so K14 LCD screen shows this simulated time
    await fetch('/api/clock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ now: targetDate.toISOString() }),
    });

    // Execute punch with exact scenario timestamp
    await punch(targetId, 1, state, targetDate.toISOString());
  });
});

// Sync Live Real-Time Button
$('btn-sync-live')?.addEventListener('click', async () => {
  playKeyBeep();
  await fetch('/api/clock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offsetMinutes: 0 }),
  });
  log('Device RTC synchronized to real system clock (offset: 0)', 'info');
});

// Setup default date in custom-date input
const customDateEl = $('custom-date');
if (customDateEl) {
  const today = new Date();
  customDateEl.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

// Custom Date & Time Travel Punch
$('btn-custom-punch')?.addEventListener('click', async () => {
  playKeyBeep();
  const sel = $('select-user');
  const targetId = sel && sel.value ? sel.value : enrolledUsers[0]?.userId;
  if (!targetId) return;

  const dVal = $('custom-date')?.value;
  const tVal = $('custom-time')?.value || '08:00';
  const [h, m] = tVal.split(':').map(Number);
  let targetDate = new Date();
  if (dVal) {
    const [y, mon, d] = dVal.split('-').map(Number);
    targetDate = new Date(y, mon - 1, d);
  }
  targetDate.setHours(h, m, 0, 0);

  await fetch('/api/clock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ now: targetDate.toISOString() }),
  });

  await punch(targetId, 1, punchState, targetDate.toISOString());
});

// Set Clock Only Button
$('btn-custom-set-clock')?.addEventListener('click', async () => {
  playKeyBeep();
  const dVal = $('custom-date')?.value;
  const tVal = $('custom-time')?.value || '08:00';
  const [h, m] = tVal.split(':').map(Number);
  let targetDate = new Date();
  if (dVal) {
    const [y, mon, d] = dVal.split('-').map(Number);
    targetDate = new Date(y, mon - 1, d);
  }
  targetDate.setHours(h, m, 0, 0);

  await fetch('/api/clock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ now: targetDate.toISOString() }),
  });
  log(`Device clock shifted to ${targetDate.toLocaleTimeString()}`, 'info');
});

// Clear Buffer Button
$('btn-clear-buffer')?.addEventListener('click', async () => {
  playKeyBeep();
  try {
    const res = await fetch('/api/attendance', { method: 'DELETE' });
    if (res.ok) {
      log('Simulator punch buffer cleared (0 records)', 'pass');
      void fetchUsersAndAttendance();
    }
  } catch (err) {
    log(`Failed to clear buffer: ${err.message}`, 'fail');
  }
});

// Initial Boot
(async function boot() {
  try {
    const res = await fetch('/api/device/state');
    applyState(await res.json());
  } catch {
    log('state snapshot failed — is simulator running?', 'fail');
  }
  setPunchState(0);
  await fetchUsersAndAttendance();
  connect();
  tick();
})();
