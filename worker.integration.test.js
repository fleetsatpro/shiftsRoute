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
    const hrRosterAdmin = await fetch(baseUrl + '/api/schedules/generate', {
      method: 'POST', headers: { cookie: mercyCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ month: '2026-12', department_id: 'ISOC' }),
    });
    assert.equal(hrRosterAdmin.status, 403);
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
