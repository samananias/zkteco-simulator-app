// Biometric admin view (Phase 8, web-ui.md §5) — enrolled templates, consent
// records, withdrawal and purge.
//
// Renders METADATA ONLY: the page never fetches, stores or logs template bytes
// (ADR-011 §3). All copy that reaches the DOM goes through `esc()`.
const $ = (id) => document.getElementById(id);

const FINGERS = [
  'R index', 'R middle', 'R thumb', 'R ring', 'R pinky',
  'L index', 'L middle', 'L thumb', 'L ring', 'L pinky',
];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
};

const setVerdict = (id, text, cls) => {
  const el = $(id);
  el.textContent = text;
  el.className = `verdict ${cls ?? ''}`;
};

async function api(path, init) {
  const res = await fetch(path, init);
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

function row(cols) {
  const tr = document.createElement('tr');
  tr.innerHTML = cols.join('');
  return tr;
}

function cell(text) {
  return `<td>${esc(text)}</td>`;
}

// ---------------------------------------------------------------- status

async function loadStatus() {
  const { res, json } = await api('/api/biometric/status');
  if (!res.ok) {
    $('status').innerHTML = `<span class="admin-badge fail">unavailable</span> ${esc(json.error ?? 'biometric subsystem disabled')}`;
    return;
  }
  const retention = json.retentionDays > 0 ? `${json.retentionDays} days` : 'while the employee exists';
  $('status').innerHTML = [
    `<span class="admin-badge ${json.matcherUp ? 'pass' : 'fail'}">matcher ${json.matcherUp ? 'online' : 'offline'}</span>`,
    `<span>${json.enrolled} enrolled · ${json.consents ?? 0} consent records</span>`,
    `<span>accept ≥ ${json.threshold} · separation ≥ ${json.separation}</span>`,
    `<span>retention: ${esc(retention)}</span>`,
    `<span>statement ${esc(json.consentVersion)} · station ${esc(json.stationId)}</span>`,
    `<span>matcher table ${json.matcherTemplates}</span>`,
  ].join('');
}

// ------------------------------------------------------------- enrollments

async function loadEnrollments() {
  const { res, json } = await api('/api/biometric/enrollments');
  const rows = res.ok ? json.enrollments ?? [] : [];
  $('enroll-count').textContent = String(rows.length);
  const body = $('enroll-table').querySelector('tbody');
  body.innerHTML = '';
  if (!rows.length) {
    body.appendChild(row(['<td colspan="7" class="admin-empty">No enrollments yet — use the /enroll station</td>']));
    return;
  }
  for (const e of rows) {
    body.appendChild(
      row([
        `<td>${esc(e.name || '—')}<span class="admin-sub">${esc(e.userId)}</span></td>`,
        cell(FINGERS[e.finger] ?? e.finger),
        cell(e.source),
        cell(e.station || '—'),
        cell(e.quality),
        cell(when(e.createdAt)),
        `<td><button class="admin-btn" data-remove="${esc(e.userId)}" data-finger="${esc(e.finger)}">Remove</button></td>`,
      ]),
    );
  }
}

// ---------------------------------------------------------------- consents

async function loadConsents() {
  const { res, json } = await api('/api/biometric/consents');
  const rows = res.ok ? json.consents ?? [] : [];
  $('consent-count').textContent = String(rows.length);
  const body = $('consent-table').querySelector('tbody');
  body.innerHTML = '';
  if (!rows.length) {
    body.appendChild(row(['<td colspan="7" class="admin-empty">No consent records yet</td>']));
    return;
  }
  for (const c of rows) {
    const status = c.withdrawnAt
      ? `<span class="admin-badge fail">withdrawn</span><span class="admin-sub">${esc(c.withdrawReason ?? '')}</span>`
      : '<span class="admin-badge pass">active</span>';
    body.appendChild(
      row([
        `<td>${esc(c.name || '—')}<span class="admin-sub">${esc(c.userId)}</span></td>`,
        cell(c.statementVersion),
        cell(c.method),
        cell(c.station || '—'),
        cell(when(c.at)),
        `<td>${status}</td>`,
        c.withdrawnAt ? '<td></td>' : `<td><button class="admin-btn" data-withdraw="${esc(c.userId)}">Withdraw</button></td>`,
      ]),
    );
  }
}

// ---------------------------------------------------------------- actions

async function refresh() {
  await Promise.all([loadStatus(), loadEnrollments(), loadConsents()]);
}

async function removeEnrollment(button) {
  const userId = button.dataset.remove;
  const finger = Number(button.dataset.finger);
  if (!confirm(`Remove the ${FINGERS[finger] ?? `finger ${finger}`} template of employee ${userId}?`)) return;
  button.disabled = true;
  const { res, json } = await api('/api/biometric/remove', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, finger }),
  });
  if (!res.ok) alert(json.error ?? 'removal failed');
  await refresh();
}

async function withdrawEmployee(button) {
  const userId = button.dataset.withdraw;
  if (!confirm(`Withdraw consent for employee ${userId}?\n\nEvery template for this employee is deleted immediately.`)) return;
  button.disabled = true;
  const { res, json } = await api('/api/biometric/withdraw', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, reason: 'withdrawn via the admin view' }),
  });
  if (!res.ok) {
    alert(json.error ?? 'withdrawal failed');
    return;
  }
  setVerdict('purge-verdict', `Withdrawn ${json.userId}: ${json.removed} template(s) deleted.`, 'good');
  await refresh();
}

async function purge() {
  $('purge').disabled = true;
  const { res, json } = await api('/api/biometric/purge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });
  if (!res.ok) {
    setVerdict('purge-verdict', `✗ ${json.error ?? 'purge failed'}`, 'bad');
    return;
  }
  setVerdict('purge-verdict', `✔ purged ${json.purged} template(s) — every consent record removed too.`, 'good');
  $('purge-confirm').value = '';
  await refresh();
}

// ------------------------------------------------------------------- boot

function boot() {
  $('purge-confirm').addEventListener('input', () => {
    $('purge').disabled = $('purge-confirm').value.trim() !== 'PURGE';
  });
  $('purge').addEventListener('click', () => void purge());
  $('enroll-table').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-remove]');
    if (button) void removeEnrollment(button);
  });
  $('consent-table').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-withdraw]');
    if (button) void withdrawEmployee(button);
  });
  void refresh();
}

boot();