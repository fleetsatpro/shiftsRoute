/* =========================================================
   ROC Shift Scheduler — Production Frontend
   ========================================================= */
import { escHtml, safeShiftCode, safeStatus } from './ui-utils.js';
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
  el('app').setAttribute('aria-busy', 'true');
  el('loadingOverlay').classList.remove('hidden');
}
function hideLoading() {
  el('loadingOverlay').classList.add('hidden');
  el('app').setAttribute('aria-busy', 'false');
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
  el('enrollmentInput').value = '';
  state.me = null;
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
  tbody.innerHTML = rows.map(s => {
    const id = escHtml(s.id);
    const name = escHtml(s.name);
    const actions = [];
    if (s.id !== state.me.id) actions.push(`<button type="button" class="ghost" data-action="reset-pin" data-staff-id="${id}" data-staff-name="${name}">Reset PIN</button>`);
    if (s.role === 'staff') actions.push(`<button type="button" class="ghost" data-action="make-admin" data-staff-id="${id}" data-staff-name="${name}">Make admin</button>`);
    else if (s.id !== state.me.id) actions.push(`<button type="button" class="ghost" data-action="make-staff" data-staff-id="${id}" data-staff-name="${name}">Revoke admin</button>`);
    if (s.id !== state.me.id) actions.push(`<button type="button" class="danger" data-action="deactivate" data-staff-id="${id}" data-staff-name="${name}">Deactivate</button>`);
    return `
      <tr data-search="${escHtml([s.name, s.department_id, s.role].join(" ").toLowerCase())}">
        <td>${name}</td>
        <td>${escHtml(s.department_id)}</td>
        <td><span class="role-pill ${s.role === 'staff' ? 'staff-role' : ''}">${escHtml(s.role)}</span></td>
        <td><span class="pin-status ${s.pin_set ? 'set' : 'unset'}">${s.pin_set ? '● Set' : '○ Not set'}</span></td>
        <td class="staff-actions">${actions.join('')}</td>
      </tr>`;
  }).join('');
  applyStaffSearch();
}

function applyStaffSearch() {
  const query = (el('staffSearch')?.value || '').trim().toLowerCase();
  qsa('#staffTableBody tr').forEach(row => {
    row.classList.toggle('hidden', query !== '' && !row.dataset.search?.includes(query));
  });
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
  const nextMonth = el('month').value;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(nextMonth)) {
    toast('Choose a valid month.', 'warning');
    return;
  }
  state.department = el('dept').value;
  state.month = nextMonth;
  updateDeptBadge();
  showLoading('Loading roster…');
  try {
    await loadStaff();
    await loadLeave();
    await loadMyLeave();
    await loadLatest();
    await loadSwaps();
    if (state.me.role === 'admin') await loadStaffTable();
  } catch (err) {
    toast('Could not refresh the selected month: ' + err.message, 'error', 5500);
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
    el('enrollmentCodeValue').value = result.enrollment_code;
    openModal('enrollmentCodeModal');
    toast(`PIN reset for ${name}; share the displayed one-time code securely.`, 'success', 5000);
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
    `<option value="${escHtml(s.id)}">${escHtml(s.name)}</option>`
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
let modalReturnFocus = null;
function openModal(id) {
  const modal = el(id);
  modalReturnFocus = document.activeElement;
  modal.classList.remove('hidden');
  modal.querySelector('input, select, button')?.focus();
}
function closeModal(id) {
  el(id).classList.add('hidden');
  if (!qs('.modal-backdrop:not(.hidden)')) modalReturnFocus?.focus();
}

// ── Tab navigation ────────────────────────────────────────
function setTab(tab) {
  if (['team', 'leave', 'staff'].includes(tab) && state.me?.role !== 'admin') return;
  state.activeTab = tab;
  qsa('.tab-pane').forEach(p => p.classList.add('hidden'));
  const pane = el(`tab-${tab}`);
  if (pane) pane.classList.remove('hidden');
  qsa('.nav-btn').forEach(b => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  // Lazy-load tab data and surface failures instead of silently leaving stale content.
  if (tab === 'swaps') loadSwaps().catch(err => toast('Could not load swap requests: ' + err.message, 'error'));
  if (tab === 'staff') loadStaffTable().catch(err => toast('Could not load staff: ' + err.message, 'error'));
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
  const status = safeStatus(s.status);
  pill.textContent = status;
  pill.className   = `status-pill ${status}`;
  el('publishBtn').disabled = status === 'published';
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

    const coworkers = Array.isArray(coworkers_by_date[ds]) ? coworkers_by_date[ds] : [];
    const safeCode = safeShiftCode(code);
    const coText = coworkers.length
      ? `With <b>${coworkers.map(escHtml).join(', ')}</b>`
      : isWorking ? 'Solo coverage' : '';

    html += `
      <div class="my-shift-row ${isWorking || isLeave ? 'working' : ''}">
        <span class="shift-date">${friendlyDate(ds)}</span>
        <span class="code-badge cell shift-${safeCode}">${safeCode}</span>
        <span class="shift-detail">${escHtml(SHIFT_LABEL[safeCode] || safeCode)}${coText ? ' · ' + coText : ''}</span>
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
    `<span class="leave-date-chip">${escHtml(friendlyDate(l.date))}</span>`
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
    const id = escHtml(s.id);
    const status = safeStatus(s.status);
    const shiftCode = safeShiftCode(s.shift_code);
    const actionBtn = (action, label, variant) =>
      `<button type="button" class="${variant}" data-action="${action}" data-swap-id="${id}">${label}</button>`;
    const adminBtns = isAdmin && status === 'pending'
      ? actionBtn('approve-swap', 'Approve', 'primary') + actionBtn('reject-swap', 'Reject', 'danger')
      : '';
    const cancelBtn = isMine && status === 'pending' ? actionBtn('cancel-swap', 'Cancel', 'ghost') : '';
    return `
      <div class="swap-row">
        <span class="swap-status ${status}">${status}</span>
        <span class="swap-detail">
          <b>${escHtml(s.from_name)}</b> → <b>${escHtml(s.to_name)}</b> ·
          ${escHtml(friendlyDate(s.date))} · <span class="mono">${shiftCode}</span>
        </span>
        <div class="swap-actions">${adminBtns}${cancelBtn}</div>
      </div>`;
  }).join('');
}

// ── Leave list render ──────────────────────────────────────
function renderLeaveList() {
  const byStaff = new Set(state.staff.map(s => s.id));
  const filtered = state.leave.filter(l => byStaff.has(l.staff_id));
  const staffById = Object.assign(Object.create(null), Object.fromEntries(state.staff.map(s => [s.id, s.name])));
  el('leaveList').innerHTML = filtered.map(l => `
    <span class="leave-chip">
      <b>${escHtml(staffById[l.staff_id] || l.staff_id)}</b> · ${escHtml(l.date)}
      <button type="button" class="rm-leave" title="Remove leave" aria-label="Remove leave for ${escHtml(staffById[l.staff_id] || l.staff_id)}" data-action="remove-leave" data-leave-id="${escHtml(l.id)}">×</button>
    </span>
  `).join('') || '<span class="muted">No leave on file for this month.</span>';
}

function renderScheduleMetrics() {
  const panel = el('teamMetrics');
  const rows = (state.schedule?.assignments || []).filter(row => row.department_id === state.department);
  if (!rows.length) {
    panel.classList.add('hidden');
    return;
  }
  const codes = DEPT_CODES[state.department];
  const staff = new Set(rows.map(row => row.staff_id));
  const day = rows.filter(row => row.shift_code === codes.day).length;
  const night = rows.filter(row => row.shift_code === codes.night).length;
  const leave = rows.filter(row => row.shift_code === 'L').length;
  const overrides = rows.filter(row => !!row.is_manual_override).length;
  el('metricStaff').textContent = staff.size.toLocaleString();
  el('metricDay').textContent = day.toLocaleString();
  el('metricNight').textContent = night.toLocaleString();
  el('metricLeave').textContent = leave.toLocaleString();
  el('metricOverrides').textContent = overrides.toLocaleString();
  panel.classList.remove('hidden');
}

// ── Team grid render ───────────────────────────────────────
function renderGrid() {
  renderScheduleMetrics();
  const box = el('warningsBox');
  box.replaceChildren();
  if (typeof state.schedule?.notes === 'string' && state.schedule.notes.startsWith('Warnings:')) {
    const banner = document.createElement('div');
    banner.className = 'warnings-banner';
    const heading = document.createElement('strong');
    heading.textContent = 'Coverage warnings';
    const message = document.createElement('p');
    message.textContent = state.schedule.notes.replace(/^Warnings:\\s*/, '');
    banner.append(heading, message);
    box.appendChild(banner);
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
  // Staff IDs are external data; use a null-prototype map so values such as
  // `constructor` or `__proto__` cannot collide with inherited object keys.
  const byStaff = Object.create(null);
  for (const row of state.schedule.assignments) {
    if (row.department_id !== state.department) continue;
    if (!byStaff[row.staff_id]) byStaff[row.staff_id] = { name: row.staff_name, days: {} };
    byStaff[row.staff_id].days[row.date] = { code: safeShiftCode(row.shift_code), override: !!row.is_manual_override };
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
      const code = safeShiftCode(cell.code);
      if (code === codes.day) dayCount++;
      else if (code === codes.night) nightCount++;
      else if (code === 'L') leaveCount++;
      const wk = isWeekend(month, d) ? ' weekend' : '';
      const ov = cell.override ? ' override' : '';
      const locked = isAdmin ? '' : ' locked';
      const title = `${ds}: ${SHIFT_LABEL[code] || code}${cell.override ? ' (manual)' : ''}`;
      html += `<td class="${wk}${ov}" title="${escHtml(title)}">
        <button type="button" class="cell shift-${code}${locked}" data-staff="${escHtml(staffId)}" data-date="${ds}" data-code="${code}" aria-label="${escHtml(name)} on ${ds}: ${code}" ${isAdmin ? '' : 'disabled'}>${code}</button>
      </td>`;
    }
    html += `<td class="totals-col">${dayCount}</td><td class="totals-col">${nightCount}</td><td class="totals-col">${leaveCount}</td><td class="totals-col">${dayCount + nightCount}</td></tr>`;
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;

  // One delegated listener survives grid re-renders without accumulating handlers.
  if (!wrap.dataset.bound) {
    wrap.addEventListener('click', e => {
      const button = e.target.closest('.cell:not(.locked)');
      if (button && wrap.contains(button)) onCellClick({ currentTarget: button });
    });
    wrap.dataset.bound = '1';
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
  const btn = e.currentTarget;
  if (btn.disabled || btn.dataset.saving === '1') return;
  const staffId = btn.dataset.staff;
  const date = btn.dataset.date;
  const current = safeShiftCode(btn.dataset.code);
  const cycle = CYCLE_ORDER[state.department];
  const currentIndex = cycle.indexOf(current);
  if (currentIndex < 0) return;
  const next = cycle[(currentIndex + 1) % cycle.length];
  const cell = btn.closest('td');
  const wasOverride = cell.classList.contains('override');
  btn.dataset.saving = '1';
  btn.disabled = true;
  btn.textContent = '…';

  try {
    await api(`/schedules/${state.schedule.id}/assignment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staff_id: staffId, date, shift_code: next }),
    });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = current;
    btn.dataset.saving = '0';
    if (!wasOverride) cell.classList.remove('override');
    toast('Update failed: ' + err.message, 'error');
    return;
  }

  // The write is confirmed. Reflect it locally first, then reconcile with the
  // server snapshot; a failed refresh must never report a successful write as failed.
  const assignment = state.schedule.assignments?.find(row =>
    row.staff_id === staffId && row.date === date
  );
  if (assignment) {
    assignment.shift_code = next;
    assignment.is_manual_override = 1;
  }
  const scrollLeft = el('gridWrap').scrollLeft;
  const scrollTop = el('gridWrap').scrollTop;
  renderGrid();
  el('gridWrap').scrollLeft = scrollLeft;
  el('gridWrap').scrollTop = scrollTop;
  toast(`${date}: ${next} saved.`, 'success', 1800);

  try {
    state.schedule = await api(`/schedules/${state.schedule.id}`);
    const left = el('gridWrap').scrollLeft;
    const top = el('gridWrap').scrollTop;
    renderGrid();
    el('gridWrap').scrollLeft = left;
    el('gridWrap').scrollTop = top;
  } catch (err) {
    toast('Saved, but the latest roster snapshot could not be refreshed.', 'warning', 4500);
  }
}

// ── Event wiring ───────────────────────────────────────────
function applyTheme(theme) {
  const allowed = new Set(['aurora', 'obsidian', 'amethyst', 'ember', 'arctic']);
  const selected = allowed.has(theme) ? theme : 'aurora';
  document.documentElement.dataset.theme = selected;
  const picker = el('themeSelect');
  if (picker) picker.value = selected;
  try { localStorage.setItem('shiftsroute-theme', selected); } catch { /* storage may be unavailable */ }
}

function init() {
  // Theme selection is a presentation preference only; it never changes account or schedule data.
  let savedTheme = 'aurora';
  try { savedTheme = localStorage.getItem('shiftsroute-theme') || 'aurora'; } catch { /* storage may be unavailable */ }
  applyTheme(savedTheme);
  el('themeSelect').addEventListener('change', event => applyTheme(event.target.value));

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
  el('loadBtn').addEventListener('click', async () => {
    showLoading('Refreshing schedule…');
    try { await loadLatest(); toast('Schedule refreshed.', 'success', 1600); }
    catch (err) { toast('Refresh failed: ' + err.message, 'error'); }
    finally { hideLoading(); }
  });
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
      qsa('.filter-chip').forEach(c => c.setAttribute('aria-pressed', String(c === chip)));
      state.mineFilter = chip.dataset.filter;
      renderMine();
    });
  });

  // Leave
  el('addLeaveBtn').addEventListener('click', addLeave);

  // Delegated actions: no user-controlled values are interpolated into executable HTML.
  el('staffTableBody').addEventListener('click', e => {
    const button = e.target.closest('[data-action]');
    if (!button) return;
    const { action, staffId, staffName } = button.dataset;
    const handlers = {
      'reset-pin': resetPin,
      'make-admin': makeAdmin,
      'make-staff': makeStaff,
      deactivate: deactivateStaff,
    };
    if (handlers[action]) handlers[action](staffId, staffName);
  });
  el('swapList').addEventListener('click', e => {
    const button = e.target.closest('[data-action][data-swap-id]');
    if (!button) return;
    const handlers = {
      'approve-swap': approveSwap,
      'reject-swap': rejectSwap,
      'cancel-swap': cancelSwap,
    };
    if (handlers[button.dataset.action]) handlers[button.dataset.action](button.dataset.swapId);
  });
  el('leaveList').addEventListener('click', e => {
    const button = e.target.closest('[data-action="remove-leave"]');
    if (button) removeLeave(button.dataset.leaveId);
  });

  // Staff directory search filters the currently loaded department roster.
  el('staffSearch').addEventListener('input', applyStaffSearch);

  // Staff modal
  el('addStaffBtn').addEventListener('click', () => openModal('addStaffModal'));
  el('cancelAddStaff').addEventListener('click', () => closeModal('addStaffModal'));
  el('confirmAddStaff').addEventListener('click', addStaffMember);
  el('addStaffModal').addEventListener('click', e => { if (e.target === el('addStaffModal')) closeModal('addStaffModal'); });

  // One-time enrollment code: keep it visible only in the dedicated dialog.
  el('closeEnrollmentCode').addEventListener('click', () => {
    closeModal('enrollmentCodeModal');
    el('enrollmentCodeValue').value = '';
  });
  el('copyEnrollmentCode').addEventListener('click', async () => {
    const code = el('enrollmentCodeValue').value;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast('Enrollment code copied. Share it securely.', 'success');
    } catch {
      el('enrollmentCodeValue').focus();
      el('enrollmentCodeValue').select();
      toast('Select and copy the highlighted code, then share it securely.', 'info', 5000);
    }
  });

  // Swap modal
  el('newSwapBtn').addEventListener('click', openNewSwap);
  el('cancelSwap').addEventListener('click', () => closeModal('newSwapModal'));
  el('confirmSwap').addEventListener('click', submitSwap);
  el('newSwapModal').addEventListener('click', e => { if (e.target === el('newSwapModal')) closeModal('newSwapModal'); });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const openDialog = qs('.modal-backdrop:not(.hidden) .modal');
    if (e.key === 'Escape' && openDialog) {
      closeModal(openDialog.closest('.modal-backdrop').id);
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab' && openDialog) {
      const focusable = qsa('button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])', openDialog)
        .filter(node => node.offsetParent !== null);
      if (focusable.length) {
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    }
    // Alt+1/2/3... quick tab switch
    if (e.altKey && !e.ctrlKey) {
      const tabMap = { '1': 'mine', '2': 'myLeave', '3': 'swaps', '4': 'team', '5': 'leave', '6': 'staff' };
      if (tabMap[e.key]) { setTab(tabMap[e.key]); e.preventDefault(); }
    }
  });

  // Resume session or show login
  api('/auth/me').then(startApp).catch(err => { if (err.message !== 'Signed out') showLogin(); });
}

init();
