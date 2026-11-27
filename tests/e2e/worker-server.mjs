import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const database = 'raw-ter-shift-pr1-e2e';
const config = 'wrangler.routesa.e2e-preview.toml';
const baseUrl = 'http://127.0.0.1:8788';
const persistTo = await mkdtemp(join(tmpdir(), 'shiftsroute-browser-d1-'));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
let worker;
let stopping = false;

function runWrangler(args, env = process.env) {
  const result = spawnSync(npx, ['wrangler', ...args], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Wrangler command failed (${result.status}): ${args.join(' ')}`);
}

async function stopWorker() {
  if (worker?.pid && worker.exitCode === null) {
    try {
      if (process.platform !== 'win32') process.kill(-worker.pid, 'SIGTERM');
      else worker.kill('SIGTERM');
    } catch {}
    await Promise.race([
      new Promise(resolve => worker.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 4_000)),
    ]);
    if (worker.exitCode === null) {
      try {
        if (process.platform !== 'win32') process.kill(-worker.pid, 'SIGKILL');
        else worker.kill('SIGKILL');
      } catch {}
    }
  }
}

try {
  if (!/^\d{6}$/.test(process.env.E2E_DEMO_PIN || '')) {
    throw new Error('Set E2E_DEMO_PIN to a six-digit test-only value before starting the local Worker.');
  }

  runWrangler(['d1', 'migrations', 'apply', database, '--local', '--config', config, '--persist-to', persistTo]);
  runWrangler(['d1', 'execute', database, '--local', '--config', config, '--persist-to', persistTo, '--command', 'SELECT 1;']);

  const seedEnv = {
    ...process.env,
    E2E_D1_MODE: 'local',
    E2E_D1_PERSIST_TO: persistTo,
  };
  const seeded = spawnSync(process.execPath, ['scripts/seed-e2e-preview.mjs'], {
    cwd: process.cwd(),
    env: seedEnv,
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (seeded.error) throw seeded.error;
  if (seeded.status !== 0) throw new Error(`Local D1 seed failed with exit code ${seeded.status}.`);

  worker = spawn(npx, [
    'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', '8788',
    '--config', config, '--persist-to', persistTo, '--log-level', 'error',
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  });

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (worker.exitCode !== null) throw new Error(`Local Worker exited during startup (${worker.exitCode}).`);
    try {
      const response = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(1_500) });
      if (response.ok) {
        const health = await response.json();
        if (health.ok === true) { ready = true; break; }
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Local Wrangler Worker did not become healthy at ' + baseUrl);
  process.stdout.write('Local Wrangler Worker ready at ' + baseUrl + ' with isolated synthetic D1 data.\n');

  await new Promise((resolve, reject) => {
    worker.once('exit', (code, signal) => {
      if (stopping) resolve();
      else reject(new Error(`Local Worker stopped unexpectedly (code=${code}, signal=${signal}).`));
    });
    const onSignal = () => {
      stopping = true;
      resolve();
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  });
} finally {
  stopping = true;
  await stopWorker();
  await rm(persistTo, { recursive: true, force: true });
}
