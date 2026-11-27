/* =========================================================
   ROC Shift Scheduler — Production Frontend
   ========================================================= */
const API = '/api';

const DEPT_CODES = {
  ISOC: { day: 'D',  night: 'N'  },
  SCE:  { day: 'DC', night: 'NC' },
};
const CYCLE_ORDER = {
  ISOC: ['D', 'N', 'O', 'L'],
  SCE:  ['DC', 'NC', 'O', 'L'],
};
const SHIFT_LABEL = { D: 'Day', N: 'Night', DC: 'Day', NC: 'Night', O: 'Off', L: 'Leave' };

let state = {
  me:         null,  // { id, name, department_id, role }
  schedule:   null,
  mine:       null,
  department: 'ISOC',
  month:      null,
  staff:      [],
  leave:      [],
  swaps:      [],
  myLeave:    [],
  activeTab:  'mine',
  mineFilter: 'all',
};

// ── Utilities ─────────────────────────────────────────────
const el  = id => document.getElementById(id);
const qs  = (sel, ctx = document) => ctx.querySelector(sel);
const qsa = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function todayMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function isWeekend(yyyymm, day) {
  const [y, m] = yyyymm.split('-').map(Number);
  const dow = new Date(y, m - 1, day).getDay();
  return dow === 0 || dow === 6;
}

function dateStr(yyyymm, day) {
  const [y, m] = yyyymm.split('-').map(Number);
  return `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function friendlyDate(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric'
  });
}

function dayOfWeekShort(yyyymm, day) {
  const [y, m] = yyyymm.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2);
}

// ── Toast system (replaces all alert() calls) ─────────────
function toast(msg, type = 'info', duration = 3500) {
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<span class="toast-icon">${icons[type] || '·'}</span><span>${escHtml(msg)}</span>`;
  el('toastContainer').appendChild(t);
  setTimeout(() => t.remove(), duration);
}

// ── Loading overlay ───────────────────────────────────────
function showLoading(msg = 'Loading…') {
  el('loadingMsg').textContent = msg;
  el('loadingOverlay').classList.remove('hidden');
}
function hideLoading() {
  el('loadingOverlay').classList.add('hidden');
}

// ── API wrapper ───────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(API + path, { credentials: 'same-origin', ...opts });
  if (res.status === 401) { showLogin(); throw new Error('Signed out'); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

// ── Login flow ────────────────────────────────────────────
let people = [];

async function initLogin() {
  try {
    people = await api('/auth/people');
    const sel = el('personSelect');
    sel.innerHTML = people.map(p =>
      `<option value="${escHtml(p.id)}" data-pin-set="${p.pin_set}">${escHtml(p.name)} (${escHtml(p.department_id)})</option>`
    ).join('');
    updatePinLabel();
  } catch(e) {
    // Network or DB down
    el('loginError').textContent = 'Cannot reach server. Check your connection.';
    el('loginError').classList.remove('hidden');
  }
}

function updatePinLabel() {
  const opt = el('personSelect').options[el('personSelect').selectedIndex];
  const pinSet = opt?.dataset.pinSet === '1';
  el('pinLabel').textContent = pinSet ? 'PIN' : 'Create a PIN (6 digits)';
  el('pinInput').placeholder = pinSet ? 'Enter your 6-digit PIN' : 'Choose a 6-digit PIN';
  el('enrollmentWrap').classList.toggle('hidden', pinSet);
  el('loginBtn').textContent  = pinSet ? 'Sign in' : 'Set PIN & sign in';
  el('loginHint').textContent = pinSet ? '' : 'First-time setup requires a one-time code from your administrator.';
}

async function attemptLogin() {
  const staffId = el('personSelect').value;
  const pin = el('pinInput').value.trim();
  const enrollment_code = el('enrollmentInput').value.trim();
  const opt = el('personSelect').options[el('personSelect').selectedIndex];
  const pinSet = opt?.dataset.pinSet === '1';

  el('loginError').classList.add('hidden');
  if (!/^\d{6}$/.test(pin)) {
    el('loginError').textContent = 'PIN must be exactly 6 digits.';
    el('loginError').classList.remove('hidden');
    return;
  }

  el('loginBtn').disabled = true;
  el('loginBtn').textContent = 'Signing in…';
  try {
    const endpoint = pinSet ? '/auth/login' : '/auth/set-pin';
    await api(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staff_id: staffId, pin, ...(pinSet ? {} : { enrollment_code }) }),
    });
    await startApp();
  } catch(e) {
    el('loginError').textContent = e.message;
    el('loginError').classList.remove('hidden');
  } finally {
    el('loginBtn').disabled = false;
    updatePinLabel();
  }
}

function showLogin() {
  el('app').classList.add('hidden');
  el('loginScreen').classList.remove('hidden');
  el('pinInput').value = '';
  el('loginError').classList.add('hidden');
  initLogin();
}

// ── App boot ──────────────────────────────────────────────
async function startApp() {
  state.me = await api('/auth/me');
  el('loginScreen').classList.add('hidden');
  el('app').classList.remove('hidden');

  el('meName').textContent = state.me.name;
  el('meRolePill').textContent = state.me.role;
  el('meRolePill').className = `role-pill ${state.me.role === 'staff' ? 'staff-role' : ''}`;

  const isAdmin = state.me.role === 'admin';
  qsa('.admin-only').forEach(n => n.classList.toggle('hidden', !isAdmin));

  state.department = state.me.department_id;
  el('dept').value  = state.department;
  el('dept').disabled = !isAdmin;
  updateDeptBadge();

  el('month').value = todayMonth();
  state.month = el('month').value;

  await loadStaff();
  await loadLeave();
  await loadMyLeave();
  await loadLatest();
  setTab(isAdmin ? 'team' : 'mine');
  if (isAdmin) await loadStaffTable();
}

function updateDeptBadge() {
  el('deptBadge').textContent = state.department === 'SCE' ? 'SCE / SCM' : 'ISOC';
}

// ── Data loaders ──────────────────────────────────────────
async function loadStaff() {
  state.staff = await api(`/staff?department=${state.department}`);
  const sel = el('leaveStaff');
  sel.innerHTML = state.staff.map(s => `<option value="${escHtml(s.id)}">${escHtml(s.name)}</option>`).join('');
}

async function loadLeave() {
  if (state.me.role !== 'admin') { state.leave = []; return; }
  state.leave = await api(`/leave?month=${state.month}`);
  renderLeaveList();
}

async function loadMyLeave() {
  state.myLeave = await api(`/leave?staff_id=${state.me.id}&month=${state.month}`);
  renderMyLeave();
}

async function loadSwaps() {
  state.swaps = await api(`/swap-requests?month=${state.month}`);
  renderSwaps();
}

// BUG FIX: now sends department filter so correct schedule is returned
async function loadLatest() {
  const list = await api(`/schedules?month=${state.month}&department=${state.department}`);
  if (list.length === 0) {
    state.schedule = null;
    state.mine = null;
    renderAll();
    return;
  }
  await loadScheduleById(list[0].id);
}

async function loadScheduleById(id) {
  state.schedule = await api(`/schedules/${id}`);
  try {
    state.mine = await api(`/schedules/${id}/mine`);
  } catch(e) {
    state.mine = null;
  }
  renderAll();
}

async function loadStaffTable() {
  const rows = await api(`/staff?department=${state.department}`);
  const tbody = el('staffTableBody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text-3);">No staff found.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(s => `
    <tr>
      <td>${escHtml(s.name)}</td>
      <td>${escHtml(s.department_id)}</td>
      <td><span class="role-pill ${s.role === 'staff' ? 'staff-role' : ''}">${escHtml(s.role)}</span></td>
      <td><span class="pin-status ${s.pin_set ? 'set' : 'unset'}">${s.pin_set ? '● Set' : '○ Not set'}</span></td>
      <td style="display:flex;gap:6px;">
        ${s.id !== state.me.id
          ? `<button class="ghost" style="font-size:11px;padding:4px 8px;" onclick="resetPin('${s.id}', '${escHtml(s.name)}')">Reset PIN</button>`
          : ''}
        ${s.role === 'staff'
          ? `<button class="ghost" style="font-size:11px;padding:4px 8px;" onclick="makeAdmin('${s.id}', '${escHtml(s.name)}')">Make admin</button>`
          : s.id !== state.me.id ? `<button class="ghost" style="font-size:11px;padding:4px 8px;" onclick="makeStaff('${s.id}', '${escHtml(s.name)}')">Revoke admin</button>` : ''}
        ${s.id !== state.me.id
          ? `<button class="danger" style="font-size:11px;padding:4px 8px;" onclick="deactivateStaff('${s.id}', '${escHtml(s.name)}')">Deactivate</button>`
          : ''}
      </td>
    </tr>
  `).join('');
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Actions ───────────────────────────────────────────────
async function generate() {
  showLoading('Generating schedule…');
  el('generateBtn').disabled = true;
  try {
    const result = await api('/schedules/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ month: state.month, department_id: state.department }),
    });
    await loadScheduleById(result.schedule_id);
    const warnCount = result.warnings?.length ?? 0;
    if (warnCount > 0) {
      toast(`Schedule generated with ${warnCount} coverage warning${warnCount > 1 ? 's' : ''}. Review the grid.`, 'warning', 5000);
    } else {
      toast('Schedule generated successfully.', 'success');
    }
    setTab('team');
  } catch(e) {
    toast('Generation failed: ' + e.message, 'error', 6000);
  } finally {
    hideLoading();
    el('generateBtn').disabled = false;
  }
}

async function publish() {
  if (!state.schedule) return;
  if (!confirm(`Publish the ${state.month} ${state.department} schedule?\n\nThis will be used as the continuity baseline for next month. Staff will see it immediately.`)) return;
  showLoading('Publishing…');
  try {
    await api(`/schedules/${state.schedule.id}/publish`, { method: 'POST' });
    await loadScheduleById(state.schedule.id);
    toast('Schedule published. Staff can now view their shifts.', 'success');
  } catch(e) {
    toast('Publish failed: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

function exportCsv() {
  if (!state.schedule) { toast('No schedule to export.', 'warning'); return; }
  window.open(`${API}/schedules/${state.schedule.id}/export`, '_blank');
}

async function addLeave() {
  const staffId = el('leaveStaff').value;
  const date    = el('leaveDate').value;
  if (!staffId || !date) { toast('Pick a staff member and date.', 'warning'); return; }
  try {
    await api('/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staff_id: staffId, date, status: 'approved' }),
    });
    el('leaveDate').value = '';
    await loadLeave();
    toast('Leave added.', 'success');
  } catch(e) {
    toast('Failed to add leave: ' + e.message, 'error');
  }
}

async function removeLeave(id) {
  try {
    await api(`/leave/${id}`, { method: 'DELETE' });
    await loadLeave();
    toast('Leave removed.', 'success');
  } catch(e) {
    toast('Failed to remove leave: ' + e.message, 'error');
  }
}

async function onDeptOrMonthChange() {
  state.department = el('dept').value;
  state.month      = el('month').value;
  updateDeptBadge();
  showLoading();
  try {
    await loadStaff();
    await loadLeave();
    await loadMyLeave();
    await loadLatest();
    await loadSwaps();
    if (state.me.role === 'admin') await loadStaffTable();
  } finally {
    hideLoading();
  }
}

async function logout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
}

// ── Staff management actions ──────────────────────────────
async function resetPin(staffId, name) {
  if (!confirm(`Reset PIN for ${name}? They will need to set a new PIN on next login.`)) return;
  try {
    const result = await api('/auth/reset-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staff_id: staffId }),
    });
    await loadStaffTable();
    window.prompt(`Share this one-time enrollment code securely with ${name}. It will not be shown again:`, result.enrollment_code);
    toast(`PIN reset for ${name}; one-time code issued.`, 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
}

async function makeAdmin(staffId, name) {
  if (!confirm(`Grant admin (scheduler) role to ${name}?`)) return;
  try {
    await api(`/staff/${staffId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    await loadStaffTable();
    toast(`${name} is now an admin.`, 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
}

async function makeStaff(staffId, name) {
  if (!confirm(`Revoke admin role from ${name}?`)) return;
  try {
    await api(`/staff/${staffId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'staff' }),
    });
    await loadStaffTable();
    toast(`${name} is now a regular staff member.`, 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
}

async function deactivateStaff(staffId, name) {
  if (!confirm(`Deactivate ${name}? They won't be able to log in and will be removed from future schedules.`)) return;
  try {
    await api(`/staff/${staffId}`, { method: 'DELETE' });
    await loadStaffTable();
    toast(`${name} has been deactivated.`, 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
}

async function addStaffMember() {
  const name   = el('newStaffName').value.trim();
  const deptId = el('newStaffDept').value;
  const role   = el('newStaffRole').value;
  if (!name) { toast('Enter a name.', 'warning'); return; }
  try {
    await api('/staff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, department_id: deptId, role }),
    });
    closeModal('addStaffModal');
    el('newStaffName').value = '';
    await loadStaffTable();
    await loadStaff();
    toast(`${name} added to ${deptId}.`, 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
}

// ── Swap requests ─────────────────────────────────────────
function openNewSwap() {
  // Populate swap-to staff list (all dept staff except self)
  const others = state.staff.filter(s => s.id !== state.me.id);
  el('swapToStaff').innerHTML = others.map(s =>
    `<option value="${s.id}">${escHtml(s.name)}</option>`
  ).join('');
  // Populate shift codes for this dept
  const codes = DEPT_CODES[state.department];
  el('swapShiftCode').innerHTML = [codes.day, codes.night].map(c =>
    `<option value="${c}">${SHIFT_LABEL[c]} (${c})</option>`
  ).join('');
  openModal('newSwapModal');
}

async function submitSwap() {
  const date        = el('swapDate').value;
  const shiftCode   = el('swapShiftCode').value;
  const toStaffId   = el('swapToStaff').value;
  if (!date || !toStaffId) { toast('Fill in all fields.', 'warning'); return; }
  try {
    await api('/swap-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_staff_id: toStaffId, date, shift_code: shiftCode }),
    });
    closeModal('newSwapModal');
    await loadSwaps();
    toast('Swap request submitted.', 'success');
  } catch(e) {
    toast('Failed: ' + e.message, 'error');
  }
}

async function approveSwap(id) {
  try {
    await api(`/swap-requests/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    });
    await loadSwaps();
    toast('Swap request approved.', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

async function rejectSwap(id) {
  try {
    await api(`/swap-requests/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject' }),
    });
    await loadSwaps();
    toast('Swap request rejected.', 'info');
  } catch(e) { toast(e.message, 'error'); }
}

async function cancelSwap(id) {
  try {
    await api(`/swap-requests/${id}`, { method: 'DELETE' });
    await loadSwaps();
    toast('Swap request cancelled.', 'info');
  } catch(e) { toast(e.message, 'error'); }
}

// ── Modal helpers ─────────────────────────────────────────
function openModal(id)  { el(id).classList.remove('hidden'); }
function closeModal(id) { el(id).classList.add('hidden'); }

// ── Tab navigation ────────────────────────────────────────
function setTab(tab) {
  state.activeTab = tab;
  qsa('.tab-pane').forEach(p => p.classList.add('hidden'));
  const pane = el(`tab-${tab}`);
  if (pane) pane.classList.remove('hidden');
  qsa('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  // Lazy-load swaps tab
  if (tab === 'swaps') loadSwaps();
  if (tab === 'staff') loadStaffTable();
}

// ── Render ────────────────────────────────────────────────
function renderAll() {
  renderStatus();
  renderMine();
  renderMyLeave();
  renderGrid();
}

function renderStatus() {
  const pill = el('statusPill');
  const s    = state.schedule;
  if (!s) {
    pill.textContent = '';
    pill.className   = 'status-pill hidden';
    el('publishBtn').disabled = true;
    el('exportBtn').disabled  = true;
    return;
  }
  pill.textContent = s.status;
  pill.className   = `status-pill ${s.status}`;
  el('publishBtn').disabled = s.status === 'published';
  el('exportBtn').disabled  = false;
}

// ── My schedule render ─────────────────────────────────────
function renderMine() {
  const list = el('mineList');
  const subEl = el('myScheduleMonth');
  if (!state.mine) {
    list.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        <div class="empty-icon">◫</div>
        <div class="empty-title">No schedule yet</div>
        <div class="empty-hint">The scheduler hasn't generated this month's roster yet.</div>
      </div>`;
    subEl.textContent = state.month;
    return;
  }
  const { my_shifts, coworkers_by_date, month } = state.mine;
  const nDays = daysInMonth(month);
  subEl.textContent = month;

  const filter  = state.mineFilter;
  const workCodes = new Set([DEPT_CODES[state.department]?.day, DEPT_CODES[state.department]?.night, state.mine.day_code, state.mine.night_code].filter(Boolean));

  let html = '';
  for (let d = 1; d <= nDays; d++) {
    const ds   = dateStr(month, d);
    const code = my_shifts[ds] || 'O';
    const isWorking = workCodes.has(code);
    const isLeave   = code === 'L';

    if (filter === 'working' && !isWorking) continue;
    if (filter === 'off'     && (isWorking || isLeave)) continue;

    const coworkers = coworkers_by_date[ds];
    const badge = code.startsWith('D') ? 'c-day' : code.startsWith('N') ? 'c-night' : code === 'L' ? 'c-leave' : 'c-off';
    const coText = coworkers?.length
      ? `With <b>${coworkers.join(', ')}</b>`
      : isWorking ? 'Solo coverage' : '';

    html += `
      <div class="my-shift-row ${isWorking || isLeave ? 'working' : ''}">
        <span class="shift-date">${friendlyDate(ds)}</span>
        <span class="code-badge cell shift-${code}">${code}</span>
        <span class="shift-detail">${SHIFT_LABEL[code]}${coText ? ' · ' + coText : ''}</span>
      </div>`;
  }
  list.innerHTML = html || `<div style="grid-column:1/-1;color:var(--text-3);padding:20px;font-size:12px;">No shifts match this filter.</div>`;
}

// ── My leave render ────────────────────────────────────────
function renderMyLeave() {
  const el2 = el('myLeaveList');
  if (!state.myLeave?.length) {
    el2.innerHTML = '<span style="color:var(--text-3);font-size:12px;">No leave on file this month.</span>';
    return;
  }
  el2.innerHTML = state.myLeave.map(l =>
    `<span class="leave-date-chip">✦ ${friendlyDate(l.date)}</span>`
  ).join('');
}

// ── Swap list render ───────────────────────────────────────
function renderSwaps() {
  const container = el('swapList');
  if (!state.swaps?.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⇄</div>
        <div class="empty-title">No swap requests</div>
        <div class="empty-hint">Submit a request to swap a shift with a colleague.</div>
      </div>`;
    return;
  }
  const isAdmin = state.me.role === 'admin';
  container.innerHTML = state.swaps.map(s => {
    const isMine = s.from_staff_id === state.me.id;
    const adminBtns = isAdmin && s.status === 'pending'
      ? `<button class="primary" style="font-size:11px;padding:4px 10px;" onclick="approveSwap('${s.id}')">Approve</button>
         <button class="danger"  style="font-size:11px;padding:4px 10px;" onclick="rejectSwap('${s.id}')">Reject</button>`
      : '';
    const cancelBtn = isMine && s.status === 'pending'
      ? `<button class="ghost" style="font-size:11px;padding:4px 10px;" onclick="cancelSwap('${s.id}')">Cancel</button>`
      : '';
    return `
      <div class="swap-row">
        <span class="swap-status ${s.status}">${s.status}</span>
        <span class="swap-detail">
          <b>${escHtml(s.from_name)}</b> → <b>${escHtml(s.to_name)}</b> ·
          ${friendlyDate(s.date)} · <span class="mono">${s.shift_code}</span>
        </span>
        <div style="display:flex;gap:6px;">${adminBtns}${cancelBtn}</div>
      </div>`;
  }).join('');
}

// ── Leave list render ──────────────────────────────────────
function renderLeaveList() {
  const byStaff = new Set(state.staff.map(s => s.id));
  const filtered = state.leave.filter(l => byStaff.has(l.staff_id));
  const staffById = Object.fromEntries(state.staff.map(s => [s.id, s.name]));
  el('leaveList').innerHTML = filtered.map(l => `
    <span class="leave-chip">
      <b>${escHtml(staffById[l.staff_id] || l.staff_id)}</b> · ${l.date}
      <button class="rm-leave" title="Remove leave" onclick="removeLeave('${l.id}')">×</button>
    </span>
  `).join('') || '<span style="color:var(--text-3);font-size:12px;font-family:var(--font-mono);">No leave on file for this month.</span>';
}

// ── Team grid render ───────────────────────────────────────
function renderGrid() {
  // Warnings banner (BUG FIX: parse actual warnings from notes, not string include)
  const box = el('warningsBox');
  box.innerHTML = '';
  if (state.schedule?.notes && state.schedule.notes.startsWith('Warnings:')) {
    const warningText = state.schedule.notes.replace(/^Warnings:\s*/, '');
    box.innerHTML = `
      <div class="warnings-banner" style="margin:14px 18px 0;">
        <strong>⚠ Coverage warnings</strong>
        ${warningText}
      </div>`;
  }

  el('teamGridMonth').textContent = state.month;
  const wrap = el('gridWrap');
  el('coverageRow').classList.add('hidden');

  if (!state.schedule?.assignments?.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">▦</div>
        <div class="empty-title">No schedule for ${state.month}</div>
        <div class="empty-hint">Click <b>Generate</b> to create a new schedule for this department and month.</div>
      </div>`;
    el('totalsPanel').classList.add('hidden');
    return;
  }

  const month   = state.schedule.month;
  const nDays   = daysInMonth(month);
  const codes   = DEPT_CODES[state.department];
  const isAdmin = state.me.role === 'admin';

  // Filter to this department's assignments
  const byStaff = {};
  for (const row of state.schedule.assignments) {
    if (row.department_id !== state.department) continue;
    if (!byStaff[row.staff_id]) byStaff[row.staff_id] = { name: row.staff_name, days: {} };
    byStaff[row.staff_id].days[row.date] = { code: row.shift_code, override: !!row.is_manual_override };
  }

  if (!Object.keys(byStaff).length) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-icon">▦</div><div class="empty-title">No assignments for ${state.department}</div></div>`;
    el('totalsPanel').classList.add('hidden');
    return;
  }

  // Build coverage summary data
  const coverageByDay = [];
  for (let d = 1; d <= nDays; d++) {
    const ds = dateStr(month, d);
    let dayCount = 0, nightCount = 0;
    for (const sid of Object.keys(byStaff)) {
      const code = byStaff[sid].days[ds]?.code;
      if (code === codes.day)   dayCount++;
      if (code === codes.night) nightCount++;
    }
    coverageByDay.push({ d, ds, dayCount, nightCount });
  }

  // Render coverage row
  const dept = el('dept').value;
  // We don't have dept mins here directly, but we know ISOC=3, SCE=2/1
  const dayMin   = dept === 'SCE' ? 2 : 3;
  const nightMin = dept === 'SCE' ? 1 : 3;
  el('coverageRow').innerHTML = coverageByDay.map(({ d, dayCount, nightCount }) => `
    <div class="cov-day">
      <div class="cov-date">${d}</div>
      <div class="cov-counts">
        <span class="cov-count ${dayCount >= dayMin ? 'ok' : 'warn'}">${codes.day}:${dayCount}</span>
        <span class="cov-count ${nightCount >= nightMin ? 'ok' : 'warn'}">${codes.night}:${nightCount}</span>
      </div>
    </div>
  `).join('');
  el('coverageRow').classList.remove('hidden');

  // Table
  let html = '<table class="schedule"><thead><tr><th class="name-col">Staff</th>';
  for (let d = 1; d <= nDays; d++) {
    const wk = isWeekend(month, d) ? ' weekend' : '';
    html += `<th class="${wk}" title="${dateStr(month, d)}">${dayOfWeekShort(month, d)}<br>${d}</th>`;
  }
  html += '<th title="Day shifts">D</th><th title="Night shifts">N</th><th title="Leave">L</th><th title="Total worked">∑</th></tr></thead><tbody>';

  for (const staffId of Object.keys(byStaff)) {
    const { name, days } = byStaff[staffId];
    let dayCount = 0, nightCount = 0, leaveCount = 0;
    const meRow = staffId === state.me.id ? ' me' : '';
    html += `<tr class="${meRow.trim()}"><td class="name-col">${escHtml(name)}</td>`;
    for (let d = 1; d <= nDays; d++) {
      const ds   = dateStr(month, d);
      const cell = days[ds] || { code: 'O', override: false };
      const code = cell.code;
      if (code === codes.day)   dayCount++;
      else if (code === codes.night) nightCount++;
      else if (code === 'L')    leaveCount++;
      const wk = isWeekend(month, d) ? ' weekend' : '';
      const ov = cell.override ? ' override' : '';
      const locked = isAdmin ? '' : ' locked';
      html += `<td class="${wk}${ov}" title="${ds}: ${SHIFT_LABEL[code]}${cell.override ? ' (manual)' : ''}">
        <button class="cell shift-${code}${locked}" data-staff="${staffId}" data-date="${ds}" data-code="${code}">${code}</button>
      </td>`;
    }
    html += `<td class="totals-col">${dayCount}</td><td class="totals-col">${nightCount}</td><td class="totals-col">${leaveCount}</td><td class="totals-col">${dayCount + nightCount}</td></tr>`;
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;

  if (isAdmin) {
    qsa('.cell:not(.locked)', wrap).forEach(btn => btn.addEventListener('click', onCellClick));
  }

  renderTotals(byStaff, month, codes);
  el('totalsPanel').classList.remove('hidden');
}

function renderTotals(byStaff, month, codes) {
  const nDays = daysInMonth(month);
  let html = `<thead><tr>
    <th>Staff</th>
    <th class="num" style="text-align:right;">Day</th>
    <th class="num" style="text-align:right;">Night</th>
    <th class="num" style="text-align:right;">Weekend</th>
    <th class="num" style="text-align:right;">Leave</th>
    <th class="num" style="text-align:right;">Total</th>
  </tr></thead><tbody>`;
  for (const staffId of Object.keys(byStaff)) {
    const { name, days } = byStaff[staffId];
    let dC = 0, nC = 0, lC = 0, wC = 0;
    for (let d = 1; d <= nDays; d++) {
      const ds = dateStr(month, d);
      const code = (days[ds] || { code: 'O' }).code;
      if (code === codes.day)   { dC++; if (isWeekend(month, d)) wC++; }
      else if (code === codes.night) { nC++; if (isWeekend(month, d)) wC++; }
      else if (code === 'L')    lC++;
    }
    html += `<tr><td class="name-cell">${escHtml(name)}</td>
      <td class="num">${dC}</td><td class="num">${nC}</td>
      <td class="num">${wC}</td><td class="num">${lC}</td>
      <td class="num" style="color:var(--accent);font-weight:700;">${dC + nC}</td></tr>`;
  }
  html += '</tbody>';
  el('totalsTable').innerHTML = html;
}

// ── Cell click (grid override) ─────────────────────────────
async function onCellClick(e) {
  const btn  = e.currentTarget;
  const staffId = btn.dataset.staff;
  const date    = btn.dataset.date;
  const current = btn.dataset.code;
  const cycle   = CYCLE_ORDER[state.department];
  const next    = cycle[(cycle.indexOf(current) + 1) % cycle.length];

  // Optimistic UI update
  btn.className = `cell shift-${next}`;
  btn.textContent = next;
  btn.dataset.code = next;
  btn.closest('td').classList.add('override');

  try {
    await api(`/schedules/${state.schedule.id}/assignment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staff_id: staffId, date, shift_code: next }),
    });
    // Silently refresh schedule data in background (don't re-render grid to avoid scroll jump)
    api(`/schedules/${state.schedule.id}`).then(s => { state.schedule = s; renderStatus(); }).catch(() => {});
  } catch(err) {
    // Revert on failure
    btn.className = `cell shift-${current}`;
    btn.textContent = current;
    btn.dataset.code = current;
    toast('Update failed: ' + err.message, 'error');
  }
}

// ── Event wiring ───────────────────────────────────────────
function init() {
  // Login
  el('loginBtn').addEventListener('click', attemptLogin);
  el('personSelect').addEventListener('change', () => {
    updatePinLabel();
    el('pinInput').focus();
  });
  el('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') attemptLogin(); });

  // Controls bar
  el('dept').addEventListener('change', onDeptOrMonthChange);
  el('month').addEventListener('change', onDeptOrMonthChange);
  el('generateBtn').addEventListener('click', generate);
  el('loadBtn').addEventListener('click', async () => { showLoading(); try { await loadLatest(); } finally { hideLoading(); } });
  el('publishBtn').addEventListener('click', publish);
  el('exportBtn').addEventListener('click', exportCsv);
  el('logoutBtn').addEventListener('click', logout);

  // Nav buttons
  qsa('.nav-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });

  // My schedule filter chips
  qsa('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      qsa('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.mineFilter = chip.dataset.filter;
      renderMine();
    });
  });

  // Leave
  el('addLeaveBtn').addEventListener('click', addLeave);

  // Staff modal
  el('addStaffBtn').addEventListener('click', () => openModal('addStaffModal'));
  el('cancelAddStaff').addEventListener('click', () => closeModal('addStaffModal'));
  el('confirmAddStaff').addEventListener('click', addStaffMember);
  el('addStaffModal').addEventListener('click', e => { if (e.target === el('addStaffModal')) closeModal('addStaffModal'); });

  // Swap modal
  el('newSwapBtn').addEventListener('click', openNewSwap);
  el('cancelSwap').addEventListener('click', () => closeModal('newSwapModal'));
  el('confirmSwap').addEventListener('click', submitSwap);
  el('newSwapModal').addEventListener('click', e => { if (e.target === el('newSwapModal')) closeModal('newSwapModal'); });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeModal('addStaffModal');
      closeModal('newSwapModal');
    }
    // Alt+1/2/3... quick tab switch
    if (e.altKey && !e.ctrlKey) {
      const tabMap = { '1': 'mine', '2': 'myLeave', '3': 'swaps', '4': 'team', '5': 'leave', '6': 'staff' };
      if (tabMap[e.key]) { setTab(tabMap[e.key]); e.preventDefault(); }
    }
  });

  // Resume session or show login
  api('/auth/me').then(startApp).catch(() => showLogin());
}

init();
