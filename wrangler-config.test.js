import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function stringField(source, field) {
  const match = source.match(new RegExp('^' + field + ' = "([^"]+)"$', 'm'));
  assert.ok(match, `Missing string field: ${field}`);
  return match[1];
}

function databaseConfig(source) {
  return {
    name: stringField(source, 'database_name'),
    id: stringField(source, 'database_id'),
    binding: stringField(source, 'binding'),
    migrationsDir: stringField(source, 'migrations_dir'),
  };
}

test('production Wrangler config points to the named production D1 database', () => {
  const source = read('./wrangler.toml');
  const db = databaseConfig(source);

  assert.equal(stringField(source, 'name'), 'routesa');
  assert.equal(db.name, 'raw-ter-shift');
  assert.equal(db.id, '198290bf-6d88-4225-96c1-a525c57f41eb');
  assert.notEqual(db.id, 'REPLACE_WITH_YOUR_D1_DATABASE_ID');
  assert.equal(db.binding, 'DB');
  assert.equal(db.migrationsDir, 'migrations');
  assert.match(source, /^workers_dev = false$/m);
  assert.match(source, /^preview_urls = false$/m);
});

test('both non-production Workers target the isolated preview D1 database', () => {
  const routesa = read('./wrangler.routesa.preview.toml');
  const shiftsroutes = read('./wrangler.shiftsroutes.preview.toml');
  const production = databaseConfig(read('./wrangler.toml'));
  const a = databaseConfig(routesa);
  const b = databaseConfig(shiftsroutes);

  assert.equal(stringField(routesa, 'name'), 'routesa');
  assert.equal(stringField(shiftsroutes, 'name'), 'shiftsroutes');
  for (const [source, db] of [[routesa, a], [shiftsroutes, b]]) {
    assert.equal(db.name, 'raw-ter-shift-preview');
    assert.equal(db.id, '754b2777-5bbf-4a6d-9da9-3e6f712f3611');
    assert.notEqual(db.id, production.id);
    assert.equal(db.binding, 'DB');
    assert.equal(db.migrationsDir, 'migrations');
    assert.match(source, /^workers_dev = false$/m);
    assert.match(source, /^preview_urls = false$/m);
    assert.match(source, /^ENVIRONMENT = "preview"$/m);
  }
});

test('the ordered D1 migration chain is present and contiguous', () => {
  const names = readdirSync(new URL('./migrations/', import.meta.url))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  assert.deepEqual(names, [
    '0001_init.sql',
    '0002_auth.sql',
    '0003_prod.sql',
    '0004_auth_hardening.sql',
    '0005_seed_patrick.sql',
    '0006_workforce_operating_model.sql',
    '0007_reference_roster_relief.sql',
  ]);
});


test('hosted preview E2E uses a distinct isolated synthetic-only D1 database', () => {
  const e2eSource = read('./wrangler.routesa.e2e-preview.toml');
  const e2eDb = databaseConfig(e2eSource);
  const production = databaseConfig(read('./wrangler.toml'));
  const sharedPreview = databaseConfig(read('./wrangler.routesa.preview.toml'));
  assert.equal(stringField(e2eSource, 'name'), 'shiftsroute-e2e');
  assert.equal(e2eDb.name, 'raw-ter-shift-pr1-e2e');
  assert.equal(e2eDb.id, '8da5bc85-6f45-44a4-b00d-4b93692fd643');
  assert.notEqual(e2eDb.id, production.id);
  assert.notEqual(e2eDb.id, sharedPreview.id);
  assert.equal(e2eDb.binding, 'DB');
  assert.equal(e2eDb.migrationsDir, 'migrations');
  assert.match(e2eSource, /^workers_dev = false$/m);
  assert.match(e2eSource, /^preview_urls = true$/m);
});

test('hosted Worker preview E2E is enabled for same-repository PRs, not just PR #1', () => {
  const workflow = read('./.github/workflows/ci.yml');
  assert.match(workflow, /github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.doesNotMatch(workflow, /pull_request\.number == 1/);
  assert.match(workflow, /group: shiftsroute-worker-preview-e2e/);
});
