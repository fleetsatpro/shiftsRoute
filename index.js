// src/index.js — ROC Shift Scheduler (production build)
//
// BUGS FIXED:
//   - GET /api/schedules now accepts ?department= filter so dept switching
//     returns the correct schedule (not just the most-recently-generated one
//     regardless of department).
//   - GET /api/schedules/:id/mine returned 500 when no schedule existed;
//     now returns 404 cleanly.
//   - PATCH assignment didn't validate that the staff member belongs to the
//     schedule's department — now it does.
//
// NEW ENDPOINTS:
//   POST   /api/auth/reset-pin            { staff_id }      [admin]  → clears pin_set flag
//   GET    /api/staff/:id                 → single staff record        [session]
//   DELETE /api/staff/:id                 → deactivate staff           [admin]
//   PATCH  /api/staff/:id                 { role?, name? }             [admin]
//   GET    /api/swap-requests?month=…     list swap requests           [session]
//   POST   /api/swap-requests             { from_staff_id, to_staff_id, date, shift_code } [session]
//   PATCH  /api/swap-requests/:id         { action: 'approve'|'reject' }  [admin]
//   DELETE /api/swap-requests/:id         cancel own swap request      [session]
//   GET    /api/schedules?month=…&department=… (fixed)
//   GET    /api/health                    → { ok: true, ts }           [none]

import { generateSchedule, daysInMonth, dateStr } from './solver.js';
import { buildCsv, isValidCalendarDate, isValidMonth } from './helpers.js';
import {
  sha256Hex,
  hashPin,
  safeEqual,
  isValidPin,
  getCurrentStaff,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
  SESSION_COOKIE,
} from './auth.js';

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

function uuid() { return crypto.randomUUID(); }

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // ── CORS preflight (for local dev) ───────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    try {
      if (!pathname.startsWith('/api/')) {
        return env.ASSETS.fetch(request);
      }

      // ── Health check ──────────────────────────────────────────────────
      if (pathname === '/api/health' && request.method === 'GET') {
        return json({ ok: true, ts: new Date().toISOString() });
      }

      // ── Auth: no session required ─────────────────────────────────────
      if (pathname === '/api/auth/people' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT id, name, department_id, pin_set FROM staff WHERE active = 1 ORDER BY department_id, name'
        ).all();
        return json(results);
      }

      if (pathname === '/api/auth/set-pin' && request.method === 'POST') {
        const body = await request.json();
        const { staff_id, pin, enrollment_code } = body;
        if (!isValidPin(pin)) return json({ error: 'PIN must be exactly 6 digits' }, { status: 400 });
        if (typeof enrollment_code !== 'string' || enrollment_code.length < 16 || enrollment_code.length > 256) {
          return json({ error: 'A valid one-time enrollment code is required' }, { status: 403 });
        }
        const person = await env.DB.prepare(
          'SELECT id, pin_set, role, enrollment_hash FROM staff WHERE id = ? AND active = 1'
        ).bind(staff_id).first();
        if (!person) return json({ error: 'Enrollment could not be verified' }, { status: 403 });
        if (person.pin_set) return json({ error: 'PIN already set — use login instead' }, { status: 409 });
        const bootstrapClaim = await env.DB.prepare(
          "SELECT value FROM app_settings WHERE key = 'initial_admin_enrolled'"
        ).first();
        const bootstrapAllowed = !bootstrapClaim
          && person.role === 'admin'
          && typeof env.INITIAL_ADMIN_ENROLLMENT_SECRET === 'string'
          && safeEqual(enrollment_code, env.INITIAL_ADMIN_ENROLLMENT_SECRET);
        const issuedCodeAllowed = !!person.enrollment_hash
          && safeEqual(await sha256Hex(enrollment_code), person.enrollment_hash);
        if (!bootstrapAllowed && !issuedCodeAllowed) {
          return json({ error: 'Enrollment could not be verified' }, { status: 403 });
        }
        const credential = await hashPin(pin);
        const statements = [
          env.DB.prepare(
            'UPDATE staff SET pin_hash = ?, pin_salt = ?, pin_set = 1, enrollment_hash = NULL WHERE id = ? AND pin_set = 0'
          ).bind(credential.hash, credential.salt, staff_id),
        ];
        if (bootstrapAllowed) {
          statements.push(env.DB.prepare(
            "INSERT INTO app_settings (key, value) VALUES ('initial_admin_enrolled', ?)"
          ).bind(new Date().toISOString()));
        }
        await env.DB.batch(statements);
        const enrolled = await env.DB.prepare('SELECT pin_set FROM staff WHERE id = ?').bind(staff_id).first();
        if (!enrolled?.pin_set) return json({ error: 'Account enrollment could not be completed' }, { status: 409 });
        const token = await createSession(env.DB, staff_id);
        return json({ ok: true }, { status: 201, headers: { 'Set-Cookie': setSessionCookie(token) } });
      }

      if (pathname === '/api/auth/login' && request.method === 'POST') {
        const body = await request.json();
        const { staff_id, pin } = body;
        if (typeof staff_id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(staff_id)) {
          return json({ error: 'Invalid staff ID or PIN' }, { status: 401 });
        }
        if (!isValidPin(pin)) return json({ error: 'PIN must be exactly 6 digits' }, { status: 400 });
        const throttle = await checkLoginThrottle(request, env.DB, staff_id);
        if (throttle.blocked) return json({ error: 'Too many sign-in attempts. Try again later.' }, { status: 429 });
        const person = await env.DB.prepare(
          'SELECT id, pin_hash, pin_salt, pin_set FROM staff WHERE id = ? AND active = 1'
        ).bind(staff_id).first();
        if (!person || !person.pin_set) {
          await recordLoginFailure(env.DB, throttle.key);
          return json({ error: 'Invalid staff ID or PIN' }, { status: 401 });
        }
        let valid = false;
        if (person.pin_salt) {
          const candidate = await hashPin(pin, person.pin_salt);
          valid = safeEqual(candidate.hash, person.pin_hash);
        } else {
          // One-time compatibility path: upgrade legacy unsalted SHA-256 PINs after successful login.
          valid = safeEqual(await sha256Hex(pin), person.pin_hash || '');
          if (valid) {
            const upgraded = await hashPin(pin);
            await env.DB.prepare('UPDATE staff SET pin_hash = ?, pin_salt = ? WHERE id = ? AND pin_salt IS NULL')
              .bind(upgraded.hash, upgraded.salt, staff_id).run();
          }
        }
        if (!valid) {
          await recordLoginFailure(env.DB, throttle.key);
          return json({ error: 'Invalid staff ID or PIN' }, { status: 401 });
        }
        await clearLoginFailures(env.DB, throttle.key);
        const token = await createSession(env.DB, staff_id);
        return json({ ok: true }, { status: 200, headers: { 'Set-Cookie': setSessionCookie(token) } });
      }

      if (pathname === '/api/auth/logout' && request.method === 'POST') {
        const cookies = parseCookies(request);
        const token = cookies[SESSION_COOKIE];
        if (token) await destroySession(env.DB, token);
        return json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie() } });
      }

      // ── Session required from here ────────────────────────────────────
      const me = await getCurrentStaff(request, env.DB);

      if (pathname === '/api/auth/me' && request.method === 'GET') {
        if (!me) return json({ error: 'Not signed in' }, { status: 401 });
        const { results: mePermissions } = await env.DB.prepare('SELECT permission FROM role_permissions WHERE role = ?').bind(me.role).all();
        const authority = await env.DB.prepare('SELECT authority_level FROM role_hierarchy WHERE role = ?').bind(me.role).first();
        return json({ ...me, permissions: mePermissions.map(row => row.permission), authority_level: authority?.authority_level ?? 0 });
      }

      if (!me) return json({ error: 'Sign in required' }, { status: 401 });

      const { results: permissionRows } = await env.DB.prepare(
        'SELECT permission FROM role_permissions WHERE role = ?'
      ).bind(me.role).all();
      const permissions = new Set(permissionRows.map(row => row.permission));
      const isAdmin = permissions.has('system.configure') && permissions.has('staff.manage');
      const isDutyOpsManager = me.role === 'duty_ops_manager';
      const isHr = me.role === 'hr';
      function requireAdmin() {
        if (!isAdmin) return json({ error: 'Administrative permission required' }, { status: 403 });
        return null;
      }
      function requireAnyPermission(...required) {
        if (!required.some(permission => permissions.has(permission))) {
          return json({ error: 'Insufficient permission' }, { status: 403 });
        }
        return null;
      }

      // ── Admin: reset another staff member's PIN ───────────────────────
      if (pathname === '/api/auth/reset-pin' && request.method === 'POST') {
        const denied = requireAdmin();
        if (denied) return denied;
        const body = await request.json();
        const { staff_id } = body;
        const target = await env.DB.prepare('SELECT id, active FROM staff WHERE id = ?').bind(staff_id).first();
        if (!target?.active) return json({ error: 'Active staff account not found' }, { status: 404 });
        const enrollmentCode = [...crypto.getRandomValues(new Uint8Array(24))]
          .map((b) => b.toString(16).padStart(2, '0')).join('');
        await env.DB.batch([
          env.DB.prepare('UPDATE staff SET pin_hash = NULL, pin_salt = NULL, pin_set = 0, enrollment_hash = ? WHERE id = ?')
            .bind(await sha256Hex(enrollmentCode), staff_id),
          env.DB.prepare('DELETE FROM sessions WHERE staff_id = ?').bind(staff_id),
        ]);
        return json({ ok: true, staff_id, enrollment_code: enrollmentCode });
      }

      // ── Departments ───────────────────────────────────────────────────
      if (pathname === '/api/departments' && request.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM departments').all();
        return json(results);
      }

      // ── Workforce administration: HR and Duty Ops workspaces ────────
      if (pathname === '/api/workforce/overview' && request.method === 'GET') {
        const denied = requireAnyPermission('staff.read', 'coverage.read');
        if (denied) return denied;
        const { results } = await env.DB.prepare(
          'SELECT id, name, department_id, role, active, pin_set FROM staff ORDER BY department_id, name'
        ).all();
        const { results: departments } = await env.DB.prepare(
          'SELECT id, name, day_min, day_max, night_min, night_max, day_code, night_code FROM departments WHERE operational_team = 1 ORDER BY id'
        ).all();
        const { results: qualifications } = await env.DB.prepare(
          'SELECT q.staff_id, q.department_id, q.can_day, q.can_night, q.priority, q.effective_from, q.effective_to, s.name AS staff_name FROM staff_department_qualifications q JOIN staff s ON s.id = q.staff_id WHERE q.effective_to IS NULL ORDER BY s.name, q.department_id'
        ).all();
        return json({ staff: results, departments, qualifications, role: me.role, authority_level: (await env.DB.prepare('SELECT authority_level FROM role_hierarchy WHERE role = ?').bind(me.role).first())?.authority_level ?? 0 });
      }

      if (pathname === '/api/workforce/qualifications' && request.method === 'GET') {
        const denied = requireAnyPermission('qualifications.manage');
        if (denied) return denied;
        const { results } = await env.DB.prepare(
          'SELECT q.*, s.name AS staff_name, d.name AS department_name FROM staff_department_qualifications q JOIN staff s ON s.id=q.staff_id JOIN departments d ON d.id=q.department_id ORDER BY s.name, d.name, q.effective_from DESC'
        ).all();
        return json(results);
      }

      if (pathname === '/api/workforce/qualifications' && request.method === 'POST') {
        const denied = requireAnyPermission('qualifications.manage');
        if (denied) return denied;
        const body = await request.json();
        if (typeof body.staff_id !== 'string' || typeof body.department_id !== 'string'
          || !['0','1',0,1,false,true].includes(body.can_day)
          || !['0','1',0,1,false,true].includes(body.can_night)
          || !/^\\d{4}-\\d{2}-\\d{2}$/.test(body.effective_from || '')) {
          return json({ error: 'Invalid qualification details' }, { status: 400 });
        }
        const staff = await env.DB.prepare('SELECT id, active FROM staff WHERE id = ?').bind(body.staff_id).first();
        const dept = await env.DB.prepare('SELECT id FROM departments WHERE id = ? AND operational_team = 1').bind(body.department_id).first();
        if (!staff?.active || !dept) return json({ error: 'Active staff and operational department are required' }, { status: 400 });
        const day = body.can_day === true || body.can_day === 1 || body.can_day === '1' ? 1 : 0;
        const night = body.can_night === true || body.can_night === 1 || body.can_night === '1' ? 1 : 0;
        if (!day && !night) return json({ error: 'At least one shift type must be enabled' }, { status: 400 });
        await env.DB.batch([
          env.DB.prepare('UPDATE staff_department_qualifications SET effective_to = ? WHERE staff_id = ? AND department_id = ? AND effective_to IS NULL').bind(new Date(Date.now()-86400000).toISOString().slice(0,10), body.staff_id, body.department_id),
          env.DB.prepare('INSERT INTO staff_department_qualifications (staff_id, department_id, can_day, can_night, priority, effective_from, approved_by, approval_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(body.staff_id, body.department_id, day, night, Number.isInteger(body.priority) ? Math.max(1, Math.min(1000, body.priority)) : 100, body.effective_from, me.id, String(body.approval_note || '').slice(0,500)),
          env.DB.prepare('INSERT INTO workforce_audit_events (actor_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?)').bind(me.id, 'qualification.updated', 'staff_qualification', body.staff_id + ':' + body.department_id, JSON.stringify({ department_id: body.department_id, can_day: day, can_night: night, effective_from: body.effective_from }))
        ]);
        return json({ ok: true }, { status: 201 });
      }

      if (pathname === '/api/workforce/duty-rota' && request.method === 'GET') {
        const denied = requireAnyPermission('coverage.read');
        if (denied) return denied;
        const month = url.searchParams.get('month');
        if (!isValidMonth(month)) return json({ error: 'Valid month is required' }, { status: 400 });
        const { results } = await env.DB.prepare(
          "SELECT r.*, s.name AS manager_name FROM duty_ops_assignments r LEFT JOIN staff s ON s.id=r.manager_staff_id WHERE r.duty_date >= ? AND r.duty_date < date(?, '+1 month') ORDER BY r.duty_date"
        ).bind(month + '-01', month + '-01').all();
        return json(results);
      }

      if (pathname === '/api/workforce/duty-rota/generate' && request.method === 'POST') {
        const denied = requireAnyPermission('coverage.allocate');
        if (denied) return denied;
        const body = await request.json();
        if (!isValidMonth(body.month)) return json({ error: 'Valid month is required' }, { status: 400 });
        const [year, monthNumber] = body.month.split('-').map(Number);
        const days = new Date(year, monthNumber, 0).getDate();
        const managers = await env.DB.prepare("SELECT id, name FROM staff WHERE active = 1 AND role = 'duty_ops_manager' ORDER BY id").all();
        if (!managers.results.length) return json({ error: 'No active Duty Ops Managers are configured' }, { status: 409 });
        const { results: leaveRows } = await env.DB.prepare("SELECT staff_id, date FROM leave_requests WHERE status = 'approved' AND date >= ? AND date < date(?, '+1 month')").bind(body.month + '-01', body.month + '-01').all();
        const { results: assignedRows } = await env.DB.prepare("SELECT a.staff_id, a.date FROM shift_assignments a JOIN schedules s ON s.id=a.schedule_id WHERE a.date >= ? AND a.date < date(?, '+1 month') AND a.shift_code NOT IN ('O','L')").bind(body.month + '-01', body.month + '-01').all();
        const leave = new Set(leaveRows.map(row => row.staff_id + ':' + row.date));
        const occupied = new Set(assignedRows.map(row => row.staff_id + ':' + row.date));
        const { results: priorRows } = await env.DB.prepare("SELECT manager_staff_id, COUNT(*) AS total FROM duty_ops_assignments WHERE duty_date < ? AND duty_date >= date(?, '-90 days') AND manager_staff_id IS NOT NULL GROUP BY manager_staff_id").bind(body.month + '-01', body.month + '-01').all();
        const counts = new Map(managers.results.map(manager => [manager.id, priorRows.find(row => row.manager_staff_id === manager.id)?.total || 0]));
        const statements = [];
        const exceptions = [];
        for (let day = 1; day <= days; day++) {
          const date = body.month + '-' + String(day).padStart(2, '0');
          const eligible = managers.results.filter(manager => !leave.has(manager.id + ':' + date) && !occupied.has(manager.id + ':' + date));
          eligible.sort((a,b) => (counts.get(a.id) - counts.get(b.id)) || a.id.localeCompare(b.id));
          const chosen = eligible[0] || null;
          if (chosen) counts.set(chosen.id, (counts.get(chosen.id) || 0) + 1);
          else exceptions.push(date);
          const id = crypto.randomUUID();
          statements.push(env.DB.prepare("INSERT INTO duty_ops_assignments (id, duty_date, manager_staff_id, assignment_type, coverage_department_id, shift_code, reason, status, created_by) VALUES (?, ?, ?, 'floating', NULL, 'MD', ?, ?, ?) ON CONFLICT(duty_date) DO UPDATE SET manager_staff_id=excluded.manager_staff_id, assignment_type='floating', coverage_department_id=NULL, reason=excluded.reason, status=excluded.status, created_by=excluded.created_by").bind(id, date, chosen?.id || null, chosen ? 'Fairness-balanced monthly rota' : 'No Duty Ops Manager available; manual resolution required', chosen ? 'assigned' : 'exception', me.id));
          statements.push(env.DB.prepare("INSERT INTO workforce_audit_events (actor_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?)").bind(me.id, chosen ? 'duty_rota.generated' : 'duty_rota.uncovered', 'duty_ops_assignment', date, JSON.stringify({ manager_staff_id: chosen?.id || null, month: body.month })));
        }
        if (statements.length) await env.DB.batch(statements);
        return json({ ok: true, month: body.month, assigned_days: days - exceptions.length, uncovered_dates: exceptions });
      }

      if (pathname === '/api/workforce/duty-rota' && request.method === 'POST') {
        const denied = requireAnyPermission('coverage.allocate');
        if (denied) return denied;
        const body = await request.json();
        if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(body.duty_date || '') || !isValidCalendarDate(body.duty_date)
          || typeof body.manager_staff_id !== 'string'
          || !['floating','team_cover'].includes(body.assignment_type || 'floating')) {
          return json({ error: 'Invalid duty assignment' }, { status: 400 });
        }
        const manager = await env.DB.prepare("SELECT id FROM staff WHERE id = ? AND active = 1 AND role = 'duty_ops_manager'").bind(body.manager_staff_id).first();
        if (!manager) return json({ error: 'An active Duty Ops Manager is required' }, { status: 400 });
        const department = body.assignment_type === 'team_cover'
          ? await env.DB.prepare("SELECT id FROM departments WHERE id = ? AND operational_team = 1").bind(body.coverage_department_id).first()
          : null;
        if (body.assignment_type === 'team_cover' && !department) return json({ error: 'A valid coverage department is required' }, { status: 400 });
        const id = crypto.randomUUID();
        await env.DB.batch([
          env.DB.prepare('INSERT INTO duty_ops_assignments (id, duty_date, manager_staff_id, assignment_type, coverage_department_id, shift_code, reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, body.duty_date, body.manager_staff_id, body.assignment_type || 'floating', department?.id || null, 'MD', String(body.reason || '').slice(0,500), me.id),
          env.DB.prepare('INSERT INTO workforce_audit_events (actor_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?)').bind(me.id, 'duty_rota.assigned', 'duty_ops_assignment', id, JSON.stringify({ duty_date: body.duty_date, manager_staff_id: body.manager_staff_id, assignment_type: body.assignment_type || 'floating', coverage_department_id: department?.id || null }))
        ]);
        return json({ id, ok: true }, { status: 201 });
      }

      if (pathname === '/api/hr/staff' && request.method === 'GET') {
        const denied = requireAnyPermission('staff.read');
        if (denied) return denied;
        const { results } = await env.DB.prepare(
          'SELECT id, name, department_id, role, active, pin_set FROM staff ORDER BY active DESC, department_id, name'
        ).all();
        return json(results);
      }

      if (pathname === '/api/hr/staff' && request.method === 'POST') {
        const denied = requireAnyPermission('staff.lifecycle');
        if (denied) return denied;
        const body = await request.json();
        if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.length > 120
          || !['ISOC','SCE'].includes(body.department_id)) return json({ error: 'Valid name and operational department are required' }, { status: 400 });
        const id = (body.id || body.name.toLowerCase().trim().replace(/\\s+/g,'-').replace(/[^a-z0-9-]/g,'')).slice(0,80);
        if (!/^[a-z0-9_-]{1,80}$/.test(id)) return json({ error: 'Invalid staff identifier' }, { status: 400 });
        await env.DB.batch([
          env.DB.prepare("INSERT INTO staff (id, name, department_id, active, role, pin_set) VALUES (?, ?, ?, 1, 'staff', 0)").bind(id, body.name.trim(), body.department_id),
          env.DB.prepare("INSERT INTO staff_shift_policies (staff_id, night_mode, max_consecutive_days, min_rest_hours, effective_from) VALUES (?, 'restricted', 5, 11, date('now'))").bind(id),
          env.DB.prepare('INSERT INTO workforce_audit_events (actor_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?)').bind(me.id, 'staff.created', 'staff', id, JSON.stringify({ department_id: body.department_id }))
        ]);
        return json({ id, ok: true }, { status: 201 });
      }

      const hrStaffMatch = pathname.match(/^\\/api\\/hr\\/staff\\/([^/]+)$/);
      if (hrStaffMatch && request.method === 'PATCH') {
        const denied = requireAnyPermission('staff.lifecycle');
        if (denied) return denied;
        const staffId = hrStaffMatch[1];
        const body = await request.json();
        const updates = [], binds = [];
        if (typeof body.name === 'string' && body.name.trim().length >= 2 && body.name.length <= 120) { updates.push('name = ?'); binds.push(body.name.trim()); }
        if (typeof body.active === 'boolean') { updates.push('active = ?'); binds.push(body.active ? 1 : 0); }
        if (!updates.length) return json({ error: 'No valid HR fields supplied' }, { status: 400 });
        binds.push(staffId);
        await env.DB.prepare('UPDATE staff SET ' + updates.join(', ') + ' WHERE id = ?').bind(...binds).run();
        if (body.active === false) await env.DB.prepare('DELETE FROM sessions WHERE staff_id = ?').bind(staffId).run();
        await env.DB.prepare('INSERT INTO workforce_audit_events (actor_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?)').bind(me.id, 'staff.hr_updated', 'staff', staffId, JSON.stringify({ name_changed: typeof body.name === 'string', active_changed: typeof body.active === 'boolean' })).run();
        return json({ ok: true });
      }

      // ── Staff ─────────────────────────────────────────────────────────
      if (pathname === '/api/staff' && request.method === 'GET') {
        const requestedDept = url.searchParams.get('department');
        if (isAdmin && url.searchParams.get('all') === '1') {
          const { results } = await env.DB.prepare('SELECT id, name, department_id, role, pin_set FROM staff WHERE active = 1 ORDER BY department_id, name').all();
          return json(results);
        }
        const dept = isAdmin ? requestedDept : me.department_id;
        if (dept) {
          const { results } = await env.DB.prepare(
            "SELECT DISTINCT s.id, s.name, s.department_id, s.role, s.pin_set FROM staff s JOIN staff_department_qualifications q ON q.staff_id=s.id WHERE q.department_id = ? AND s.active=1 AND q.effective_from <= date('now') AND (q.effective_to IS NULL OR q.effective_to >= date('now')) ORDER BY s.name"
          ).bind(dept).all();
          return json(results);
        }
        const { results } = await env.DB.prepare('SELECT id, name, department_id, role, pin_set FROM staff WHERE active = 1 ORDER BY department_id, name').all();
        return json(results);
      }

      if (pathname === '/api/staff' && request.method === 'POST') {
        const denied = requireAdmin();
        if (denied) return denied;
        const body = await request.json();
        if (!body.name || !body.department_id) {
          return json({ error: 'name and department_id are required' }, { status: 400 });
        }
        const id = body.id || body.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        const role = ['admin', 'duty_ops_manager', 'hr', 'technical_assistant', 'staff'].includes(body.role) ? body.role : 'staff';
        if (!['ISOC','SCE','ROC','HR'].includes(body.department_id)) return json({ error: 'Unknown department' }, { status: 400 });
        await env.DB.batch([
          env.DB.prepare('INSERT INTO staff (id, name, department_id, active, role, pin_set) VALUES (?, ?, ?, 1, ?, 0)').bind(id, body.name, body.department_id, role),
          env.DB.prepare("INSERT INTO staff_shift_policies (staff_id, night_mode, max_consecutive_days, min_rest_hours, effective_from) VALUES (?, 'restricted', 5, 11, date('now'))").bind(id),
          env.DB.prepare('INSERT INTO workforce_audit_events (actor_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?)').bind(me.id, 'staff.created', 'staff', id, JSON.stringify({ department_id: body.department_id, role }))
        ]);
        return json({ id, name: body.name, department_id: body.department_id, role }, { status: 201 });
      }

      const staffIdMatch = pathname.match(/^\/api\/staff\/([^/]+)$/);
      if (staffIdMatch) {
        const staffId = staffIdMatch[1];
        if (request.method === 'GET') {
          const s = await env.DB.prepare(
            'SELECT id, name, department_id, role, pin_set FROM staff WHERE id = ? AND active = 1'
          ).bind(staffId).first();
          if (!s || (!isAdmin && s.department_id !== me.department_id)) {
            return json({ error: 'Not found' }, { status: 404 });
          }
          return json(s);
        }
        if (request.method === 'PATCH') {
          const denied = requireAdmin();
          if (denied) return denied;
          const body = await request.json();
          const updates = [];
          const binds = [];
          if (body.name) { updates.push('name = ?'); binds.push(body.name); }
          if (body.role && ['admin', 'duty_ops_manager', 'hr', 'technical_assistant', 'staff'].includes(body.role)) {
            updates.push('role = ?'); binds.push(body.role);
          }
          if (updates.length === 0) return json({ error: 'Nothing to update' }, { status: 400 });
          binds.push(staffId);
          await env.DB.prepare(`UPDATE staff SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();
          return json({ updated: true });
        }
        if (request.method === 'DELETE') {
          const denied = requireAdmin();
          if (denied) return denied;
          if (staffId === me.id) return json({ error: 'Cannot deactivate your own account' }, { status: 400 });
          await env.DB.prepare('UPDATE staff SET active = 0 WHERE id = ?').bind(staffId).run();
          await env.DB.prepare('DELETE FROM sessions WHERE staff_id = ?').bind(staffId).run();
          return json({ deactivated: true });
        }
      }

      // ── Leave ─────────────────────────────────────────────────────────
      if (pathname === '/api/leave' && request.method === 'GET') {
        const staffId = url.searchParams.get('staff_id');
        const month   = url.searchParams.get('month');
        // Non-admins can see their own leave
        const effectiveStaffId = isAdmin ? staffId : me.id;
        let query = 'SELECT * FROM leave_requests WHERE 1=1';
        const binds = [];
        if (effectiveStaffId) { query += ' AND staff_id = ?'; binds.push(effectiveStaffId); }
        if (month) { query += ' AND date LIKE ?'; binds.push(`${month}-%`); }
        const { results } = await env.DB.prepare(query).bind(...binds).all();
        return json(results);
      }

      if (pathname === '/api/leave' && request.method === 'POST') {
        const denied = requireAdmin();
        if (denied) return denied;
        const body = await request.json();
        if (typeof body.staff_id !== 'string' || !isValidCalendarDate(body.date)) {
          return json({ error: 'A valid staff_id and YYYY-MM-DD date are required' }, { status: 400 });
        }
        if (body.status !== undefined && !['approved', 'pending'].includes(body.status)) {
          return json({ error: 'status must be approved or pending' }, { status: 400 });
        }
        const target = await env.DB.prepare('SELECT id FROM staff WHERE id = ? AND active = 1').bind(body.staff_id).first();
        if (!target) return json({ error: 'Active staff account not found' }, { status: 404 });
        const id = uuid();
        await env.DB.prepare(
          'INSERT INTO leave_requests (id, staff_id, date, status) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(staff_id, date) DO UPDATE SET status = excluded.status'
        ).bind(id, body.staff_id, body.date, body.status || 'approved').run();
        return json({ id, ...body }, { status: 201 });
      }

      if (pathname.startsWith('/api/leave/') && request.method === 'DELETE') {
        const denied = requireAdmin();
        if (denied) return denied;
        const id = pathname.split('/').pop();
        await env.DB.prepare('DELETE FROM leave_requests WHERE id = ?').bind(id).run();
        return json({ deleted: true });
      }

      // ── Swap requests ─────────────────────────────────────────────────
      if (pathname === '/api/swap-requests' && request.method === 'GET') {
        const month = url.searchParams.get('month');
        let query = `
          SELECT sr.*, sf.name as from_name, st.name as to_name
          FROM swap_requests sr
          JOIN staff sf ON sf.id = sr.from_staff_id
          JOIN staff st ON st.id = sr.to_staff_id
          WHERE 1=1
        `;
        const binds = [];
        if (!isAdmin) {
          query += ' AND (sr.from_staff_id = ? OR sr.to_staff_id = ?)';
          binds.push(me.id, me.id);
        }
        if (month) { query += ' AND sr.date LIKE ?'; binds.push(`${month}-%`); }
        query += ' ORDER BY sr.created_at DESC';
        const { results } = await env.DB.prepare(query).bind(...binds).all();
        return json(results);
      }

      if (pathname === '/api/swap-requests' && request.method === 'POST') {
        const body = await request.json();
        const { to_staff_id, date, shift_code } = body;
        // from_staff_id is always the requester
        if (typeof to_staff_id !== 'string' || to_staff_id === me.id || !isValidCalendarDate(date)) {
          return json({ error: 'A different recipient and valid YYYY-MM-DD date are required' }, { status: 400 });
        }
        const department = await env.DB.prepare('SELECT day_code, night_code FROM departments WHERE id = ?')
          .bind(me.department_id).first();
        if (!department || ![department.day_code, department.night_code].includes(shift_code)) {
          return json({ error: 'The requested shift code is not valid for your department' }, { status: 400 });
        }
        const recipient = await env.DB.prepare(
          'SELECT id FROM staff WHERE id = ? AND active = 1 AND department_id = ?'
        ).bind(to_staff_id, me.department_id).first();
        if (!recipient) return json({ error: 'Recipient must be active in your department' }, { status: 404 });
        const draft = await env.DB.prepare(
          "SELECT id FROM schedules WHERE month = ? AND department_id = ? AND status = 'draft' ORDER BY generated_at DESC LIMIT 1"
        ).bind(date.slice(0, 7), me.department_id).first();
        if (!draft) return json({ error: 'No editable draft schedule exists for this date' }, { status: 409 });
        const [fromAssignment, toAssignment] = await Promise.all([
          env.DB.prepare('SELECT shift_code FROM shift_assignments WHERE schedule_id = ? AND staff_id = ? AND date = ?')
            .bind(draft.id, me.id, date).first(),
          env.DB.prepare('SELECT shift_code FROM shift_assignments WHERE schedule_id = ? AND staff_id = ? AND date = ?')
            .bind(draft.id, to_staff_id, date).first(),
        ]);
        if (!fromAssignment || !toAssignment || fromAssignment.shift_code !== shift_code
          || ![department.day_code, department.night_code, 'O'].includes(toAssignment.shift_code)) {
          return json({ error: 'The selected staff assignments are not eligible for this swap' }, { status: 409 });
        }
        const id = uuid();
        await env.DB.prepare(
          'INSERT INTO swap_requests (id, from_staff_id, to_staff_id, date, shift_code, status, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, me.id, to_staff_id, date, shift_code, 'pending', new Date().toISOString()).run();
        return json({ id, status: 'pending' }, { status: 201 });
      }

      const swapMatch = pathname.match(/^\/api\/swap-requests\/([^/]+)$/);
      if (swapMatch) {
        const swapId = swapMatch[1];
        if (request.method === 'PATCH') {
          const denied = requireAdmin();
          if (denied) return denied;
          const { action } = await request.json();
          if (!['approve', 'reject'].includes(action)) {
            return json({ error: 'action must be approve or reject' }, { status: 400 });
          }
          const swap = await env.DB.prepare('SELECT * FROM swap_requests WHERE id = ?').bind(swapId).first();
          if (!swap) return json({ error: 'Swap request not found' }, { status: 404 });
          if (swap.status !== 'pending') return json({ error: 'Only pending swap requests can be reviewed' }, { status: 409 });
          if (action === 'approve' && !isValidCalendarDate(swap.date)) {
            return json({ error: 'Swap request contains an invalid date and cannot be approved' }, { status: 409 });
          }
          if (action === 'reject') {
            const result = await env.DB.prepare("UPDATE swap_requests SET status = 'rejected' WHERE id = ? AND status = 'pending'").bind(swapId).run();
            if (!result.meta?.changes) return json({ error: 'Request state changed; reload and retry' }, { status: 409 });
            return json({ updated: true, status: 'rejected' });
          }

          const [fromStaff, toStaff] = await Promise.all([
            env.DB.prepare('SELECT id, department_id, active FROM staff WHERE id = ?').bind(swap.from_staff_id).first(),
            env.DB.prepare('SELECT id, department_id, active FROM staff WHERE id = ?').bind(swap.to_staff_id).first(),
          ]);
          if (!fromStaff?.active || !toStaff?.active || fromStaff.department_id !== toStaff.department_id) {
            return json({ error: 'Both staff members must be active in the same department' }, { status: 409 });
          }
          const month = swap.date.slice(0, 7);
          const schedule = await env.DB.prepare(
            "SELECT id FROM schedules WHERE month = ? AND department_id = ? AND status = 'draft' ORDER BY generated_at DESC LIMIT 1"
          ).bind(month, fromStaff.department_id).first();
          if (!schedule) return json({ error: 'No editable draft schedule exists for this date; generate a draft before approving the swap' }, { status: 409 });
          const [fromAssignment, toAssignment] = await Promise.all([
            env.DB.prepare('SELECT id, shift_code FROM shift_assignments WHERE schedule_id = ? AND staff_id = ? AND date = ?').bind(schedule.id, swap.from_staff_id, swap.date).first(),
            env.DB.prepare('SELECT id, shift_code FROM shift_assignments WHERE schedule_id = ? AND staff_id = ? AND date = ?').bind(schedule.id, swap.to_staff_id, swap.date).first(),
          ]);
          if (!fromAssignment || !toAssignment || fromAssignment.shift_code !== swap.shift_code) {
            return json({ error: 'The requested assignments have changed; refresh the roster and submit a new request' }, { status: 409 });
          }
          // Re-check draft state, request state and the exact pre-swap values in
          // the write transaction. A schedule can be published after the reads
          // above; no approval may mutate a published schedule.
          await env.DB.batch([
            env.DB.prepare(
              `UPDATE shift_assignments SET shift_code = ?, is_manual_override = 1
               WHERE id = ? AND schedule_id = ? AND shift_code = ?
                 AND EXISTS (SELECT 1 FROM schedules WHERE id = ? AND status = 'draft')
                 AND EXISTS (SELECT 1 FROM swap_requests WHERE id = ? AND status = 'pending')`
            ).bind(toAssignment.shift_code, fromAssignment.id, schedule.id, fromAssignment.shift_code, schedule.id, swapId),
            env.DB.prepare(
              `UPDATE shift_assignments SET shift_code = ?, is_manual_override = 1
               WHERE id = ? AND schedule_id = ? AND shift_code = ?
                 AND EXISTS (SELECT 1 FROM schedules WHERE id = ? AND status = 'draft')
                 AND EXISTS (SELECT 1 FROM swap_requests WHERE id = ? AND status = 'pending')`
            ).bind(fromAssignment.shift_code, toAssignment.id, schedule.id, toAssignment.shift_code, schedule.id, swapId),
            env.DB.prepare(
              `UPDATE swap_requests SET status = 'approved'
               WHERE id = ? AND status = 'pending'
                 AND EXISTS (SELECT 1 FROM schedules WHERE id = ? AND status = 'draft')
                 AND EXISTS (SELECT 1 FROM shift_assignments WHERE id = ? AND schedule_id = ? AND shift_code = ?)
                 AND EXISTS (SELECT 1 FROM shift_assignments WHERE id = ? AND schedule_id = ? AND shift_code = ?)`
            ).bind(swapId, schedule.id, fromAssignment.id, schedule.id, toAssignment.shift_code,
              toAssignment.id, schedule.id, fromAssignment.shift_code),
          ]);
          const confirmed = await env.DB.prepare("SELECT status FROM swap_requests WHERE id = ?").bind(swapId).first();
          if (confirmed?.status !== 'approved') return json({ error: 'Swap could not be committed; reload and retry' }, { status: 409 });
          return json({ updated: true, status: 'approved', schedule_id: schedule.id });
        }
        if (request.method === 'DELETE') {
          const swap = await env.DB.prepare('SELECT * FROM swap_requests WHERE id = ?').bind(swapId).first();
          if (!swap) return json({ error: 'Not found' }, { status: 404 });
          if (swap.from_staff_id !== me.id && !isAdmin) {
            return json({ error: 'Cannot cancel another staff member\'s request' }, { status: 403 });
          }
          // Completed/rejected requests are audit records and cannot be removed.
          const removed = await env.DB.prepare(
            "DELETE FROM swap_requests WHERE id = ? AND status = 'pending'"
          ).bind(swapId).run();
          if (!removed.meta?.changes) {
            return json({ error: 'Only pending swap requests can be cancelled' }, { status: 409 });
          }
          return json({ deleted: true });
        }
      }

      // ── Generate schedule ─────────────────────────────────────────────
      if (pathname === '/api/schedules/generate' && request.method === 'POST') {
        const denied = requireAdmin();
        if (denied) return denied;

        const body = await request.json();
        const { month, department_id } = body;
        if (!isValidMonth(month) || typeof department_id !== 'string' || !department_id) {
          return json({ error: 'A valid YYYY-MM month and department_id are required' }, { status: 400 });
        }

        const dept = await env.DB.prepare('SELECT * FROM departments WHERE id = ?')
          .bind(department_id).first();
        if (!dept) return json({ error: 'Unknown department' }, { status: 404 });

        const { results: staffRows } = await env.DB.prepare(
          "SELECT DISTINCT s.id, s.name, q.can_day, CASE WHEN COALESCE(p.night_mode,'allowed')='allowed' THEN q.can_night ELSE 0 END AS can_night, COALESCE(p.max_consecutive_days,5) AS max_consecutive_days FROM staff s JOIN staff_department_qualifications q ON q.staff_id=s.id LEFT JOIN staff_shift_policies p ON p.staff_id=s.id WHERE q.department_id = ? AND s.active = 1 AND q.effective_from <= ? AND (q.effective_to IS NULL OR q.effective_to >= ?) ORDER BY s.name"
        ).bind(department_id, month + '-31', month + '-01').all();

        if (staffRows.length === 0) {
          return json({ error: 'No active staff in this department' }, { status: 400 });
        }

        const { results: leaveRows } = await env.DB.prepare(
          `SELECT staff_id, date FROM leave_requests
           WHERE date LIKE ? AND staff_id IN (${staffRows.map(() => '?').join(',')})
           AND status = 'approved'`
        ).bind(`${month}-%`, ...staffRows.map(s => s.id)).all();

        const leaveByStaff = {};
        for (const s of staffRows) leaveByStaff[s.id] = new Set();
        for (const row of leaveRows) leaveByStaff[row.staff_id].add(row.date);

        const priorFinalState = await getPriorFinalState(env.DB, month, department_id, staffRows, dept);

        const { assignments, warnings, totals } = generateSchedule({
          month, department: dept, staff: staffRows, leaveByStaff, priorFinalState,
        });

        const scheduleId = uuid();
        const now = new Date().toISOString();
        const warningText = warnings.length
          ? `Warnings: ${warnings.join(' | ')}`
          : 'No coverage warnings.';

        await env.DB.prepare(
          'INSERT INTO schedules (id, month, department_id, generated_at, status, notes) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(scheduleId, month, department_id, now, 'draft', warningText).run();

        const inserts = [];
        for (const s of staffRows) {
          for (let d = 1; d <= daysInMonth(month); d++) {
            const ds = dateStr(month, d);
            inserts.push(
              env.DB.prepare(
                'INSERT INTO shift_assignments (id, schedule_id, staff_id, date, shift_code, is_manual_override) VALUES (?, ?, ?, ?, ?, 0)'
              ).bind(uuid(), scheduleId, s.id, ds, assignments[s.id][ds])
            );
          }
        }
        await env.DB.batch(inserts);

        return json({ schedule_id: scheduleId, month, department_id, assignments, totals, warnings }, { status: 201 });
      }

      // ── List schedules (BUG FIX: now supports ?department= filter) ────
      if (pathname === '/api/schedules' && request.method === 'GET') {
        const month = url.searchParams.get('month');
        const dept  = url.searchParams.get('department');
        let query = 'SELECT * FROM schedules WHERE 1=1';
        const binds = [];
        if (month) { query += ' AND month = ?'; binds.push(month); }
        if (isAdmin) {
          if (dept) { query += ' AND department_id = ?'; binds.push(dept); }
        } else {
          query += ' AND department_id = ?';
          binds.push(me.department_id);
        }
        query += ' ORDER BY generated_at DESC';
        const { results } = await env.DB.prepare(query).bind(...binds).all();
        return json(results);
      }

      // ── My schedule ───────────────────────────────────────────────────
      const mineMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/mine$/);
      if (mineMatch && request.method === 'GET') {
        const id = mineMatch[1];
        const schedule = await env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(id).first();
        const qualification = schedule ? await env.DB.prepare(
          "SELECT 1 AS eligible FROM staff_department_qualifications WHERE staff_id = ? AND department_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) LIMIT 1"
        ).bind(me.id, schedule.department_id, schedule.month + '-31', schedule.month + '-01').first() : null;
        if (!schedule || (schedule.department_id !== me.department_id && !qualification)) {
          return json({ error: 'Not found' }, { status: 404 });
        }

        const dept = await env.DB.prepare('SELECT * FROM departments WHERE id = ?')
          .bind(me.department_id).first();

        const { results: assignments } = await env.DB.prepare(
          `SELECT sa.staff_id, st.name AS staff_name, sa.date, sa.shift_code
           FROM shift_assignments sa
           JOIN staff st ON st.id = sa.staff_id
           JOIN staff_department_qualifications q ON q.staff_id = st.id AND q.department_id = ?
           WHERE sa.schedule_id = ? AND q.effective_from <= ? AND (q.effective_to IS NULL OR q.effective_to >= ?)
           ORDER BY sa.date, st.name`
        ).bind(schedule.department_id, id, schedule.month + '-31', schedule.month + '-01').all();

        const myShifts = {};
        for (const row of assignments) {
          if (row.staff_id === me.id) myShifts[row.date] = row.shift_code;
        }

        const workingCodes = new Set([dept.day_code, dept.night_code]);
        const coworkersByDate = {};
        for (const date of Object.keys(myShifts)) {
          const myCode = myShifts[date];
          if (!workingCodes.has(myCode)) continue;
          coworkersByDate[date] = assignments
            .filter(r => r.date === date && r.shift_code === myCode && r.staff_id !== me.id)
            .map(r => r.staff_name);
        }

        return json({
          schedule_id: id,
          month: schedule.month,
          status: schedule.status,
          department_id: me.department_id,
          day_code: dept.day_code,
          night_code: dept.night_code,
          my_shifts: myShifts,
          coworkers_by_date: coworkersByDate,
        });
      }

      // ── Single schedule ───────────────────────────────────────────────
      const scheduleMatch = pathname.match(/^\/api\/schedules\/([^/]+)$/);
      if (scheduleMatch && request.method === 'GET') {
        const id = scheduleMatch[1];
        const schedule = await env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(id).first();
        if (!schedule) return json({ error: 'Not found' }, { status: 404 });
        if (!isAdmin && schedule.department_id !== me.department_id) {
          return json({ error: 'Schedule not found' }, { status: 404 });
        }

        const { results: assignments } = await env.DB.prepare(
          `SELECT sa.staff_id, st.name AS staff_name, st.department_id, sa.date, sa.shift_code, sa.is_manual_override
           FROM shift_assignments sa
           JOIN staff st ON st.id = sa.staff_id
           WHERE sa.schedule_id = ?
           ORDER BY st.department_id, st.name, sa.date`
        ).bind(id).all();

        return json({ ...schedule, assignments });
      }

      // ── Patch assignment (BUG FIX: validates staff is in correct dept) ─
      const patchMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/assignment$/);
      if (patchMatch && request.method === 'PATCH') {
        const denied = requireAdmin();
        if (denied) return denied;

        const scheduleId = patchMatch[1];
        const targetSchedule = await env.DB.prepare(
          'SELECT id, status, month, department_id FROM schedules WHERE id = ?'
        ).bind(scheduleId).first();
        if (!targetSchedule) return json({ error: 'Schedule not found' }, { status: 404 });
        if (targetSchedule.status !== 'draft') {
          return json({ error: 'Only draft schedules are editable. Create a new draft version to make changes.' }, { status: 409 });
        }
        const body = await request.json();
        const { staff_id, date, shift_code } = body;

        if (typeof staff_id !== 'string' || !isValidCalendarDate(date) || !shift_code
          || date.slice(0, 7) !== targetSchedule.month) {
          return json({ error: 'staff_id, a valid date in the schedule month, and shift_code are required' }, { status: 400 });
        }

        const department = await env.DB.prepare(
          'SELECT day_code, night_code FROM departments WHERE id = ?'
        ).bind(targetSchedule.department_id).first();
        const validCodes = department
          ? [department.day_code, department.night_code, 'O', 'L']
          : [];
        if (!validCodes.includes(shift_code)) {
          return json({ error: 'Shift code is not valid for this department' }, { status: 400 });
        }

        // Confirm the staff member belongs to the schedule's department.
        const existing = await env.DB.prepare(
          `SELECT sa.id FROM shift_assignments sa
           JOIN staff st ON st.id = sa.staff_id
           WHERE sa.schedule_id = ? AND sa.staff_id = ? AND sa.date = ?
             AND st.department_id = ?`
        ).bind(scheduleId, staff_id, date, targetSchedule.department_id).first();
        if (!existing) return json({ error: 'Assignment not found' }, { status: 404 });

        const update = await env.DB.prepare(
          `UPDATE shift_assignments
           SET shift_code = ?, is_manual_override = 1
           WHERE schedule_id = ? AND staff_id = ? AND date = ?
             AND EXISTS (SELECT 1 FROM schedules WHERE id = ? AND status = 'draft')`
        ).bind(shift_code, scheduleId, staff_id, date, scheduleId).run();
        if (!update.meta?.changes) {
          return json({ error: 'Schedule is no longer editable; reload before making changes' }, { status: 409 });
        }

        return json({ updated: true });
      }

      // ── Publish ───────────────────────────────────────────────────────
      const publishMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/publish$/);
      if (publishMatch && request.method === 'POST') {
        const denied = requireAdmin();
        if (denied) return denied;
        const id = publishMatch[1];
        const schedule = await env.DB.prepare('SELECT id, status FROM schedules WHERE id = ?').bind(id).first();
        if (!schedule) return json({ error: 'Schedule not found' }, { status: 404 });
        if (schedule.status === 'published') return json({ error: 'Schedule is already published' }, { status: 409 });
        const result = await env.DB.prepare("UPDATE schedules SET status = 'published' WHERE id = ? AND status = 'draft'").bind(id).run();
        if (!result.meta?.changes) return json({ error: 'Schedule state changed; reload and retry' }, { status: 409 });
        return json({ published: true });
      }

      // ── Export CSV ────────────────────────────────────────────────────
      const exportMatch = pathname.match(/^\/api\/schedules\/([^/]+)\/export$/);
      if (exportMatch && request.method === 'GET') {
        const id = exportMatch[1];
        const schedule = await env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(id).first();
        if (!schedule) return json({ error: 'Not found' }, { status: 404 });
        if (!isAdmin && schedule.department_id !== me.department_id) {
          return json({ error: 'Schedule not found' }, { status: 404 });
        }

        const { results: assignments } = await env.DB.prepare(
          `SELECT sa.staff_id, st.name AS staff_name, st.department_id, sa.date, sa.shift_code
           FROM shift_assignments sa
           JOIN staff st ON st.id = sa.staff_id
           WHERE sa.schedule_id = ?
           ORDER BY st.department_id, st.name, sa.date`
        ).bind(id).all();

        const csv = buildCsv(assignments, schedule.month);
        return new Response(csv, {
          headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': `attachment; filename="roc_schedule_${schedule.month}_${schedule.department_id || 'all'}.csv"`,
          },
        });
      }

      return json({ error: 'Not found' }, { status: 404 });

    } catch (err) {
      console.error(err);
      // In production, don't leak stack traces
      return json({
        error: env.ENVIRONMENT === 'development' ? (err.message || 'Internal server error') : 'Internal server error',
        ...(env.ENVIRONMENT === 'development' ? { stack: err.stack } : {}),
      }, { status: 500 });
    }
  },
};


async function checkLoginThrottle(request, db, staffId) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = await sha256Hex(`${staffId.toLowerCase()}:${ip}`);
  const row = await db.prepare('SELECT blocked_until FROM auth_attempts WHERE attempt_key = ?').bind(key).first();
  return { key, blocked: Number(row?.blocked_until || 0) > Date.now() };
}

async function recordLoginFailure(db, key) {
  const now = Date.now();
  const windowStart = now - 15 * 60 * 1000;
  const blockedUntil = now + 15 * 60 * 1000;
  await db.prepare(`
    INSERT INTO auth_attempts (attempt_key, window_started_at, attempts, blocked_until)
    VALUES (?, ?, 1, NULL)
    ON CONFLICT(attempt_key) DO UPDATE SET
      attempts = CASE WHEN auth_attempts.window_started_at <= ? THEN 1 ELSE auth_attempts.attempts + 1 END,
      window_started_at = CASE WHEN auth_attempts.window_started_at <= ? THEN ? ELSE auth_attempts.window_started_at END,
      blocked_until = CASE
        WHEN (CASE WHEN auth_attempts.window_started_at <= ? THEN 1 ELSE auth_attempts.attempts + 1 END) >= 5
        THEN ? ELSE auth_attempts.blocked_until END
  `).bind(key, now, windowStart, windowStart, now, windowStart, blockedUntil).run();
}

async function clearLoginFailures(db, key) {
  await db.prepare('DELETE FROM auth_attempts WHERE attempt_key = ?').bind(key).run();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getPriorFinalState(db, month, departmentId, staffRows, dept) {
  const [y, m] = month.split('-').map(Number);
  const prevDate  = new Date(y, m - 2, 1);
  const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

  const prevSchedule = await db.prepare(
    "SELECT id FROM schedules WHERE month = ? AND department_id = ? AND status = 'published' ORDER BY generated_at DESC LIMIT 1"
  ).bind(prevMonth, departmentId).first();
  if (!prevSchedule) return null;

  const prevDaysCount = daysInMonth(prevMonth);
  const lastDate = dateStr(prevMonth, prevDaysCount);

  const priorFinalState = {};
  for (const s of staffRows) {
    const { results } = await db.prepare(
      'SELECT date, shift_code FROM shift_assignments WHERE schedule_id = ? AND staff_id = ? AND date <= ? ORDER BY date DESC LIMIT 6'
    ).bind(prevSchedule.id, s.id, lastDate).all();
    if (results.length === 0) continue;

    const lastCode = results[0].shift_code;
    let consecutiveWork = 0;
    for (const r of results) {
      if (r.shift_code === dept.day_code || r.shift_code === dept.night_code) consecutiveWork++;
      else break;
    }
    priorFinalState[s.id] = {
      // Store as type strings; solver.js maps back to codes on use
      lastShift: lastCode === dept.night_code ? 'night' : lastCode === dept.day_code ? 'day' : null,
      consecutiveWork,
    };
  }
  return priorFinalState;
}

