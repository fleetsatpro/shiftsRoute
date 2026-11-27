import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = 'wrangler.routesa.preview.toml';
const database = 'raw-ter-shift-preview';
const baseUrl = 'http://127.0.0.1:8788';
const enrollmentCode = 'local-worker-integration-enrollment-code';

function wrangler(args, persistDir) {
  const result = spawnSync('npx', [
    'wrangler', ...args, '--config', config, '--persist-to', persistDir,
  ], { encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) {
    throw new Error([
      `wrangler ${args.join(' ')} failed (exit ${result.status})`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result.stdout;
}

async function waitForWorker(child) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Wrangler dev exited before becoming healthy');
    try {
      const response = await fetch(baseUrl + '/api/health');
      if (response.ok) return;
      lastError = new Error(`Health endpoint returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw lastError || new Error('Timed out waiting for local Worker');
}

test('real Worker + isolated local D1: enrollment, authentication, authorization and logout', async () => {
  const persistDir = await mkdtemp(join(tmpdir(), 'shiftsroute-d1-'));
  let worker;
  try {
    // The preview config is deliberate: this test must never point at production D1.
    wrangler(['d1', 'migrations', 'apply', database, '--local'], persistDir);
    const enrollmentCodes = {
      charles: enrollmentCode,
      griffin: 'local-griffin-enrollment-code',
      hilda: 'local-hilda-enrollment-code',
      mukasa: 'local-mukasa-enrollment-code',
      mercy: 'local-mercy-enrollment-code',
      'mercy-dorice': 'local-mercy-dorice-enrollment-code',
      'clinton-juma': 'local-clinton-enrollment-code',
    };
    const enrollmentUpdates = Object.entries(enrollmentCodes).map(([id, code]) =>
      `UPDATE staff SET enrollment_hash = '${createHash('sha256').update(code).digest('hex')}' WHERE id = '${id}' AND pin_set = 0;`
    ).join(' ');
    wrangler(['d1', 'execute', database, '--local', '--command', enrollmentUpdates], persistDir);

    worker = spawn('npx', [
      'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', '8788',
      '--config', config, '--persist-to', persistDir, '--log-level', 'error',
    ], { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let workerLogs = '';
    worker.stdout.on('data', chunk => { workerLogs += chunk.toString(); });
    worker.stderr.on('data', chunk => { workerLogs += chunk.toString(); });
    await waitForWorker(worker).catch(error => { throw new Error(`${error.message}\n${workerLogs}`); });

    const health = await fetch(baseUrl + '/api/health');
    assert.deepEqual((await health.json()).ok, true);

    const peopleResponse = await fetch(baseUrl + '/api/auth/people');
    assert.equal(peopleResponse.status, 200);
    const people = await peopleResponse.json();
    assert.ok(people.some(person => person.id === 'charles' && person.pin_set === 0));

    const enroll = await fetch(baseUrl + '/api/auth/set-pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staff_id: 'charles', pin: '483920', enrollment_code: enrollmentCode }),
    });
    assert.equal(enroll.status, 201, await enroll.clone().text());
    const sessionCookie = enroll.headers.get('set-cookie')?.split(';')[0];
    assert.match(sessionCookie || '', /^roc_session=[a-f0-9]{64}$/);

    const me = await fetch(baseUrl + '/api/auth/me', { headers: { cookie: sessionCookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).id, 'charles');

    const scopedStaff = await fetch(baseUrl + '/api/staff?department=ISOC', { headers: { cookie: sessionCookie } });
    assert.equal(scopedStaff.status, 200);
    const staffRows = await scopedStaff.json();
    assert.ok(staffRows.length >= 10);
    assert.ok(staffRows.every(person => ['ISOC','ROC'].includes(person.department_id)));
    assert.ok(staffRows.some(person => person.id === 'mukasa' && person.department_id === 'ROC'));

    const deniedCrossDepartment = await fetch(baseUrl + '/api/staff?department=SCE', { headers: { cookie: sessionCookie } });
    assert.equal(deniedCrossDepartment.status, 200);
    const ownScope = await deniedCrossDepartment.json();
    assert.ok(ownScope.every(person => ['ISOC','ROC'].includes(person.department_id)));
    assert.ok(ownScope.some(person => person.id === 'mukasa'), 'cross-qualified Duty Ops Manager should be visible in ISOC roster');

    const badLogin = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staff_id: 'charles', pin: '000000' }),
    });
    assert.equal(badLogin.status, 401);

    const goodLogin = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staff_id: 'charles', pin: '483920' }),
    });
    assert.equal(goodLogin.status, 200);
    const freshCookie = goodLogin.headers.get('set-cookie')?.split(';')[0];
    assert.match(freshCookie || '', /^roc_session=[a-f0-9]{64}$/);

    const logout = await fetch(baseUrl + '/api/auth/logout', {
      method: 'POST', headers: { cookie: freshCookie },
    });
    assert.equal(logout.status, 200);
    const afterLogout = await fetch(baseUrl + '/api/auth/me', { headers: { cookie: freshCookie } });
    assert.equal(afterLogout.status, 401);

    async function enrollAccount(staff_id, pin, code) {
      const response = await fetch(baseUrl + '/api/auth/set-pin', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ staff_id, pin, enrollment_code: code }),
      });
      assert.equal(response.status, 201, await response.clone().text());
      return response.headers.get('set-cookie')?.split(';')[0];
    }

    const griffinCookie = await enrollAccount('griffin', '624810', enrollmentCodes.griffin);
    const griffinProfileResponse = await fetch(baseUrl + '/api/auth/me', { headers: { cookie: griffinCookie } });
    assert.equal(griffinProfileResponse.status, 200);
    const griffinProfile = await griffinProfileResponse.json();
    assert.equal(griffinProfile.role, 'admin');
    assert.ok(griffinProfile.permissions.includes('system.configure'));
    assert.equal(griffinProfile.authority_level, 1000);

    const rotaGenerate = await fetch(baseUrl + '/api/workforce/duty-rota/generate', {
      method: 'POST', headers: { cookie: griffinCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ month: '2026-12' }),
    });
    assert.equal(rotaGenerate.status, 200, await rotaGenerate.clone().text());
    const rotaResult = await rotaGenerate.json();
    assert.equal(rotaResult.assigned_days, 31);
    assert.equal(rotaResult.uncovered_dates.length, 0);
    const rotaResponse = await fetch(baseUrl + '/api/workforce/duty-rota?month=2026-12', { headers: { cookie: griffinCookie } });
    assert.equal(rotaResponse.status, 200);
    const rotaRows = await rotaResponse.json();
    assert.equal(rotaRows.length, 31);
    assert.ok(rotaRows.every(row => row.manager_staff_id && row.status === 'assigned'));
    assert.ok(rotaRows.some(row => row.coverage_department_id === 'ISOC'));
    assert.ok(rotaRows.some(row => row.coverage_department_id === 'SCE'));
    for (const managerId of ['hilda','mukasa']) {
      let streak = 0;
      for (const row of rotaRows) {
        if (row.manager_staff_id === managerId) streak++;
        else streak = 0;
        assert.ok(streak <= 5, managerId + ' exceeds the configured Duty Ops work streak');
      }
    }

    const hildaCookie = await enrollAccount('hilda', '624811', enrollmentCodes.hilda);
    const hildaProfile = await (await fetch(baseUrl + '/api/auth/me', { headers: { cookie: hildaCookie } })).json();
    assert.equal(hildaProfile.role, 'duty_ops_manager');
    assert.ok(hildaProfile.permissions.includes('system.configure'));
    assert.ok(hildaProfile.permissions.includes('schedules.publish'));
    assert.equal(hildaProfile.authority_level, 900);

    const hildaOverview = await fetch(baseUrl + '/api/workforce/overview', { headers: { cookie: hildaCookie } });
    assert.equal(hildaOverview.status, 200);
    const protectedSuperior = await fetch(baseUrl + '/api/staff/griffin', {
      method: 'PATCH', headers: { cookie: hildaCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Not Griffin' }),
    });
    assert.equal(protectedSuperior.status, 403);

    const mercyCookie = await enrollAccount('mercy', '624812', enrollmentCodes.mercy);
    const mercyProfile = await (await fetch(baseUrl + '/api/auth/me', { headers: { cookie: mercyCookie } })).json();
    assert.equal(mercyProfile.role, 'hr');
    const hrDirectory = await fetch(baseUrl + '/api/hr/staff', { headers: { cookie: mercyCookie } });
    assert.equal(hrDirectory.status, 200);
    const hrStaffRows = await hrDirectory.json();
    assert.ok(hrStaffRows.some(person => person.id === 'mercy' && person.department_id === 'HR' && person.role === 'hr'));
    assert.ok(hrStaffRows.some(person => person.id === 'mercy-dorice' && person.department_id === 'ISOC' && person.role === 'staff'));
    assert.ok(hrStaffRows.some(person => person.id === 'clinton-juma' && person.active === 1));
    assert.ok(hrStaffRows.some(person => person.id === 'david' && person.active === 0 && person.employment_end_date === '2026-11-30'));

    const overviewPayload = await hildaOverview.json();
    assert.ok(overviewPayload.qualifications.some(q => q.staff_id === 'griffin' && q.department_id === 'ISOC' && q.relief_only === 1));
    assert.ok(overviewPayload.qualifications.some(q => q.staff_id === 'benson' && q.department_id === 'SCE' && q.relief_only === 1));
    assert.ok(overviewPayload.qualifications.some(q => q.staff_id === 'joan' && q.department_id === 'SCE' && q.relief_only === 1));
    assert.ok(overviewPayload.qualifications.some(q => q.staff_id === 'wayne' && q.department_id === 'SCE' && q.relief_only === 1));
    assert.ok(overviewPayload.qualifications.some(q => q.staff_id === 'mercy-dorice' && q.department_id === 'SCE' && q.relief_only === 1));
    const clintonQualification = overviewPayload.qualifications.filter(q => q.staff_id === 'clinton-juma');
    assert.deepEqual(new Set(clintonQualification.map(q => q.department_id)), new Set(['ISOC','SCE']));
    assert.ok(overviewPayload.staff.some(person => person.id === 'david' && person.active === 0));

    const hrRosterAdmin = await fetch(baseUrl + '/api/schedules/generate', {
      method: 'POST', headers: { cookie: mercyCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ month: '2026-12', department_id: 'ISOC' }),
    });
    assert.equal(hrRosterAdmin.status, 403);

    // Routine ISOC generation must never use the SCE relief-only pool.
    const generateDepartment = async department_id => {
      const response = await fetch(baseUrl + '/api/schedules/generate', {
        method: 'POST', headers: { cookie: griffinCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ month: '2026-12', department_id }),
      });
      assert.equal(response.status, 201, await response.clone().text());
      const created = await response.json();
      return await (await fetch(baseUrl + '/api/schedules/' + created.schedule_id, { headers: { cookie: griffinCookie } })).json();
    };
    const initialSce = await generateDepartment('SCE');
    const initialIsoc = await generateDepartment('ISOC');
    for (const [schedule, departmentId] of [[initialSce, 'SCE'], [initialIsoc, 'ISOC']]) {
      for (const row of schedule.assignments.filter(item => item.role === 'duty_ops_manager' && item.shift_code !== 'O')) {
        assert.ok(rotaRows.some(duty => duty.manager_staff_id === row.staff_id
          && duty.duty_date === row.date && duty.coverage_department_id === departmentId),
        'a Duty Ops Manager may cover a desk only on an explicit team-cover rota date');
      }
    }
    assert.ok(!initialIsoc.assignments.some(row => row.staff_id === 'griffin'),
      'SCE staff must not appear as routine ISOC primary staffing');
    assert.ok(!initialIsoc.assignments.some(row => row.staff_id === 'murad'),
      'SCE staff must not be used as a routine ISOC fallback');

    const griffinSceOffDates = new Set(initialSce.assignments
      .filter(row => row.staff_id === 'griffin' && row.shift_code === 'O')
      .map(row => row.date));
    const fullIsocDayDates = [...new Set(initialIsoc.assignments
      .filter(row => row.department_id === 'ISOC' && row.shift_code === 'D')
      .map(row => row.date))];
    const reliefDate = fullIsocDayDates.find(date => griffinSceOffDates.has(date));
    const deniedDate = fullIsocDayDates.find(date => griffinSceOffDates.has(date) && date !== reliefDate);
    assert.ok(reliefDate, 'fixture needs Griffin off in SCE while the ISOC day shift is staffed');
    assert.ok(deniedDate, 'fixture needs a second full-coverage day with Griffin available');

    const requestRelief = (cookie, staff_id, duty_date, display_code = 'D') => fetch(baseUrl + '/api/workforce/relief-assignments', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        staff_id, duty_date, target_department_id: 'ISOC', shift_code: 'D',
        display_code,
        reason: 'Unexpected absence reduced ISOC day staffing below its required minimum',
      }),
    });
    const noShortage = await requestRelief(hildaCookie, 'griffin', deniedDate);
    assert.equal(noShortage.status, 409, await noShortage.clone().text());
    assert.match((await noShortage.json()).error, /already meets its minimum/i);

    // Simulate a genuine last-minute shortage in an isolated D1 fixture.
    wrangler(['d1','execute',database,'--local','--command',
      "UPDATE shift_assignments SET shift_code='O' WHERE schedule_id='" + initialIsoc.id +
      "' AND date='" + reliefDate + "' AND shift_code='D';"
    ], persistDir);
    const reliefRequest = await requestRelief(hildaCookie, 'griffin', reliefDate);
    assert.equal(reliefRequest.status, 201, await reliefRequest.clone().text());
    const requested = await reliefRequest.json();
    const selfApproval = await fetch(baseUrl + '/api/workforce/relief-assignments/' + requested.id, {
      method: 'PATCH', headers: { cookie: hildaCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    assert.equal(selfApproval.status, 403);
    const approval = await fetch(baseUrl + '/api/workforce/relief-assignments/' + requested.id, {
      method: 'PATCH', headers: { cookie: griffinCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    assert.equal(approval.status, 200, await approval.clone().text());

    const isocWithGriffinRelief = await generateDepartment('ISOC');
    const sceWithGriffinRelief = await generateDepartment('SCE');
    const targetRow = isocWithGriffinRelief.assignments.find(row => row.staff_id === 'griffin' && row.date === reliefDate);
    assert.ok(targetRow, 'approved SCE-to-ISOC relief must appear in the receiving roster');
    assert.equal(targetRow.shift_code, 'D');
    assert.equal(targetRow.coverage_department_id, 'ISOC');
    assert.equal(targetRow.coverage_shift_code, 'D');
    const homeRow = sceWithGriffinRelief.assignments.find(row => row.staff_id === 'griffin' && row.date === reliefDate);
    assert.ok(homeRow, 'the source roster must show the person was deployed elsewhere');
    assert.equal(homeRow.coverage_department_id, 'ISOC');

    // Clinton's approved FSA assignment must be visible in his own staff scope.
    const clintonCookie = await enrollAccount('clinton-juma', '624813', enrollmentCodes['clinton-juma']);
    const clintonEmptyRoster = await fetch(baseUrl + '/api/workforce/my-roster?month=2026-12', { headers: { cookie: clintonCookie } });
    assert.equal(clintonEmptyRoster.status, 200);
    assert.deepEqual((await clintonEmptyRoster.json()).my_shifts, {});
    const clintonDate = [...new Set(isocWithGriffinRelief.assignments
      .filter(row => row.department_id === 'ISOC' && row.shift_code === 'D' && row.date !== reliefDate)
      .map(row => row.date))][0];
    assert.ok(clintonDate, 'fixture needs a second ISOC day shift');
    wrangler(['d1','execute',database,'--local','--command',
      "UPDATE shift_assignments SET shift_code='O' WHERE schedule_id='" + isocWithGriffinRelief.id +
      "' AND date='" + clintonDate + "' AND shift_code='D';"
    ], persistDir);
    const clintonRequest = await requestRelief(hildaCookie, 'clinton-juma', clintonDate, 'FSA');
    assert.equal(clintonRequest.status, 201, await clintonRequest.clone().text());
    const clintonRelief = await clintonRequest.json();
    const clintonApproved = await fetch(baseUrl + '/api/workforce/relief-assignments/' + clintonRelief.id, {
      method: 'PATCH', headers: { cookie: griffinCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    assert.equal(clintonApproved.status, 200, await clintonApproved.clone().text());
    const isocWithFsa = await generateDepartment('ISOC');
    const fsaRow = isocWithFsa.assignments.find(row => row.staff_id === 'clinton-juma' && row.date === clintonDate);
    assert.equal(fsaRow?.shift_code, 'FSA');
    assert.equal(fsaRow?.coverage_department_id, 'ISOC');
    assert.equal(fsaRow?.coverage_shift_code, 'D');
    const clintonPersonal = await fetch(baseUrl + '/api/workforce/my-roster?month=2026-12', { headers: { cookie: clintonCookie } });
    assert.equal(clintonPersonal.status, 200);
    const clintonData = await clintonPersonal.json();
    assert.equal(clintonData.my_shifts[clintonDate], 'FSA');
    assert.equal(clintonData.my_shift_details[clintonDate].coverage_department_id, 'ISOC');
    assert.equal(clintonData.my_shift_details[clintonDate].coverage_shift_code, 'D');

    // Mercy Wanyoike records typed leave and training for Mercy Dorice.
    const doriceCookie = await enrollAccount('mercy-dorice', '624814', enrollmentCodes['mercy-dorice']);
    const doriceOffDates = isocWithFsa.assignments
      .filter(row => row.staff_id === 'mercy-dorice' && row.shift_code === 'O')
      .map(row => row.date);
    assert.ok(doriceOffDates.length >= 2, 'Mercy Dorice must have at least two available days');
    const paternityDate = doriceOffDates[0];
    const trainingDate = doriceOffDates.find(date => date !== paternityDate);
    const typedLeave = await fetch(baseUrl + '/api/leave', {
      method: 'POST', headers: { cookie: mercyCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ staff_id: 'mercy-dorice', date: paternityDate, status: 'approved', leave_type: 'PL' }),
    });
    assert.equal(typedLeave.status, 201, await typedLeave.clone().text());
    const trainee = await fetch(baseUrl + '/api/workforce/staff-markers', {
      method: 'POST', headers: { cookie: mercyCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ staff_id: 'mercy-dorice', date: trainingDate, marker_code: 'T', reason: 'New ISOC controller induction with assigned supervisor' }),
    });
    assert.equal(trainee.status, 201, await trainee.clone().text());
    const regeneratedIsoc = await generateDepartment('ISOC');
    assert.equal(regeneratedIsoc.assignments.find(row => row.staff_id === 'mercy-dorice' && row.date === paternityDate)?.shift_code, 'PL');
    assert.equal(regeneratedIsoc.assignments.find(row => row.staff_id === 'mercy-dorice' && row.date === trainingDate)?.shift_code, 'T');
    const doricePersonal = await fetch(baseUrl + '/api/workforce/my-roster?month=2026-12', { headers: { cookie: doriceCookie } });
    assert.equal(doricePersonal.status, 200);
    const doriceData = await doricePersonal.json();
    assert.equal(doriceData.my_shifts[paternityDate], 'PL');
    assert.equal(doriceData.my_shifts[trainingDate], 'T');

    const reliefLeaveConflict = await fetch(baseUrl + '/api/leave', {
      method: 'POST', headers: { cookie: mercyCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ staff_id: 'clinton-juma', date: clintonDate, status: 'approved', leave_type: 'SL' }),
    });
    assert.equal(reliefLeaveConflict.status, 409);
    const visibleRelief = await fetch(baseUrl + '/api/workforce/relief-assignments?month=2026-12', { headers: { cookie: hildaCookie } });
    assert.equal(visibleRelief.status, 200);
    const reliefItems = await visibleRelief.json();
    assert.ok(reliefItems.some(row => row.id === requested.id && row.status === 'approved'));
    assert.ok(reliefItems.some(row => row.id === clintonRelief.id && row.status === 'approved'));
  } finally {
    if (worker) {
      // Wrangler's npx shim launches workerd/esbuild descendants. Kill the
      // whole process group so a failed assertion cannot leave CI hanging.
      try {
        if (process.platform !== 'win32') process.kill(-worker.pid, 'SIGTERM');
        else worker.kill('SIGTERM');
      } catch {
        worker.kill('SIGTERM');
      }
      await new Promise(resolve => {
        if (worker.exitCode !== null) return resolve();
        const timer = setTimeout(resolve, 3_000);
        worker.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    await rm(persistDir, { recursive: true, force: true });
  }
});
