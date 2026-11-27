import { pbkdf2Sync, randomBytes } from 'node:crypto';
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
const salt = randomBytes(16).toString('hex');
const hash = pbkdf2Sync(pin, Buffer.from(salt, 'hex'), 310000, 32, 'sha256').toString('hex');
const values = demoStaff.map(person =>
  `('${person.id}', '${person.name}', 'ISOC', 1, '${person.role}', '${hash}', '${salt}', 1)`
).join(',\n');

const sql = [
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
