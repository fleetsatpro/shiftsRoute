import { hashPin } from '../auth.js';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const database = 'raw-ter-shift-pr1-e2e';
const configFile = 'wrangler.routesa.e2e-preview.toml';
const databaseId = '8da5bc85-6f45-44a4-b00d-4b93692fd643';
const pin = process.env.E2E_DEMO_PIN || '';

if (!/^\d{6}$/.test(pin)) throw new Error('E2E_DEMO_PIN must be a six-digit value.');
const mode = process.env.E2E_D1_MODE || 'remote';
const persistTo = process.env.E2E_D1_PERSIST_TO || '';
if (!['local', 'remote'].includes(mode)) throw new Error('E2E_D1_MODE must be local or remote.');
if (mode === 'remote' && (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID)) {
  throw new Error('Cloudflare preview credentials are required for the isolated remote D1 seed.');
}
if (mode === 'local' && !persistTo) throw new Error('E2E_D1_PERSIST_TO is required for a local D1 seed.');

const config = await readFile(configFile, 'utf8');
if (!config.includes(`database_name = "${database}"`) || !config.includes(`database_id = "${databaseId}"`)) {
  throw new Error('Refusing to seed: the Wrangler config does not target the dedicated PR E2E D1 database.');
}

const demoStaff = [
  { id: 'e2e-admin', name: 'Demo Administrator', role: 'admin' },
  { id: 'e2e-operator', name: 'Demo Operator', role: 'staff' },
  { id: 'e2e-night', name: 'Night Controller', role: 'staff' },
];
const credentials = await Promise.all(demoStaff.map(() => hashPin(pin)));
const values = demoStaff.map((person, index) => {
  const credential = credentials[index];
  return `('${person.id}', '${person.name}', 'ISOC', 1, '${person.role}', '${credential.hash}', '${credential.salt}', 1)`;
}).join(',\n');

const sql = [
  'DELETE FROM workforce_shift_exceptions;',
  'DELETE FROM duty_ops_assignments;',
  'DELETE FROM workforce_audit_events;',
  'DELETE FROM staff_department_qualifications;',
  'DELETE FROM staff_shift_policies;',
  'DELETE FROM swap_requests;',
  'DELETE FROM shift_assignments;',
  'DELETE FROM leave_requests;',
  'DELETE FROM sessions;',
  'DELETE FROM auth_attempts;',
  'DELETE FROM app_settings;',
  'DELETE FROM schedules;',
  'DELETE FROM staff;',
  'INSERT INTO staff (id, name, department_id, active, role, pin_hash, pin_salt, pin_set) VALUES',
  values + ';',
  "INSERT INTO staff_shift_policies (staff_id, night_mode, max_consecutive_days, min_rest_hours, effective_from) SELECT id, 'allowed', 5, 11, date('now') FROM staff;",
  "INSERT INTO staff_department_qualifications (staff_id, department_id, can_day, can_night, priority, effective_from, approval_note) SELECT id, 'ISOC', 1, 1, 100, date('now'), 'Synthetic E2E qualification' FROM staff;",
].join('\n');

const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const d1Args = ['wrangler', 'd1', 'execute', database];
if (mode === 'local') d1Args.push('--local', '--persist-to', persistTo);
else d1Args.push('--remote');
d1Args.push('--config', configFile, '--command', sql);
const result = spawnSync(executable, d1Args, { stdio: 'inherit', env: process.env });

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Wrangler D1 seed failed with exit code ${result.status}.`);
process.stdout.write('Dedicated E2E D1 reseeded with three synthetic ISOC accounts.\n');
