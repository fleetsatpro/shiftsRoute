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
        let enrollmentStage = 'parse_request';
        let enrollmentStaffId = null;
        try {
        const body = await request.json();
        enrollmentStaffId = typeof body.staff_id === 'string' ? body.staff_id : null;
        enrollmentStage = 'validate_and_lookup';
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
        enrollmentStage = 'derive_pin_credential';
        const credential = await hashPin(pin);
        enrollmentStage = 'persist_pin_and_bootstrap_latch';
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
        enrollmentStage = 'verify_persisted_credential';
        const enrolled = await env.DB.prepare('SELECT pin_set FROM staff WHERE id = ?').bind(staff_id).first();
        if (!enrolled?.pin_set) return json({ error: 'Account enrollment could not be completed' }, { status: 409 });
        enrollmentStage = 'create_authenticated_session';
        const token = await createSession(env.DB, staff_id);
        return json({ ok: true }, { status: 201, headers: { 'Set-Cookie': setSessionCookie(token) } });
        } catch (error) {
          console.error(JSON.stringify({
            event: 'auth.enrollment.failed',
            stage: enrollmentStage,
            staff_id: enrollmentStaffId,
            error_name: error instanceof Error ? error.name : 'UnknownError',
            error_message: error instanceof Error ? error.message : String(error),
          }));
          return json({ error: 'Enrollment could not be completed. Please retry or contact Duty Ops.' }, { status: 503 });
        }
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
      const isHr = permissions.has('staff.lifecycle');
      const canManageLeave = permissions.has('leave.manage');
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
      async function validateReliefAssignment(input, ignoreId = null, verifyShortage = false) {
        const { staff_id, duty_date, target_department_id, shift_code } = input;
        const display_code = input.display_code || shift_code;
        if (typeof staff_id !== 'string' || !isValidCalendarDate(duty_date)
          || typeof target_department_id !== 'string'
          || typeof input.reason !== 'string' || input.reason.trim().length < 12 || input.reason.length > 1000) {
          return { ok: false, status: 400, error: 'Staff, date, target team, shift and a detailed operational reason are required' };
        }
        if (!['D','N','DC','NC'].includes(shift_code) || !['D','N','DC','NC','FSA'].includes(display_code)
          || (display_code !== 'FSA' && display_code !== shift_code)) {
          return { ok: false, status: 400, error: 'Use the target desk shift code; FSA is reserved for an approved Field Supervisor deployment' };
        }
        const targetDepartment = await env.DB.prepare(
          'SELECT id, day_code, night_code, day_min, night_min, night_rest_rule FROM departments WHERE id = ? AND operational_team = 1'
        ).bind(target_department_id).first();
        if (!targetDepartment || ![targetDepartment.day_code, targetDepartment.night_code].includes(shift_code)) {
          return { ok: false, status: 400, error: 'The selected shift code does not belong to the target desk' };
        }
        const person = await env.DB.prepare(
          'SELECT s.id, s.name, s.department_id, s.active, d.night_rest_rule AS home_night_rest_rule ' +
          'FROM staff s LEFT JOIN departments d ON d.id=s.department_id WHERE s.id = ?'
        ).bind(staff_id).first();
        if (!person?.active) return { ok: false, status: 404, error: 'Active employee not found' };
        if (person.department_id === target_department_id) {
          return { ok: false, status: 409, error: 'This is the employee’s home desk; use the normal roster allocation instead of cross-team relief' };
        }
        const homeRotationCode = ['ISOC','SCE'].includes(person.department_id)
          ? await getRotationCodeForDate(staff_id, person.department_id, duty_date) : null;
        if (homeRotationCode && homeRotationCode !== 'O') {
          return { ok: false, status: 409, error: 'The employee is scheduled for a home-desk rotation on this date and cannot be cross-deployed' };
        }
        const homeDepartment = await env.DB.prepare(
          'SELECT operational_team FROM departments WHERE id = ?'
        ).bind(person.department_id).first();
        const fieldDesignation = await env.DB.prepare(
          'SELECT designation,relief_capable FROM workforce_staff_designations WHERE staff_id = ?'
        ).bind(staff_id).first();
        const isFieldSupervisor = fieldDesignation?.designation === 'Field Supervisor' && fieldDesignation.relief_capable === 1;
        if (!homeDepartment?.operational_team && !isFieldSupervisor) {
          return { ok: false, status: 409, error: 'Only a verified controller or formally designated Field Supervisor can receive cross-desk relief' };
        }
        if (homeDepartment?.operational_team) {
          const homeQualification = await env.DB.prepare(
            'SELECT 1 AS qualified FROM staff_department_qualifications WHERE staff_id=? AND department_id=? ' +
            'AND relief_only=0 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) LIMIT 1'
          ).bind(staff_id, person.department_id, duty_date, duty_date).first();
          if (!homeQualification) {
            return { ok: false, status: 409, error: 'The employee must have a current verified home-team qualification before cross-desk relief can be used' };
          }
        }
        if (isFieldSupervisor && display_code !== 'FSA') {
          return { ok: false, status: 400, error: 'Field Supervisor deployments must use the FSA display code' };
        }
        const qualification = await env.DB.prepare(
          'SELECT can_day, can_night, relief_only FROM staff_department_qualifications ' +
          'WHERE staff_id = ? AND department_id = ? AND effective_from <= ? ' +
          'AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from DESC LIMIT 1'
        ).bind(staff_id, target_department_id, duty_date, duty_date).first();
        if (!qualification || qualification.relief_only !== 1) {
          return { ok: false, status: 409, error: 'No effective relief-only qualification exists for this employee and desk' };
        }
        const isNight = shift_code === targetDepartment.night_code;
        if (isNight ? qualification.can_night !== 1 : qualification.can_day !== 1) {
          return { ok: false, status: 409, error: 'The employee is not qualified for that shift type on the target desk' };
        }
        if (display_code === 'FSA' && !isFieldSupervisor) {
          return { ok: false, status: 409, error: 'FSA display is restricted to an authorised Field Supervisor' };
        }
        const policy = await env.DB.prepare(
          'SELECT night_mode FROM staff_shift_policies WHERE staff_id = ?'
        ).bind(staff_id).first();
        if (isNight && policy?.night_mode && policy.night_mode !== 'allowed') {
          const exception = policy.night_mode === 'exception_only'
            ? await env.DB.prepare(
                "SELECT id FROM workforce_shift_exceptions WHERE staff_id = ? AND date = ? AND shift_code = ? AND status = 'approved'"
              ).bind(staff_id, duty_date, shift_code).first()
            : null;
          if (!exception) return { ok: false, status: 409, error: 'Night work is not permitted without the separately approved date-specific exception' };
        }
        const leave = await env.DB.prepare(
          "SELECT id FROM leave_requests WHERE staff_id = ? AND date = ? AND status IN ('pending','approved')"
        ).bind(staff_id, duty_date).first();
        if (leave) return { ok: false, status: 409, error: 'The employee has approved leave on this date' };
        const training = await env.DB.prepare(
          "SELECT id FROM workforce_staff_markers WHERE staff_id = ? AND date = ? AND marker_code = 'T' AND status = 'approved'"
        ).bind(staff_id, duty_date).first();
        if (training) return { ok: false, status: 409, error: 'The employee is marked as a trainee on this date' };
        const pendingOrApproved = await env.DB.prepare(
          "SELECT id FROM workforce_relief_assignments WHERE staff_id = ? AND duty_date = ? AND status IN ('pending','approved')"
        ).bind(staff_id, duty_date).first();
        if (pendingOrApproved && pendingOrApproved.id !== ignoreId) {
          return { ok: false, status: 409, error: 'This employee already has a pending or approved deployment on this date' };
        }
        const existing = await env.DB.prepare(
          'SELECT sa.shift_code, sa.coverage_department_id, sa.coverage_shift_code ' +
          'FROM shift_assignments sa JOIN schedules sc ON sc.id = sa.schedule_id ' +
          'WHERE sa.staff_id = ? AND sa.date = ? AND sc.month = ? ' +
          'AND sc.id = (SELECT latest.id FROM schedules latest WHERE latest.month = sc.month ' +
          'AND latest.department_id = sc.department_id ORDER BY latest.generated_at DESC LIMIT 1)'
        ).bind(staff_id, duty_date, duty_date.slice(0, 7)).all();
        for (const assignment of existing.results || []) {
          const isRestOrLeave = ['O','L','PL','ML','SL'].includes(assignment.shift_code);
          const sameReliefMirror = assignment.coverage_department_id === target_department_id
            && assignment.coverage_shift_code === shift_code;
          if (!isRestOrLeave && !sameReliefMirror) {
            return { ok: false, status: 409, error: 'The employee is already rostered for another assignment on this date; resolve the existing roster before approving relief' };
          }
        }
        // Relief is one real workday across the whole employee, not a separate
        // allocation universe for each desk. Inspect the latest schedules in
        // both teams around the proposed date before allowing a deployment.
        const [personPolicy, neighbouringAssignments] = await Promise.all([
          env.DB.prepare('SELECT max_consecutive_days, min_rest_hours FROM staff_shift_policies WHERE staff_id=?')
            .bind(staff_id).first(),
          env.DB.prepare(
            'SELECT DISTINCT sa.date,sa.shift_code,sa.coverage_shift_code,sc.department_id ' +
            'FROM shift_assignments sa JOIN schedules sc ON sc.id=sa.schedule_id ' +
            "WHERE sa.staff_id=? AND sa.date BETWEEN date(?,'-7 days') AND date(?,'+1 day') " +
            "AND sc.id=(SELECT latest.id FROM schedules latest WHERE latest.month=sc.month " +
            'AND latest.department_id=sc.department_id ORDER BY latest.generated_at DESC LIMIT 1) ' +
            "AND sa.shift_code NOT IN ('O','L','PL','ML','SL') ORDER BY sa.date,sc.department_id"
          ).bind(staff_id, duty_date, duty_date).all(),
        ]);
        const policyMax = Number(personPolicy?.max_consecutive_days || 5);
        const adjacentWorkDates = new Set((neighbouringAssignments.results || []).map(row => row.date));
        adjacentWorkDates.add(duty_date);
        const previousDay = new Date(Date.parse(duty_date + 'T00:00:00Z') - 86400000);
        const nextDay = new Date(Date.parse(duty_date + 'T00:00:00Z') + 86400000);
        let beforeStreak = 0;
        for (let offset = 1; offset <= 7; offset++) {
          const date = new Date(Date.parse(duty_date + 'T00:00:00Z') - offset * 86400000).toISOString().slice(0,10);
          if (!adjacentWorkDates.has(date)) break;
          beforeStreak++;
        }
        let afterStreak = 0;
        for (let offset = 1; offset <= 7; offset++) {
          const date = new Date(Date.parse(duty_date + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0,10);
          if (!adjacentWorkDates.has(date)) break;
          afterStreak++;
        }
        if (beforeStreak + 1 + afterStreak > policyMax) {
          return { ok: false, status: 409, error: 'This deployment would exceed the employee’s maximum consecutive work-day limit across both desks' };
        }
        const enforceNightRest = targetDepartment.night_rest_rule === 1 || person.home_night_rest_rule === 1;
        if (enforceNightRest) {
          const previousCalendarDate = previousDay.toISOString().slice(0,10);
          const nextCalendarDate = nextDay.toISOString().slice(0,10);
          const yesterdayCodes = (neighbouringAssignments.results || [])
            .filter(row => row.date === previousCalendarDate)
            .map(row => row.coverage_shift_code || row.shift_code);
          const tomorrowCodes = (neighbouringAssignments.results || [])
            .filter(row => row.date === nextCalendarDate)
            .map(row => row.coverage_shift_code || row.shift_code);
          const previousWasNight = yesterdayCodes.some(code => ['N','NC'].includes(code));
          const nextIsDay = tomorrowCodes.some(code => ['D','DC'].includes(code));
          if ((shift_code === targetDepartment.day_code && previousWasNight)
            || (shift_code === targetDepartment.night_code && nextIsDay)) {
            return { ok: false, status: 409, error: 'This deployment would violate the configured night-to-day recovery rule across desks' };
          }
        }

        let shortage = null;
        if (verifyShortage) {
          const baseline = await env.DB.prepare(
            'SELECT id FROM schedules WHERE month=? AND department_id=? ORDER BY generated_at DESC LIMIT 1'
          ).bind(duty_date.slice(0,7), target_department_id).first();
          if (!baseline) {
            return { ok: false, status: 409, error: 'Generate the receiving desk roster first so an actual coverage shortage can be verified' };
          }
          const count = await env.DB.prepare(
            "SELECT COUNT(*) AS covered FROM shift_assignments WHERE schedule_id=? AND date=? " +
            "AND ((coverage_department_id=? AND coverage_shift_code=?) OR (coverage_department_id IS NULL AND shift_code=?)) " +
            "AND shift_code NOT IN ('O','L','PL','ML','SL')"
          ).bind(baseline.id, duty_date, target_department_id, shift_code, shift_code).first();
          const scheduled = Number(count?.covered || 0);
          const planned = await env.DB.prepare(
            "SELECT COUNT(*) AS planned FROM workforce_relief_assignments r " +
            "WHERE r.target_department_id=? AND r.duty_date=? AND r.shift_code=? " +
            "AND r.status IN ('pending','approved') AND r.id != COALESCE(?, '') " +
            "AND NOT EXISTS (SELECT 1 FROM shift_assignments sa WHERE sa.schedule_id=? " +
            "AND sa.staff_id=r.staff_id AND sa.date=r.duty_date " +
            "AND sa.coverage_department_id=r.target_department_id AND sa.coverage_shift_code=r.shift_code)"
          ).bind(target_department_id, duty_date, shift_code, ignoreId, baseline.id).first();
          const covered = scheduled + Number(planned?.planned || 0);
          const minimum = Number(isNight ? targetDepartment.night_min : targetDepartment.day_min);
          if (!Number.isFinite(minimum) || covered >= minimum) {
            return { ok: false, status: 409, error: 'The receiving desk already meets its minimum for this shift, including other pending/approved relief; cross-team relief is not justified' };
          }
          shortage = { covered, minimum };
        }
        return { ok: true, person, qualification, targetDepartment, display_code, shortage };
      }

      async function getRotationCodeForDate(staffId, departmentId, date) {
        const pattern = await env.DB.prepare(
          "SELECT cycle_codes_json,anchor_date FROM workforce_rotation_patterns " +
          "WHERE staff_id=? AND department_id=? AND effective_from<=? " +
          "AND (effective_to IS NULL OR effective_to>=?) ORDER BY effective_from DESC LIMIT 1"
        ).bind(staffId, departmentId, date, date).first();
        if (!pattern) return null;
        let cycle;
        try { cycle = JSON.parse(pattern.cycle_codes_json); } catch { return null; }
        if (!Array.isArray(cycle) || !cycle.length) return null;
        const offset = Math.floor((Date.parse(date+'T00:00:00Z') - Date.parse(pattern.anchor_date+'T00:00:00Z')) / 86400000);
        return cycle[((offset % cycle.length) + cycle.length) % cycle.length] || null;
      }

      // ── Admin: reset another staff member's PIN ───────────────────────
      if (pathname === '/api/auth/reset-pin' && request.method === 'POST') {
        const denied = requireAdmin();
        if (denied) return denied;
        const body = await request.json();
        const { staff_id } = body;
        const target = await env.DB.prepare('SELECT id, active, role FROM staff WHERE id = ?').bind(staff_id).first();
        if (!target?.active) return json({ error: 'Active staff account not found' }, { status: 404 });
        const targetAuthority = await env.DB.prepare('SELECT authority_level FROM role_hierarchy WHERE role = ?').bind(target.role).first();
        const actorAuthority = await env.DB.prepare('SELECT authority_level FROM role_hierarchy WHERE role = ?').bind(me.role).first();
        if (me.role !== 'admin' && (targetAuthority?.authority_level ?? 0) >= (actorAuthority?.authority_level ?? 0)) return json({ error: 'You cannot reset credentials at or above your authority level' }, { status: 403 });
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
          'SELECT id, name, department_id, role, active, pin_set, employment_end_date FROM staff ORDER BY department_id, name'
        ).all();
        const { results: departments } = await env.DB.prepare(
          'SELECT id, name, day_min, day_max, night_min, night_max, day_code, night_code FROM departments WHERE operational_team = 1 ORDER BY id'
        ).all();
        const { results: qualifications } = await env.DB.prepare(
          'SELECT q.staff_id, q.department_id, q.can_day, q.can_night, q.priority, q.relief_only, q.effective_from, q.effective_to, s.name AS staff_name, ' +
          'd.designation, COALESCE(d.relief_capable,0) AS relief_capable ' +
          'FROM staff_department_qualifications q JOIN staff s ON s.id = q.staff_id ' +
          'LEFT JOIN workforce_staff_designations d ON d.staff_id = s.id ' +
          'WHERE q.effective_to IS NULL ORDER BY s.name, q.department_id'
        ).all();
        return json({ staff: results, departments, qualifications, role: me.role, authority_level: (await env.DB.prepare('SELECT authority_level FROM role_hierarchy WHERE role = ?').bind(me.role).first())?.authority_level ?? 0 });
      }

      if (pathname === '/api/workforce/policies' && request.method === 'GET') {
        const denied = requireAnyPermission('qualifications.manage');
        if (denied) return denied;
        const { results } = await env.DB.prepare(
          'SELECT p.*, s.name AS staff_name FROM staff_shift_policies p JOIN staff s ON s.id=p.staff_id ORDER BY s.name'
        ).all();
        return json(results);
      }

      if (pathname === '/api/workforce/policies' && request.method === 'POST') {
        const denied = requireAnyPermission('qualifications.manage');
        if (denied) return denied;
        const body = await request.json();
        if (typeof body.staff_id !== 'string' || !['allowed','restricted','exception_only','prohibited'].includes(body.night_mode)
          || !Number.isInteger(body.max_consecutive_days) || body.max_consecutive_days < 1 || body.max_consecutive_days > 7
          || !Number.isInteger(body.min_rest_hours) || body.min_rest_hours < 8 || body.min_rest_hours > 24) {
          return json({ error: 'Invalid shift policy values' }, { status: 400 });
        }
        const target = await env.DB.prepare('SELECT id, active, role FROM staff WHERE id = ?').bind(body.staff_id).first();
        if (!target?.active) return json({ error: 'Active employee not found' }, { status: 404 });
        if (target.role === 'technical_assistant' && body.night_mode === 'allowed') return json({ error: 'Technical Assistant night work must remain emergency-exception-only' }, { status: 409 });
        await env.DB.batch([
          env.DB.prepare("INSERT INTO staff_shift_policies (staff_id, night_mode, max_consecutive_days, min_rest_hours, effective_from, updated_by, updated_at) VALUES (?, ?, ?, ?, date('now'), ?, ?) ON CONFLICT(staff_id) DO UPDATE SET night_mode=excluded.night_mode, max_consecutive_days=excluded.max_consecutive_days, min_rest_hours=excluded.min_rest_hours, effective_from=excluded.effective_from, updated_by=excluded.updated_by, updated_at=excluded.updated_at").bind(body.staff_id, body.night_mode, body.max_consecutive_days, body.min_rest_hours, me.id, new Date().toISOString()),
          env.DB.prepare('INSERT INTO workforce_audit_events (actor_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?)').bind(me.id, 'shift_policy.updated', 'staff_shift_policy', body.staff_id, JSON.stringify({ night_mode: body.night_mode, max_consecutive_days: body.max_consecutive_days, min_rest_hours: body.min_rest_hours }))
        ]);
        return json({ ok: true });
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
        const staff = await env.DB.prepare('SELECT id, active, role, department_id FROM staff WHERE id = ?').bind(body.staff_id).first();
        const dept = await env.DB.prepare('SELECT id FROM departments WHERE id = ? AND operational_team = 1').bind(body.department_id).first();
        if (!staff?.active || !dept) return json({ error: 'Active staff and operational department are required' }, { status: 400 });
        const day = body.can_day === true || body.can_day === 1 || body.can_day === '1' ? 1 : 0;
        const night = body.can_night === true || body.can_night === 1 || body.can_night === '1' ? 1 : 0;
        if (!day && !night) return json({ error: 'At least one shift type must be enabled' }, { status: 400 });
        const policy = await env.DB.prepare('SELECT night_mode FROM staff_shift_policies WHERE staff_id = ?').bind(body.staff_id).first();
        if (staff.department_id !== body.department_id && staff.role !== 'duty_ops_manager') {
          const [homeQualification, designation] = await Promise.all([
            env.DB.prepare(
              'SELECT 1 AS qualified FROM staff_department_qualifications WHERE staff_id=? AND department_id=? ' +
              'AND relief_only=0 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) LIMIT 1'
            ).bind(body.staff_id, staff.department_id, body.effective_from, body.effective_from).first(),
            env.DB.prepare(
              'SELECT designation,relief_capable FROM workforce_staff_designations WHERE staff_id=?'
            ).bind(body.staff_id).first()
          ]);
          const isFieldSupervisor = designation?.designation === 'Field Supervisor' && designation.relief_capable === 1;
          if (!homeQualification && !isFieldSupervisor) {
            return json({ error: 'Verify the employee’s home-team qualification before recording cross-desk relief eligibility' }, { status: 409 });
          }
        }
        if (night && staff.role === 'duty_ops_manager') return json({ error: 'Duty Ops Manager operational assignments remain day-only' }, { status: 409 });
        if (night && staff.role === 'technical_assistant' && policy?.night_mode !== 'exception_only') {
          return json({ error: 'Technical Assistant night qualification requires the emergency-exception-only policy' }, { status: 409 });
        }
        // Every cross-desk qualification is relief-only. The Duty Ops Manager
        // exception is explicit: their separate, locked day-cover rota is not
        // treated as general controller relief.
        const reliefOnly = staff.department_id !== body.department_id && staff.role !== 'duty_ops_manager' ? 1 : 0;
        const existing = await env.DB.prepare(
          'SELECT effective_from FROM staff_department_qualifications WHERE staff_id=? AND department_id=? AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1'
        ).bind(body.staff_id, body.department_id).first();
        if (existing && body.effective_from < existing.effective_from) {
          return json({ error: 'A new qualification cannot begin before the current effective record; use a prospective effective date' }, { status: 409 });
        }
        const priority = Number.isInteger(body.priority) ? Math.max(1, Math.min(1000, body.priority)) : 100;
        const approvalNote = String(body.approval_note || '').slice(0,500);
        const statements = [];
        if (existing && body.effective_from === existing.effective_from) {
          statements.push(env.DB.prepare(
            'UPDATE staff_department_qualifications SET can_day=?, can_night=?, priority=?, relief_only=?, approved_by=?, approval_note=? WHERE staff_id=? AND department_id=? AND effective_from=?'
          ).bind(day, night, priority, reliefOnly, me.id, approvalNote, body.staff_id, body.department_id, existing.effective_from));
        } else {
          if (existing) statements.push(env.DB.prepare(
            "UPDATE staff_department_qualifications SET effective_to=date(?,'-1 day') WHERE staff_id=? AND department_id=? AND effective_to IS NULL"
          ).bind(body.effective_from, body.staff_id, body.department_id));
          statements.push(env.DB.prepare(
            'INSERT INTO staff_department_qualifications (staff_id,department_id,can_day,can_night,priority,effective_from,approved_by,approval_note,relief_only) VALUES (?,?,?,?,?,?,?,?,?)'
          ).bind(body.staff_id, body.department_id, day, night, priority, body.effective_from, me.id, approvalNote, reliefOnly));
        }
        statements.push(env.DB.prepare(
          'INSERT INTO workforce_audit_events (actor_id,action,entity_type,entity_id,details_json) VALUES (?,?,?,?,?)'
        ).bind(me.id, 'qualification.updated', 'staff_qualification', body.staff_id + ':' + body.department_id,
          JSON.stringify({ department_id: body.department_id, can_day: day, can_night: night, relief_only: reliefOnly, effective_from: body.effective_from })));
        if (staff.department_id === 'SCE' && body.department_id === 'SCE') {
          // A newly verified SCE home-desk qualification automatically grants
          // matching day/night eligibility for ISOC relief, never routine cover.
          const crossExisting = await env.DB.prepare(
            'SELECT effective_from FROM staff_department_qualifications WHERE staff_id=? AND department_id=? AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1'
          ).bind(body.staff_id, 'ISOC').first();
          if (crossExisting && body.effective_from < crossExisting.effective_from) {
            return json({ error: 'The mirrored ISOC relief qualification cannot be backdated before its current effective record' }, { status: 409 });
          }
          if (crossExisting && body.effective_from === crossExisting.effective_from) {
            statements.push(env.DB.prepare(
              'UPDATE staff_department_qualifications SET can_day=?, can_night=?, priority=?, relief_only=1, approved_by=?, approval_note=? WHERE staff_id=? AND department_id=? AND effective_from=?'
            ).bind(day, night, priority, me.id,
              'SCE qualification mirrored to ISOC as emergency relief only: ' + approvalNote,
              body.staff_id, 'ISOC', crossExisting.effective_from));
          } else {
            if (crossExisting) statements.push(env.DB.prepare(
              "UPDATE staff_department_qualifications SET effective_to=date(?,'-1 day') WHERE staff_id=? AND department_id=? AND effective_to IS NULL"
            ).bind(body.effective_from, body.staff_id, 'ISOC'));
            statements.push(env.DB.prepare(
              'INSERT INTO staff_department_qualifications (staff_id,department_id,can_day,can_night,priority,effective_from,approved_by,approval_note,relief_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)'
            ).bind(body.staff_id, 'ISOC', day, night, Math.min(950, priority),
              body.effective_from, me.id,
              'SCE qualification mirrored to ISOC as emergency relief only: ' + approvalNote));
          }
          statements.push(env.DB.prepare(
            'INSERT INTO workforce_audit_events (actor_id,action,entity_type,entity_id,details_json) VALUES (?,?,?,?,?)'
          ).bind(me.id, 'qualification.relief_mirrored', 'staff_qualification',
            body.staff_id + ':ISOC',
            JSON.stringify({ source_department_id: 'SCE', can_day: day, can_night: night, relief_only: 1, effective_from: body.effective_from })));
        }
        await env.DB.batch(statements);
        return json({ ok: true }, { status: 201 });
      }


      if (pathname === '/api/workforce/relief-assignments' && request.method === 'GET') {
        const denied = requireAnyPermission('coverage.read');
        if (denied) return denied;
        const month = url.searchParams.get('month');
        if (!isValidMonth(month)) return json({ error: 'Valid month is required' }, { status: 400 });
        const { results } = await env.DB.prepare(
          'SELECT r.*, s.name AS staff_name, s.department_id AS home_department_id, ' +
          'd.name AS target_department_name, a.name AS requester_name, v.name AS reviewer_name ' +
          'FROM workforce_relief_assignments r JOIN staff s ON s.id=r.staff_id ' +
          'JOIN departments d ON d.id=r.target_department_id JOIN staff a ON a.id=r.requested_by ' +
          'LEFT JOIN staff v ON v.id=r.reviewed_by WHERE r.duty_date LIKE ? ORDER BY r.duty_date,r.created_at'
        ).bind(month + '-%').all();
        return json(results);
      }

      if (pathname === '/api/workforce/relief-assignments' && request.method === 'POST') {
        const denied = requireAnyPermission('coverage.allocate');
        if (denied) return denied;
        const body = await request.json();
        const checked = await validateReliefAssignment(body, null, true);
        if (!checked.ok) return json({ error: checked.error }, { status: checked.status });
        const id = uuid();
        try {
          await env.DB.batch([
            env.DB.prepare(
              "INSERT INTO workforce_relief_assignments (id,staff_id,duty_date,target_department_id,shift_code,display_code,reason,status,requested_by,shortage_count_at_request,minimum_required,shortage_confirmed_at) VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?)"
            ).bind(id, body.staff_id, body.duty_date, body.target_department_id, body.shift_code, checked.display_code, body.reason.trim(), me.id,
              checked.shortage.covered, checked.shortage.minimum, new Date().toISOString()),
            env.DB.prepare(
              "INSERT INTO workforce_audit_events (actor_id,action,entity_type,entity_id,details_json) VALUES (?,'relief.requested','workforce_relief_assignment',?,?)"
            ).bind(me.id, id, JSON.stringify({ staff_id: body.staff_id, duty_date: body.duty_date, target_department_id: body.target_department_id, shift_code: body.shift_code, display_code: checked.display_code }))
          ]);
        } catch (error) {
          const message = String(error?.message || error);
          if (/unique|conflict|shortage|leave|training|rostered|deployment/i.test(message)) {
            return json({ error: 'The relief request conflicts with availability, another assignment or the remaining staffing shortage. Refresh the roster and review the date.' }, { status: 409 });
          }
          throw error;
        }
        return json({ id, status: 'pending' }, { status: 201 });
      }

      const reliefMatch = pathname.match(/^\/api\/workforce\/relief-assignments\/([^/]+)$/);
      if (reliefMatch && request.method === 'PATCH') {
        const denied = requireAnyPermission('exceptions.approve');
        if (denied) return denied;
        const body = await request.json();
        if (!['approved','rejected'].includes(body.status)) return json({ error: 'status must be approved or rejected' }, { status: 400 });
        const relief = await env.DB.prepare(
          'SELECT * FROM workforce_relief_assignments WHERE id = ?'
        ).bind(reliefMatch[1]).first();
        if (!relief) return json({ error: 'Relief request not found' }, { status: 404 });
        if (relief.status !== 'pending') return json({ error: 'Only pending relief requests can be reviewed' }, { status: 409 });
        if (relief.requested_by === me.id) return json({ error: 'A requester cannot approve their own relief deployment' }, { status: 403 });
        let checkedShortage = null;
        if (body.status === 'approved') {
          const checked = await validateReliefAssignment({
            staff_id: relief.staff_id, duty_date: relief.duty_date,
            target_department_id: relief.target_department_id, shift_code: relief.shift_code,
            display_code: relief.display_code, reason: relief.reason,
          }, relief.id, true);
          if (!checked.ok) return json({ error: 'Relief can no longer be approved: ' + checked.error }, { status: 409 });
          checkedShortage = checked.shortage;
        }
        let updated;
        try {
          updated = await env.DB.prepare(
            "UPDATE workforce_relief_assignments SET status = ?, reviewed_by = ?, reviewed_at = ?, shortage_count_at_request = ?, minimum_required = ?, shortage_confirmed_at = ? WHERE id = ? AND status = 'pending'"
          ).bind(body.status, me.id, new Date().toISOString(),
            checkedShortage?.covered ?? relief.shortage_count_at_request,
            checkedShortage?.minimum ?? relief.minimum_required,
            checkedShortage ? new Date().toISOString() : relief.shortage_confirmed_at,
            relief.id).run();
        } catch (error) {
          const message = String(error?.message || error);
          if (/unique|conflict|shortage|leave|training|rostered|deployment/i.test(message)) {
            return json({ error: 'Relief can no longer be approved because availability, another assignment or remaining desk capacity changed. Review the roster and submit a new request.' }, { status: 409 });
          }
          throw error;
        }
        if (!updated.meta?.changes) return json({ error: 'Relief request changed; refresh and retry' }, { status: 409 });
        await env.DB.prepare(
          'INSERT INTO workforce_audit_events (actor_id,action,entity_type,entity_id,details_json) VALUES (?,?,?,?,?)'
        ).bind(me.id, 'relief.' + body.status, 'workforce_relief_assignment', relief.id,
          JSON.stringify({ staff_id: relief.staff_id, duty_date: relief.duty_date, target_department_id: relief.target_department_id, shift_code: relief.shift_code })).run();
        return json({ ok: true, status: body.status });
      }

      if (pathname === '/api/workforce/rotation-patterns' && request.method === 'GET') {
        const denied = requireAnyPermission('qualifications.manage');
        if (denied) return denied;
        const month = url.searchParams.get('month');
        if (!isValidMonth(month)) return json({ error: 'Valid month is required' }, { status: 400 });
        const { results } = await env.DB.prepare(
          'SELECT rp.*,s.name AS staff_name,d.name AS department_name ' +
          'FROM workforce_rotation_patterns rp JOIN staff s ON s.id=rp.staff_id ' +
          'JOIN departments d ON d.id=rp.department_id ' +
          'WHERE rp.effective_from<=? AND (rp.effective_to IS NULL OR rp.effective_to>=?) ' +
          'ORDER BY d.name,s.name,rp.effective_from'
        ).bind(month+'-31',month+'-01').all();
        return json(results.map(row => {
          let cycle_codes = [];
          try { cycle_codes = JSON.parse(row.cycle_codes_json); } catch {}
          return { ...row, cycle_codes };
        }));
      }

      if (pathname === '/api/workforce/rotation-patterns' && request.method === 'POST') {
        const denied = requireAnyPermission('qualifications.manage');
        if (denied) return denied;
        const body = await request.json();
        if (typeof body.staff_id !== 'string' || typeof body.department_id !== 'string'
          || !isValidCalendarDate(body.effective_from) || !isValidCalendarDate(body.anchor_date)
          || !Array.isArray(body.cycle_codes) || body.cycle_codes.length < 1 || body.cycle_codes.length > 28) {
          return json({ error: 'Select an employee and desk, provide valid effective/anchor dates and a 1–28 day rotation cycle' }, { status: 400 });
        }
        const effectiveFrom = body.effective_from;
        if (effectiveFrom < new Date().toISOString().slice(0,10)) {
          return json({ error: 'Rotation changes are prospective; do not rewrite historical schedules' }, { status: 409 });
        }
        const [person, department, qualification, policy] = await Promise.all([
          env.DB.prepare('SELECT id,name,department_id,active,role FROM staff WHERE id=?').bind(body.staff_id).first(),
          env.DB.prepare('SELECT id,day_code,night_code FROM departments WHERE id=? AND operational_team=1').bind(body.department_id).first(),
          env.DB.prepare(
            'SELECT can_day,can_night,relief_only,effective_from,effective_to FROM staff_department_qualifications ' +
            'WHERE staff_id=? AND department_id=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ' +
            'ORDER BY effective_from DESC LIMIT 1'
          ).bind(body.staff_id,body.department_id,effectiveFrom,effectiveFrom).first(),
          env.DB.prepare('SELECT night_mode,max_consecutive_days FROM staff_shift_policies WHERE staff_id=?').bind(body.staff_id).first(),
        ]);
        if (!person?.active || person.department_id !== body.department_id || person.role === 'duty_ops_manager') {
          return json({ error: 'A rotation pattern can only be assigned to active primary staff on their home operational desk' }, { status: 409 });
        }
        if (!department || !qualification || qualification.relief_only === 1) {
          return json({ error: 'An effective primary desk qualification is required before setting a rotation' }, { status: 409 });
        }
        const allowedCodes = new Set([department.day_code,department.night_code,'O']);
        if (body.cycle_codes.some(code => typeof code !== 'string' || !allowedCodes.has(code))) {
          return json({ error: 'Use only this desk’s day code, night code and O (Off) in the rotation cycle' }, { status: 400 });
        }
        if (body.cycle_codes.includes(department.day_code) && qualification.can_day !== 1) {
          return json({ error: 'The employee is not qualified for day shifts on this desk' }, { status: 409 });
        }
        if (body.cycle_codes.includes(department.night_code)
          && (qualification.can_night !== 1 || (policy?.night_mode && policy.night_mode !== 'allowed'))) {
          return json({ error: 'The employee is not approved for recurring night shifts under the current policy; use the separate emergency exception process where permitted' }, { status: 409 });
        }
        const maximum = Number(policy?.max_consecutive_days || 5);
        let run = 0, previousType = null;
        for (const code of [...body.cycle_codes,...body.cycle_codes]) {
          if (code === 'O') { run = 0; previousType = null; continue; }
          const type = code === department.night_code ? 'night' : 'day';
          if (type === 'day' && previousType === 'night') {
            return json({ error: 'Rotation cycle must include recovery time between night and day duty' }, { status: 409 });
          }
          run++;
          if (run > maximum) return json({ error: 'Rotation cycle exceeds this employee’s consecutive-work limit' }, { status: 409 });
          previousType = type;
        }
        const existing = await env.DB.prepare(
          'SELECT id,effective_from FROM workforce_rotation_patterns WHERE staff_id=? AND department_id=? AND effective_to IS NULL ORDER BY effective_from DESC LIMIT 1'
        ).bind(body.staff_id,body.department_id).first();
        if (existing && effectiveFrom < existing.effective_from) {
          return json({ error: 'A rotation change cannot be backdated before the current effective pattern' }, { status: 409 });
        }
        const patternId = existing?.effective_from === effectiveFrom ? existing.id : uuid();
        const statements = [];
        if (existing && existing.effective_from === effectiveFrom) {
          statements.push(env.DB.prepare(
            'UPDATE workforce_rotation_patterns SET anchor_date=?,cycle_codes_json=?,created_by=?,created_at=CURRENT_TIMESTAMP WHERE id=?'
          ).bind(body.anchor_date,JSON.stringify(body.cycle_codes),me.id,patternId));
        } else {
          if (existing) statements.push(env.DB.prepare(
            "UPDATE workforce_rotation_patterns SET effective_to=date(?,'-1 day') WHERE id=?"
          ).bind(effectiveFrom,existing.id));
          statements.push(env.DB.prepare(
            'INSERT INTO workforce_rotation_patterns (id,staff_id,department_id,effective_from,anchor_date,cycle_codes_json,created_by) VALUES (?,?,?,?,?,?,?)'
          ).bind(patternId,body.staff_id,body.department_id,effectiveFrom,body.anchor_date,JSON.stringify(body.cycle_codes),me.id));
        }
        statements.push(env.DB.prepare(
          'INSERT INTO workforce_audit_events (actor_id,action,entity_type,entity_id,details_json) VALUES (?,?,?,?,?)'
        ).bind(me.id,'rotation_pattern.updated','staff_rotation_pattern',patternId,
          JSON.stringify({ staff_id:body.staff_id,department_id:body.department_id,effective_from:effectiveFrom,anchor_date:body.anchor_date,cycle_codes:body.cycle_codes })));
        await env.DB.batch(statements);
        return json({ id:patternId,status:'saved',staff_id:body.staff_id,department_id:body.department_id,effective_from:effectiveFrom,anchor_date:body.anchor_date,cycle_codes:body.cycle_codes },{status:201});
      }

      if (pathname === '/api/workforce/staff-markers' && request.method === 'GET') {
        const denied = requireAnyPermission('qualifications.manage');
        if (denied) return denied;
        const month = url.searchParams.get('month');
        if (!isValidMonth(month)) return json({ error: 'Valid month is required' }, { status: 400 });
        const { results } = await env.DB.prepare(
          "SELECT m.*, s.name AS staff_name FROM workforce_staff_markers m JOIN staff s ON s.id=m.staff_id WHERE m.date LIKE ? AND m.status='approved' ORDER BY m.date,s.name"
        ).bind(month + '-%').all();
        return json(results);
      }

      if (pathname === '/api/workforce/staff-markers' && request.method === 'POST') {
        const denied = requireAnyPermission('qualifications.manage');
        if (denied) return denied;
        const body = await request.json();
        if (typeof body.staff_id !== 'string' || !isValidCalendarDate(body.date)
          || body.marker_code !== 'T' || typeof body.reason !== 'string'
          || body.reason.trim().length < 12 || body.reason.length > 1000) {
          return json({ error: 'A valid employee, trainee date and detailed training note are required' }, { status: 400 });
        }
        const target = await env.DB.prepare('SELECT id, active, department_id FROM staff WHERE id = ?').bind(body.staff_id).first();
        if (!target?.active) return json({ error: 'Active employee not found' }, { status: 404 });
        const plannedRotation = ['ISOC','SCE'].includes(target.department_id)
          ? await getRotationCodeForDate(body.staff_id, target.department_id, body.date) : null;
        if (plannedRotation && plannedRotation !== 'O') {
          return json({ error: 'The employee has a scheduled home-desk rotation on this date; record training only on an available/off day or resolve the roster first' }, { status: 409 });
        }
        const [leave, relief, schedule] = await Promise.all([
          env.DB.prepare("SELECT id FROM leave_requests WHERE staff_id=? AND date=? AND status IN ('pending','approved')").bind(body.staff_id, body.date).first(),
          env.DB.prepare("SELECT id FROM workforce_relief_assignments WHERE staff_id=? AND duty_date=? AND status IN ('pending','approved')").bind(body.staff_id, body.date).first(),
          env.DB.prepare(
            'SELECT sa.shift_code FROM shift_assignments sa JOIN schedules sc ON sc.id=sa.schedule_id ' +
            'WHERE sa.staff_id=? AND sa.date=? AND sc.id=(SELECT latest.id FROM schedules latest ' +
            'WHERE latest.month=sc.month AND latest.department_id=sc.department_id ORDER BY latest.generated_at DESC LIMIT 1)'
          ).bind(body.staff_id, body.date).first()
        ]);
        if (leave || relief || (schedule && !['O','L','PL','ML','SL'].includes(schedule.shift_code))) {
          return json({ error: 'Training cannot overlap approved leave, active relief or an existing rostered shift' }, { status: 409 });
        }
        const id = uuid();
        try {
          await env.DB.batch([
            env.DB.prepare(
              "INSERT INTO workforce_staff_markers (id,staff_id,date,marker_code,reason,status,created_by) VALUES (?,?,?,'T',?,'approved',?)"
            ).bind(id, body.staff_id, body.date, body.reason.trim(), me.id),
            env.DB.prepare(
              "INSERT INTO workforce_audit_events (actor_id,action,entity_type,entity_id,details_json) VALUES (?,'training.recorded','staff_schedule_marker',?,?)"
            ).bind(me.id, id, JSON.stringify({ staff_id: body.staff_id, date: body.date, marker_code: 'T' }))
          ]);
        } catch (error) {
          const message = String(error?.message || error);
          if (/unique|conflict|leave|relief|rostered|assignment/i.test(message)) {
            return json({ error: 'Training conflicts with existing leave, relief or rostered work. Refresh the roster and select an available date.' }, { status: 409 });
          }
          throw error;
        }
        return json({ id, status: 'approved', marker_code: 'T' }, { status: 201 });
      }

      if (pathname === '/api/workforce/shift-exceptions' && request.method === 'GET') {
        const denied = requireAnyPermission('exceptions.review');
        if (denied) return denied;
        const month = url.searchParams.get('month');
        if (!isValidMonth(month)) return json({ error: 'Valid month is required' }, { status: 400 });
        const { results } = await env.DB.prepare(
          'SELECT e.*, s.name AS staff_name, r.name AS requester_name, v.name AS reviewer_name FROM workforce_shift_exceptions e JOIN staff s ON s.id=e.staff_id JOIN staff r ON r.id=e.requested_by LEFT JOIN staff v ON v.id=e.reviewed_by WHERE e.date LIKE ? ORDER BY e.date, e.created_at'
        ).bind(month + '-%').all();
        return json(results);
      }

      if (pathname === '/api/workforce/shift-exceptions' && request.method === 'POST') {
        const denied = requireAnyPermission('exceptions.request');
        if (denied) return denied;
        const body = await request.json();
        if (typeof body.staff_id !== 'string' || !isValidCalendarDate(body.date)
          || typeof body.reason !== 'string' || body.reason.trim().length < 12 || body.reason.length > 1000
          || !['N','NC'].includes(body.shift_code)) return json({ error: 'A valid employee, date, night shift code and detailed emergency reason are required' }, { status: 400 });
        const target = await env.DB.prepare('SELECT id, active FROM staff WHERE id = ?').bind(body.staff_id).first();
        const policy = await env.DB.prepare('SELECT night_mode FROM staff_shift_policies WHERE staff_id = ?').bind(body.staff_id).first();
        if (!target?.active || policy?.night_mode !== 'exception_only') return json({ error: 'This employee is not configured for emergency-only night work' }, { status: 409 });
        const id = crypto.randomUUID();
        await env.DB.batch([
          env.DB.prepare("INSERT INTO workforce_shift_exceptions (id, staff_id, date, shift_code, reason, status, requested_by) VALUES (?, ?, ?, ?, ?, 'pending', ?)").bind(id, body.staff_id, body.date, body.shift_code, body.reason.trim(), me.id),
          env.DB.prepare("INSERT INTO workforce_audit_events (actor_id, action, entity_type, entity_id, details_json) VALUES (?, 'shift_exception.requested', 'shift_exception', ?, ?)").bind(me.id, id, JSON.stringify({ staff_id: body.staff_id, date: body.date, shift_code: body.shift_code }))
        ]);
        return json({ id, status: 'pending' }, { status: 201 });
      }

      const exceptionMatch = pathname.match(/^\/api\/workforce\/shift-exceptions\/([^/]+)$/);
      if (exceptionMatch && request.method === 'PATCH') {
        const denied = requireAnyPermission('exceptions.approve');
        if (denied) return denied;
        const body = await request.json();
        if (!['approved','rejected'].includes(body.status)) return json({ error: 'status must be approved or rejected' }, { status: 400 });
        const exception = await env.DB.prepare('SELECT * FROM workforce_shift_exceptions WHERE id = ?').bind(exceptionMatch[1]).first();
        if (!exception) return json({ error: 'Exception not found' }, { status: 404 });
        if (exception.status !== 'pending') return json({ error: 'Only pending exceptions can be reviewed' }, { status: 409 });
        if (exception.requested_by === me.id) return json({ error: 'A requester cannot approve their own emergency exception' }, { status: 403 });
        await env.DB.batch([
          env.DB.prepare('UPDATE workforce_shift_exceptions SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = \'pending\'').bind(body.status, me.id, new Date().toISOString(), exception.id),
          env.DB.prepare('INSERT INTO workforce_audit_events (actor_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?)').bind(me.id, 'shift_exception.' + body.status, 'shift_exception', exception.id, JSON.stringify({ staff_id: exception.staff_id, date: exception.date, shift_code: exception.shift_code }))
        ]);
        return json({ ok: true, status: body.status });
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
        const { results: managerPolicies } = await env.DB.prepare("SELECT staff_id, max_consecutive_days FROM staff_shift_policies WHERE staff_id IN (SELECT id FROM staff WHERE role='duty_ops_manager' AND active=1)").all();
        const maxWorkStreak = new Map(managers.results.map(manager => [manager.id, managerPolicies.find(policy => policy.staff_id === manager.id)?.max_consecutive_days || 5]));
        const { results: leaveRows } = await env.DB.prepare("SELECT staff_id, date FROM leave_requests WHERE status = 'approved' AND date >= ? AND date < date(?, '+1 month')").bind(body.month + '-01', body.month + '-01').all();
        const { results: assignedRows } = await env.DB.prepare("SELECT a.staff_id, a.date, a.shift_code, d.id AS department_id, d.day_code FROM shift_assignments a JOIN schedules s ON s.id=a.schedule_id JOIN departments d ON d.id=s.department_id WHERE s.month = ? AND s.id = (SELECT s2.id FROM schedules s2 WHERE s2.month=s.month AND s2.department_id=s.department_id ORDER BY s2.generated_at DESC LIMIT 1) AND a.shift_code NOT IN ('O','L','PL','ML','SL')").bind(body.month).all();
        const { results: dayDemand } = await env.DB.prepare("SELECT id, day_min, day_code FROM departments WHERE operational_team=1 ORDER BY id").all();
        const { results: managerQualifications } = await env.DB.prepare("SELECT staff_id, department_id FROM staff_department_qualifications WHERE staff_id IN (SELECT id FROM staff WHERE role='duty_ops_manager' AND active=1) AND can_day=1 AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)").bind(body.month + '-31', body.month + '-01').all();
        const managerQualificationSet = new Set(managerQualifications.map(row => row.staff_id + ':' + row.department_id));
        const dayCoverage = new Map();
        for (const row of assignedRows) {
          if (row.shift_code !== row.day_code) continue;
          const key = row.date + ':' + row.department_id;
          if (!dayCoverage.has(key)) dayCoverage.set(key, new Set());
          dayCoverage.get(key).add(row.staff_id);
        }
        const leave = new Set(leaveRows.map(row => row.staff_id + ':' + row.date));
        const assignmentByStaffDate = new Map();
        for (const row of assignedRows) {
          const key = row.staff_id + ':' + row.date;
          if (!assignmentByStaffDate.has(key)) assignmentByStaffDate.set(key, []);
          assignmentByStaffDate.get(key).push(row);
        }
        const { results: priorRows } = await env.DB.prepare("SELECT manager_staff_id, COUNT(*) AS total FROM duty_ops_assignments WHERE duty_date < ? AND duty_date >= date(?, '-90 days') AND manager_staff_id IS NOT NULL GROUP BY manager_staff_id").bind(body.month + '-01', body.month + '-01').all();
        const { results: priorDutyDates } = await env.DB.prepare("SELECT manager_staff_id, duty_date FROM duty_ops_assignments WHERE manager_staff_id IS NOT NULL AND status IN ('assigned','confirmed') AND duty_date >= date(?, '-7 days') AND duty_date < ?").bind(body.month + '-01', body.month + '-01').all();
        const { results: priorShiftDates } = await env.DB.prepare("SELECT a.staff_id, a.date FROM shift_assignments a JOIN schedules s ON s.id=a.schedule_id WHERE s.status='published' AND s.id=(SELECT latest.id FROM schedules latest WHERE latest.month=s.month AND latest.department_id=s.department_id ORDER BY latest.generated_at DESC LIMIT 1) AND a.shift_code IN ('D','N','DC','NC','T','FSA') AND a.date >= date(?, '-7 days') AND a.date < ?").bind(body.month + '-01', body.month + '-01').all();
        const managerWorkDates = new Map(managers.results.map(manager => [manager.id, new Set()]));
        for (const row of [...priorDutyDates.map(row => ({ staff_id: row.manager_staff_id, date: row.duty_date })), ...priorShiftDates, ...assignedRows]) {
          if (managerWorkDates.has(row.staff_id)) managerWorkDates.get(row.staff_id).add(row.date);
        }
        function consecutiveDaysBefore(managerId, date) {
          const dates = managerWorkDates.get(managerId) || new Set();
          const [y, m, d] = date.split('-').map(Number);
          let streak = 0;
          for (let offset = 1; offset <= (maxWorkStreak.get(managerId) || 5); offset++) {
            const previous = new Date(Date.UTC(y, m - 1, d - offset)).toISOString().slice(0,10);
            if (!dates.has(previous)) break;
            streak++;
          }
          return streak;
        }
        const counts = new Map(managers.results.map(manager => [manager.id, priorRows.find(row => row.manager_staff_id === manager.id)?.total || 0]));
        const { results: priorTeamRows } = await env.DB.prepare("SELECT coverage_department_id, COUNT(*) AS total FROM duty_ops_assignments WHERE duty_date < ? AND duty_date >= date(?, '-90 days') AND coverage_department_id IS NOT NULL GROUP BY coverage_department_id").bind(body.month + '-01', body.month + '-01').all();
        const teamCoverCounts = new Map(dayDemand.map(department => [department.id, priorTeamRows.find(row => row.coverage_department_id === department.id)?.total || 0]));
        const statements = [];
        const exceptions = [];
        for (let day = 1; day <= days; day++) {
          const date = body.month + '-' + String(day).padStart(2, '0');
          const eligible = managers.results.filter(manager => {
            if (leave.has(manager.id + ':' + date)) return false;
            const assignments = assignmentByStaffDate.get(manager.id + ':' + date) || [];
            const alreadyOnDayShift = assignments.length > 0 && assignments.every(row => row.shift_code === row.day_code);
            if (assignments.length > 0 && !alreadyOnDayShift) return false;
            return alreadyOnDayShift || consecutiveDaysBefore(manager.id, date) < (maxWorkStreak.get(manager.id) || 5);
          });
          eligible.sort((a,b) => (counts.get(a.id) - counts.get(b.id)) || a.id.localeCompare(b.id));
          const chosen = eligible[0] || null;
          const chosenAssignments = chosen ? (assignmentByStaffDate.get(chosen.id + ':' + date) || []) : [];
          let teamDepartment = chosenAssignments[0]?.department_id || null;
          if (chosen && !teamDepartment) {
            const shortages = dayDemand.filter(department =>
              managerQualificationSet.has(chosen.id + ':' + department.id)
              && (dayCoverage.get(date + ':' + department.id)?.size || 0) < department.day_min
            ).sort((a,b) => {
              const aDeficit = a.day_min - (dayCoverage.get(date + ':' + a.id)?.size || 0);
              const bDeficit = b.day_min - (dayCoverage.get(date + ':' + b.id)?.size || 0);
              const aRatio = aDeficit / Math.max(1, a.day_min);
              const bRatio = bDeficit / Math.max(1, b.day_min);
              return (bRatio - aRatio) || ((teamCoverCounts.get(a.id) || 0) - (teamCoverCounts.get(b.id) || 0)) || a.id.localeCompare(b.id);
            });
            teamDepartment = shortages[0]?.id || null;
          }
          const assignmentType = teamDepartment ? 'team_cover' : 'floating';
          if (teamDepartment) teamCoverCounts.set(teamDepartment, (teamCoverCounts.get(teamDepartment) || 0) + 1);
          if (chosen) {
            counts.set(chosen.id, (counts.get(chosen.id) || 0) + 1);
            managerWorkDates.get(chosen.id).add(date);
          } else exceptions.push(date);
          const id = crypto.randomUUID();
          statements.push(env.DB.prepare("INSERT INTO duty_ops_assignments (id, duty_date, manager_staff_id, assignment_type, coverage_department_id, shift_code, reason, status, created_by) VALUES (?, ?, ?, ?, ?, 'MD', ?, ?, ?) ON CONFLICT(duty_date) DO UPDATE SET manager_staff_id=excluded.manager_staff_id, assignment_type=excluded.assignment_type, coverage_department_id=excluded.coverage_department_id, reason=excluded.reason, status=excluded.status, created_by=excluded.created_by").bind(id, date, chosen?.id || null, assignmentType, teamDepartment, chosen ? (teamDepartment ? 'Assigned to existing team day shift' : 'Fairness-balanced floating day duty') : 'No Duty Ops Manager available; manual resolution required', chosen ? 'assigned' : 'exception', me.id));
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
          'SELECT id, name, department_id, role, active, pin_set, employment_end_date FROM staff ORDER BY active DESC, department_id, name'
        ).all();
        return json(results);
      }

      if (pathname === '/api/hr/staff' && request.method === 'POST') {
        const denied = requireAnyPermission('staff.lifecycle');
        if (denied) return denied;
        const body = await request.json();
        if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.length > 120) return json({ error: 'Valid employee name is required' }, { status: 400 });
        const homeDepartment = await env.DB.prepare('SELECT id FROM departments WHERE id = ? AND operational_team = 1').bind(body.department_id).first();
        if (!homeDepartment) return json({ error: 'A valid operational home department is required' }, { status: 400 });
        const id = (body.id || body.name.toLowerCase().trim().replace(/\\s+/g,'-').replace(/[^a-z0-9-]/g,'')).slice(0,80);
        if (!/^[a-z0-9_-]{1,80}$/.test(id)) return json({ error: 'Invalid staff identifier' }, { status: 400 });
        const statements = [
          env.DB.prepare("INSERT INTO staff (id, name, department_id, active, role, pin_set) VALUES (?, ?, ?, 1, 'staff', 0)").bind(id, body.name.trim(), body.department_id),
          env.DB.prepare("INSERT INTO staff_shift_policies (staff_id, night_mode, max_consecutive_days, min_rest_hours, effective_from) VALUES (?, 'restricted', 5, 11, date('now'))").bind(id),
          env.DB.prepare('INSERT INTO workforce_audit_events (actor_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?)').bind(me.id, 'staff.created', 'staff', id, JSON.stringify({ department_id: body.department_id }))
        ];
        await env.DB.batch(statements);
        return json({ id, ok: true }, { status: 201 });
      }

      const hrStaffMatch = pathname.match(/^\/api\/hr\/staff\/([^/]+)$/);
      if (hrStaffMatch && request.method === 'PATCH') {
        const denied = requireAnyPermission('staff.lifecycle');
        if (denied) return denied;
        const staffId = hrStaffMatch[1];
        const target = await env.DB.prepare('SELECT role FROM staff WHERE id = ?').bind(staffId).first();
        if (!target) return json({ error: 'Staff account not found' }, { status: 404 });
        const targetAuthority = await env.DB.prepare('SELECT authority_level FROM role_hierarchy WHERE role = ?').bind(target.role).first();
        const hrAuthority = await env.DB.prepare("SELECT authority_level FROM role_hierarchy WHERE role = 'hr'").first();
        if (targetAuthority?.authority_level >= (hrAuthority?.authority_level ?? 700)) return json({ error: 'HR cannot alter accounts at or above HR authority' }, { status: 403 });
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
            "SELECT DISTINCT s.id, s.name, s.department_id, s.role, s.pin_set FROM staff s JOIN staff_department_qualifications q ON q.staff_id=s.id WHERE q.department_id = ? AND s.active=1 AND (? = 1 OR COALESCE(q.relief_only,0)=0) AND q.effective_from <= date('now') AND (q.effective_to IS NULL OR q.effective_to >= date('now')) ORDER BY s.name"
          ).bind(dept, isAdmin ? 1 : 0).all();
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
        if (me.role !== 'admin' && ['admin','duty_ops_manager'].includes(role)) return json({ error: 'Only the platform administrator can create platform administrators or peer Duty Ops Managers' }, { status: 403 });
        const selectedDepartment = await env.DB.prepare('SELECT id FROM departments WHERE id = ?').bind(body.department_id).first();
        if (!selectedDepartment) return json({ error: 'Unknown department' }, { status: 400 });
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
          const target = await env.DB.prepare('SELECT role FROM staff WHERE id = ?').bind(staffId).first();
          if (!target) return json({ error: 'Staff account not found' }, { status: 404 });
          const targetLevel = await env.DB.prepare('SELECT authority_level FROM role_hierarchy WHERE role = ?').bind(target.role).first();
          const actorLevel = await env.DB.prepare('SELECT authority_level FROM role_hierarchy WHERE role = ?').bind(me.role).first();
          if (me.role !== 'admin' && (targetLevel?.authority_level ?? 0) >= (actorLevel?.authority_level ?? 0)) {
            return json({ error: 'You cannot modify an account at or above your authority level' }, { status: 403 });
          }
          const body = await request.json();
          if (staffId === me.id && body.role && body.role !== me.role) return json({ error: 'You cannot change your own authority' }, { status: 403 });
          const updates = [];
          const binds = [];
          if (body.name) { updates.push('name = ?'); binds.push(body.name); }
          if (body.role && ['admin', 'duty_ops_manager', 'hr', 'technical_assistant', 'staff'].includes(body.role)) {
            const nextLevel = await env.DB.prepare('SELECT authority_level FROM role_hierarchy WHERE role = ?').bind(body.role).first();
            if (me.role !== 'admin' && (nextLevel?.authority_level ?? 0) >= (actorLevel?.authority_level ?? 0)) {
              return json({ error: 'You cannot grant authority at or above your own level' }, { status: 403 });
            }
            updates.push('role = ?'); binds.push(body.role);
          }
          if (updates.length === 0) return json({ error: 'Nothing to update' }, { status: 400 });
          binds.push(staffId);
          await env.DB.batch([
            env.DB.prepare(`UPDATE staff SET ${updates.join(', ')} WHERE id = ?`).bind(...binds),
            env.DB.prepare('INSERT INTO workforce_audit_events (actor_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?)').bind(me.id, body.role ? 'staff.role_updated' : 'staff.profile_updated', 'staff', staffId, JSON.stringify({ role: body.role || null, name_changed: typeof body.name === 'string' }))
          ]);
          return json({ updated: true });
        }
        if (request.method === 'DELETE') {
          const denied = requireAdmin();
          if (denied) return denied;
          if (staffId === me.id) return json({ error: 'Cannot deactivate your own account' }, { status: 400 });
          const target = await env.DB.prepare('SELECT role FROM staff WHERE id = ?').bind(staffId).first();
          const targetLevel = await env.DB.prepare('SELECT authority_level FROM role_hierarchy WHERE role = ?').bind(target?.role || 'staff').first();
          const actorLevel = await env.DB.prepare('SELECT authority_level FROM role_hierarchy WHERE role = ?').bind(me.role).first();
          if (me.role !== 'admin' && (targetLevel?.authority_level ?? 0) >= (actorLevel?.authority_level ?? 0)) return json({ error: 'You cannot deactivate an account at or above your authority level' }, { status: 403 });
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
        const effectiveStaffId = canManageLeave ? staffId : me.id;
        let query = 'SELECT * FROM leave_requests WHERE 1=1';
        const binds = [];
        if (effectiveStaffId) { query += ' AND staff_id = ?'; binds.push(effectiveStaffId); }
        if (month) { query += ' AND date LIKE ?'; binds.push(`${month}-%`); }
        const { results } = await env.DB.prepare(query).bind(...binds).all();
        return json(results);
      }

      if (pathname === '/api/leave' && request.method === 'POST') {
        const denied = requireAnyPermission('leave.manage');
        if (denied) return denied;
        const body = await request.json();
        if (typeof body.staff_id !== 'string' || !isValidCalendarDate(body.date)) {
          return json({ error: 'A valid staff_id and YYYY-MM-DD date are required' }, { status: 400 });
        }
        if (body.status !== undefined && !['approved', 'pending'].includes(body.status)) {
          return json({ error: 'status must be approved or pending' }, { status: 400 });
        }
        const leaveType = body.leave_type || 'L';
        if (!['L','PL','ML','SL'].includes(leaveType)) {
          return json({ error: 'leave_type must be L, PL, ML or SL' }, { status: 400 });
        }
        const target = await env.DB.prepare('SELECT id FROM staff WHERE id = ? AND active = 1').bind(body.staff_id).first();
        if (!target) return json({ error: 'Active staff account not found' }, { status: 404 });
        const activeRelief = await env.DB.prepare(
          "SELECT id FROM workforce_relief_assignments WHERE staff_id=? AND duty_date=? AND status IN ('pending','approved')"
        ).bind(body.staff_id, body.date).first();
        if (activeRelief) {
          return json({ error: 'Leave cannot be recorded while a cross-desk relief request or approved deployment exists for this date; resolve the relief record first' }, { status: 409 });
        }
        const activeTraining = await env.DB.prepare(
          "SELECT id FROM workforce_staff_markers WHERE staff_id=? AND date=? AND status='approved'"
        ).bind(body.staff_id, body.date).first();
        if (activeTraining) {
          return json({ error: 'Leave cannot overlap an approved trainee assignment' }, { status: 409 });
        }
        const id = uuid();
        try {
          await env.DB.prepare(
            'INSERT INTO leave_requests (id, staff_id, date, status, leave_type) VALUES (?, ?, ?, ?, ?) ' +
            'ON CONFLICT(staff_id, date) DO UPDATE SET status = excluded.status, leave_type = excluded.leave_type'
          ).bind(id, body.staff_id, body.date, body.status || 'approved', leaveType).run();
        } catch (error) {
          const message = String(error?.message || error);
          if (/unique|conflict|relief|training/i.test(message)) {
            return json({ error: 'Leave conflicts with a pending or approved relief deployment or trainee assignment. Resolve the existing record first.' }, { status: 409 });
          }
          throw error;
        }
        return json({ id, ...body, leave_type: leaveType }, { status: 201 });
      }

      if (pathname.startsWith('/api/leave/') && request.method === 'DELETE') {
        const denied = requireAnyPermission('leave.manage');
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
          "SELECT s.id, s.name, q.can_day, CASE WHEN COALESCE(p.night_mode,'allowed')='allowed' THEN q.can_night ELSE 0 END AS can_night, COALESCE(q.relief_only,0) AS relief_only, COALESCE(p.max_consecutive_days,5) AS max_consecutive_days FROM staff s JOIN staff_department_qualifications q ON q.staff_id=s.id LEFT JOIN staff_shift_policies p ON p.staff_id=s.id WHERE q.department_id = ? AND COALESCE(q.relief_only,0)=0 AND s.role <> 'duty_ops_manager' AND s.active = 1 AND q.effective_from <= ? AND (q.effective_to IS NULL OR q.effective_to >= ?) AND q.effective_from = (SELECT MAX(q2.effective_from) FROM staff_department_qualifications q2 WHERE q2.staff_id=s.id AND q2.department_id=q.department_id AND q2.effective_from <= ? AND (q2.effective_to IS NULL OR q2.effective_to >= ?)) ORDER BY s.name"
        ).bind(department_id, month + '-31', month + '-01', month + '-31', month + '-01').all();

        const fixedAssignments = Object.create(null);
        const { results: rotationRows } = await env.DB.prepare(
          'SELECT rp.*,s.name AS staff_name FROM workforce_rotation_patterns rp ' +
          'JOIN staff s ON s.id=rp.staff_id WHERE rp.department_id=? AND s.active=1 ' +
          'AND rp.effective_from<=? AND (rp.effective_to IS NULL OR rp.effective_to>=?) ORDER BY rp.effective_from,s.name'
        ).bind(department_id,month+'-31',month+'-01').all();
        const monthDays = daysInMonth(month);
        for (const pattern of rotationRows) {
          const person = staffRows.find(item => item.id === pattern.staff_id);
          if (!person) return json({ error: 'Rotation pattern for ' + pattern.staff_name + ' has no current primary qualification on ' + department_id }, { status: 409 });
          let cycle;
          try { cycle = JSON.parse(pattern.cycle_codes_json); } catch {
            return json({ error: 'Invalid rotation cycle data for ' + pattern.staff_name }, { status: 409 });
          }
          if (!Array.isArray(cycle) || !cycle.length) return json({ error: 'Empty rotation cycle for ' + pattern.staff_name }, { status: 409 });
          for (let day=1;day<=monthDays;day++) {
            const date=dateStr(month,day);
            if (date<pattern.effective_from || (pattern.effective_to && date>pattern.effective_to)) continue;
            const offset=Math.floor((Date.parse(date+'T00:00:00Z')-Date.parse(pattern.anchor_date+'T00:00:00Z'))/86400000);
            const code=cycle[((offset%cycle.length)+cycle.length)%cycle.length];
            if (![dept.day_code,dept.night_code,'O'].includes(code)) {
              return json({ error: 'Rotation pattern for ' + pattern.staff_name + ' contains an unsupported shift code for ' + department_id }, { status: 409 });
            }
            if (!fixedAssignments[pattern.staff_id]) fixedAssignments[pattern.staff_id]=Object.create(null);
            fixedAssignments[pattern.staff_id][date]={shift_code:code,assignment_source:'rotation'};
          }
        }

        const { results: reliefRows } = await env.DB.prepare(
          'SELECT r.*, s.name, s.department_id AS home_department_id, q.can_day, ' +
          "CASE WHEN COALESCE(p.night_mode,'allowed')='allowed' THEN q.can_night ELSE 0 END AS can_night, " +
          'COALESCE(p.max_consecutive_days,5) AS max_consecutive_days ' +
          'FROM workforce_relief_assignments r JOIN staff s ON s.id=r.staff_id ' +
          'JOIN staff_department_qualifications q ON q.staff_id=s.id AND q.department_id=r.target_department_id ' +
          'LEFT JOIN staff_shift_policies p ON p.staff_id=s.id ' +
          "WHERE r.status='approved' AND r.duty_date LIKE ? AND (r.target_department_id=? OR s.department_id=?) " +
          'AND q.relief_only=1 AND q.effective_from <= r.duty_date AND (q.effective_to IS NULL OR q.effective_to >= r.duty_date) ' +
          'AND q.effective_from=(SELECT MAX(q2.effective_from) FROM staff_department_qualifications q2 ' +
          'WHERE q2.staff_id=s.id AND q2.department_id=r.target_department_id ' +
          'AND q2.effective_from <= r.duty_date AND (q2.effective_to IS NULL OR q2.effective_to >= r.duty_date)) ' +
          'ORDER BY r.duty_date,s.name'
        ).bind(month + '-%', department_id, department_id).all();

        for (const relief of reliefRows) {
          const validation = await validateReliefAssignment({
            staff_id: relief.staff_id, duty_date: relief.duty_date,
            target_department_id: relief.target_department_id, shift_code: relief.shift_code,
            display_code: relief.display_code, reason: relief.reason,
          }, relief.id);
          if (!validation.ok) {
            return json({ error: 'Approved relief allocation for ' + relief.name + ' on ' + relief.duty_date + ' is no longer valid: ' + validation.error }, { status: 409 });
          }
          let person = staffRows.find(item => item.id === relief.staff_id);
          if (!person) {
            person = {
              id: relief.staff_id, name: relief.name, can_day: relief.can_day,
              can_night: relief.can_night, max_consecutive_days: relief.max_consecutive_days,
              relief_only: 1, night_exception_dates: [],
            };
            staffRows.push(person);
          }
          if (!fixedAssignments[relief.staff_id]) fixedAssignments[relief.staff_id] = Object.create(null);
          fixedAssignments[relief.staff_id][relief.duty_date] = {
            shift_code: relief.display_code,
            coverage_department_id: relief.target_department_id,
            coverage_shift_code: relief.shift_code,
            assignment_source: relief.display_code === 'FSA' ? 'field_supervisor' : 'relief',
          };
        }

        const { results: dutyAssignments } = await env.DB.prepare(
          "SELECT duty_date, manager_staff_id FROM duty_ops_assignments WHERE coverage_department_id = ? AND duty_date >= ? AND duty_date < date(?, '+1 month') AND status IN ('assigned','confirmed') AND manager_staff_id IS NOT NULL"
        ).bind(department_id, month + '-01', month + '-01').all();
        const managersAdded = new Set();
        for (const duty of dutyAssignments) {
          if (staffRows.some(person => person.id === duty.manager_staff_id) || managersAdded.has(duty.manager_staff_id)) continue;
          const manager = await env.DB.prepare(
            "SELECT s.id, s.name, q.can_day, COALESCE(p.max_consecutive_days,5) AS max_consecutive_days " +
            "FROM staff s JOIN staff_department_qualifications q ON q.staff_id=s.id " +
            "LEFT JOIN staff_shift_policies p ON p.staff_id=s.id " +
            "WHERE s.id=? AND s.role='duty_ops_manager' AND s.active=1 AND q.department_id=? " +
            "AND q.can_day=1 AND q.effective_from<=? AND (q.effective_to IS NULL OR q.effective_to>=?) " +
            "ORDER BY q.effective_from DESC LIMIT 1"
          ).bind(duty.manager_staff_id, department_id, duty.duty_date, duty.duty_date).first();
          if (!manager) {
            return json({
              error: 'Duty Ops team-cover assignment for ' + duty.manager_staff_id + ' on ' + duty.duty_date +
                ' has no effective day qualification for ' + department_id + '; correct the rota before generating this schedule',
            }, { status: 409 });
          }
          staffRows.push({
            id: manager.id, name: manager.name, can_day: manager.can_day, can_night: 0,
            max_consecutive_days: manager.max_consecutive_days, relief_only: 1,
            night_exception_dates: [],
          });
          managersAdded.add(manager.id);
        }
        if (staffRows.length === 0) {
          return json({ error: 'No active primary staff, approved relief or Duty Ops team-cover assignments in this department' }, { status: 400 });
        }
        const { results: approvedExceptions } = await env.DB.prepare(
          "SELECT staff_id, date FROM workforce_shift_exceptions WHERE status = 'approved' AND shift_code IN ('N','NC') AND date LIKE ?"
        ).bind(month + '-%').all();
        const exceptionDates = new Map();
        for (const exception of approvedExceptions) {
          if (!exceptionDates.has(exception.staff_id)) exceptionDates.set(exception.staff_id, []);
          exceptionDates.get(exception.staff_id).push(exception.date);
        }
        for (const person of staffRows) person.night_exception_dates = exceptionDates.get(person.id) || [];

        const { results: leaveRows } = await env.DB.prepare(
          'SELECT staff_id, date, leave_type FROM leave_requests WHERE date LIKE ? AND staff_id IN (' +
          staffRows.map(() => '?').join(',') + ") AND status = 'approved'"
        ).bind(month + '-%', ...staffRows.map(s => s.id)).all();

        const leaveByStaff = Object.create(null);
        for (const s of staffRows) leaveByStaff[s.id] = Object.create(null);
        for (const row of leaveRows) leaveByStaff[row.staff_id][row.date] = row.leave_type || 'L';

        const { results: trainingRows } = await env.DB.prepare(
          "SELECT staff_id,date,marker_code FROM workforce_staff_markers WHERE status='approved' AND date LIKE ? AND staff_id IN (" +
          staffRows.map(() => '?').join(',') + ')'
        ).bind(month + '-%', ...staffRows.map(s => s.id)).all();
        for (const marker of trainingRows) {
          if (!fixedAssignments[marker.staff_id]) fixedAssignments[marker.staff_id] = Object.create(null);
          const existingFixed = fixedAssignments[marker.staff_id][marker.date];
          if (!existingFixed || (existingFixed.assignment_source === 'rotation' && existingFixed.shift_code === 'O')) {
            fixedAssignments[marker.staff_id][marker.date] = { shift_code: marker.marker_code, assignment_source:'training' };
          }
        }

        const priorFinalState = await getPriorFinalState(env.DB, month, department_id, staffRows, dept);
        const preassignedAssignments = Object.fromEntries(dutyAssignments.map(row => [row.duty_date, row.manager_staff_id]));

        const { assignments, assignmentMeta, warnings, totals } = generateSchedule({
          month, department: dept, staff: staffRows, leaveByStaff, priorFinalState, preassignedAssignments, fixedAssignments,
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
                'INSERT INTO shift_assignments (id, schedule_id, staff_id, date, shift_code, is_manual_override, coverage_department_id, coverage_shift_code, assignment_source) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)'
              ).bind(uuid(), scheduleId, s.id, ds, assignments[s.id][ds],
                assignmentMeta[s.id]?.[ds]?.coverage_department_id || null,
                assignmentMeta[s.id]?.[ds]?.coverage_shift_code || null,
                assignmentMeta[s.id]?.[ds]?.assignment_source || 'generated')
            );
          }
        }
        await env.DB.batch(inserts);

        return json({ schedule_id: scheduleId, month, department_id, assignments, assignmentMeta, totals, warnings }, { status: 201 });
      }

      if (pathname === '/api/workforce/my-roster' && request.method === 'GET') {
        const month = url.searchParams.get('month');
        if (!isValidMonth(month)) return json({ error: 'A valid YYYY-MM month is required' }, { status: 400 });
        const myShifts = Object.create(null);
        const myShiftDetails = Object.create(null);
        const coworkersByDate = Object.create(null);
        let scheduleStatus = null;

        const homeSchedule = await env.DB.prepare(
          'SELECT id,status FROM schedules WHERE month=? AND department_id=? ORDER BY generated_at DESC LIMIT 1'
        ).bind(month, me.department_id).first();
        if (homeSchedule) {
          scheduleStatus = homeSchedule.status;
          const { results: homeRows } = await env.DB.prepare(
            'SELECT sa.staff_id,st.name AS staff_name,sa.date,sa.shift_code,sa.coverage_department_id,sa.coverage_shift_code ' +
            'FROM shift_assignments sa JOIN staff st ON st.id=sa.staff_id WHERE sa.schedule_id=? ORDER BY sa.date,st.name'
          ).bind(homeSchedule.id).all();
          for (const row of homeRows) {
            if (row.staff_id !== me.id) continue;
            myShifts[row.date] = row.shift_code;
            myShiftDetails[row.date] = {
              shift_code: row.shift_code,
              coverage_department_id: row.coverage_department_id || null,
              coverage_shift_code: row.coverage_shift_code || null,
            };
          }
          for (const [date, detail] of Object.entries(myShiftDetails)) {
            if (detail.coverage_department_id) continue;
            const coveredCode = detail.coverage_shift_code || detail.shift_code;
            if (!['D','N','DC','NC','T','FSA'].includes(detail.shift_code)) continue;
            coworkersByDate[date] = homeRows.filter(row => row.date === date && row.staff_id !== me.id
              && (row.coverage_shift_code || row.shift_code) === coveredCode).map(row => row.staff_name);
          }
        }

        const { results: leaveRows } = await env.DB.prepare(
          "SELECT date,leave_type FROM leave_requests WHERE staff_id=? AND status='approved' AND date LIKE ?"
        ).bind(me.id, month + '-%').all();
        for (const row of leaveRows) {
          if (!myShifts[row.date] || myShifts[row.date] === 'O') {
            myShifts[row.date] = row.leave_type || 'L';
            myShiftDetails[row.date] = { shift_code: row.leave_type || 'L', coverage_department_id: null, coverage_shift_code: null };
          }
        }

        const { results: trainingRows } = await env.DB.prepare(
          "SELECT date,marker_code FROM workforce_staff_markers WHERE staff_id=? AND status='approved' AND date LIKE ?"
        ).bind(me.id, month + '-%').all();
        for (const row of trainingRows) {
          if (!myShifts[row.date] || myShifts[row.date] === 'O') {
            myShifts[row.date] = row.marker_code;
            myShiftDetails[row.date] = { shift_code: row.marker_code, coverage_department_id: null, coverage_shift_code: null };
          }
        }

        const { results: reliefRows } = await env.DB.prepare(
          "SELECT r.*,d.name AS target_department_name FROM workforce_relief_assignments r JOIN departments d ON d.id=r.target_department_id WHERE r.staff_id=? AND r.status='approved' AND r.duty_date LIKE ? ORDER BY r.duty_date"
        ).bind(me.id, month + '-%').all();
        for (const relief of reliefRows) {
          myShifts[relief.duty_date] = relief.display_code;
          myShiftDetails[relief.duty_date] = {
            shift_code: relief.display_code,
            coverage_department_id: relief.target_department_id,
            coverage_department_name: relief.target_department_name,
            coverage_shift_code: relief.shift_code,
          };
          const targetSchedule = await env.DB.prepare(
            'SELECT id FROM schedules WHERE month=? AND department_id=? ORDER BY generated_at DESC LIMIT 1'
          ).bind(month, relief.target_department_id).first();
          if (targetSchedule) {
            const { results: targetRows } = await env.DB.prepare(
              'SELECT sa.staff_id,st.name AS staff_name,sa.date,sa.shift_code,sa.coverage_department_id,sa.coverage_shift_code ' +
              'FROM shift_assignments sa JOIN staff st ON st.id=sa.staff_id WHERE sa.schedule_id=? AND sa.date=?'
            ).bind(targetSchedule.id, relief.duty_date).all();
            coworkersByDate[relief.duty_date] = targetRows.filter(row => row.staff_id !== me.id
              && (row.coverage_department_id === relief.target_department_id || !row.coverage_department_id)
              && (row.coverage_shift_code || row.shift_code) === relief.shift_code).map(row => row.staff_name);
          } else {
            coworkersByDate[relief.duty_date] = [];
          }
        }

        return json({
          month, status: scheduleStatus, department_id: me.department_id,
          my_shifts: myShifts, my_shift_details: myShiftDetails, coworkers_by_date: coworkersByDate,
        });
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
          .bind(schedule.department_id).first();

        const { results: assignments } = await env.DB.prepare(
          `SELECT sa.staff_id, st.name AS staff_name, sa.date, sa.shift_code,
                  sa.coverage_department_id, sa.coverage_shift_code
           FROM shift_assignments sa
           JOIN staff st ON st.id = sa.staff_id
           JOIN staff_department_qualifications q ON q.staff_id = st.id AND q.department_id = ?
           WHERE sa.schedule_id = ? AND q.effective_from <= ? AND (q.effective_to IS NULL OR q.effective_to >= ?)
             AND q.effective_from = (SELECT MAX(q2.effective_from) FROM staff_department_qualifications q2 WHERE q2.staff_id=st.id AND q2.department_id=q.department_id AND q2.effective_from <= ? AND (q2.effective_to IS NULL OR q2.effective_to >= ?))
           ORDER BY sa.date, st.name`
        ).bind(schedule.department_id, id, schedule.month + '-31', schedule.month + '-01', schedule.month + '-31', schedule.month + '-01').all();

        const myShifts = Object.create(null);
        const myShiftDetails = Object.create(null);
        for (const row of assignments) {
          if (row.staff_id === me.id) {
            myShifts[row.date] = row.shift_code;
            myShiftDetails[row.date] = {
              shift_code: row.shift_code,
              coverage_department_id: row.coverage_department_id || null,
              coverage_shift_code: row.coverage_shift_code || null,
            };
          }
        }

        const workingCodes = new Set(['D','N','DC','NC','T','FSA']);
        const coworkersByDate = Object.create(null);
        for (const date of Object.keys(myShifts)) {
          const detail = myShiftDetails[date];
          const coverageCode = detail.coverage_shift_code || detail.shift_code;
          if (!workingCodes.has(detail.shift_code) && !workingCodes.has(coverageCode)) continue;
          coworkersByDate[date] = assignments
            .filter(row => row.date === date && row.staff_id !== me.id
              && ((detail.coverage_department_id && row.coverage_department_id === detail.coverage_department_id
                    && row.coverage_shift_code === coverageCode)
                || (!detail.coverage_department_id && (row.coverage_shift_code || row.shift_code) === coverageCode)))
            .map(row => row.staff_name);
        }

        return json({
          schedule_id: id,
          month: schedule.month,
          status: schedule.status,
          department_id: schedule.department_id,
          home_department_id: me.department_id,
          day_code: dept.day_code,
          night_code: dept.night_code,
          my_shifts: myShifts,
          my_shift_details: myShiftDetails,
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
          `SELECT sa.staff_id, st.name AS staff_name, st.department_id, st.role AS role, sa.date, sa.shift_code, sa.is_manual_override,
                  sa.coverage_department_id, sa.coverage_shift_code
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
          `SELECT sa.staff_id, st.name AS staff_name, sc.department_id AS roster_department_id,
                  st.department_id AS home_department_id, sa.date, sa.shift_code,
                  sa.coverage_department_id, sa.coverage_shift_code
           FROM shift_assignments sa
           JOIN staff st ON st.id = sa.staff_id
           JOIN schedules sc ON sc.id = sa.schedule_id
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
      'SELECT date, shift_code, coverage_shift_code FROM shift_assignments WHERE schedule_id = ? AND staff_id = ? AND date <= ? ORDER BY date DESC LIMIT 7'
    ).bind(prevSchedule.id, s.id, lastDate).all();
    if (results.length === 0) continue;

    const lastCode = results[0].coverage_shift_code || results[0].shift_code;
    let consecutiveWork = 0;
    for (const row of results) {
      if (['D','N','DC','NC','T','FSA'].includes(row.shift_code)) consecutiveWork++;
      else break;
    }
    priorFinalState[s.id] = {
      lastShift: ['N','NC'].includes(lastCode) ? 'night' : ['D','DC'].includes(lastCode) ? 'day' : null,
      consecutiveWork,
    };
  }
  return priorFinalState;
}

