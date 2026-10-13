'use strict';
// Administrator recovery CLI (scripts/create-admin.js): the safety rails for a REMOTE database and the reset of an existing admin.
// "Remote" is simulated with the host 0.0.0.0, which reaches the local disposable test server but is not treated as a local host name.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');
const testdb = require('./testdb');
const root = path.resolve(__dirname, '..');

const cli = (args, url, env = {}) => spawnSync(process.execPath, ['scripts/create-admin.js', ...args], { cwd: root, encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, DATABASE_URL: url, PUBLIC_URL: '', ...env } });
const migrate = (url) => spawnSync(process.execPath, ['scripts/migrate.js', '--apply', '--confirm-host', new URL(url).hostname], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, DATABASE_URL_UNPOOLED: url, PAIRPLUG_DB_LABEL: 'preview' } });
const remote = (u) => u.replace('127.0.0.1', '0.0.0.0');
const sql = async (url, text, params) => { const c = new Client({ connectionString: url }); await c.connect(); try { return (await c.query(text, params)).rows; } finally { await c.end(); } };

test('remote target: writes need the label and the exact host; an empty (unmigrated) remote database is never created or altered', async () => {
  const db = testdb.createSync();
  try {
    const url = remote(db.url), host = '0.0.0.0', tables = async () => Number((await sql(db.url, "SELECT COUNT(*) n FROM pg_tables WHERE schemaname = 'public'"))[0].n);
    const a = cli(['reset', '--email', 'jayrichards857@gmail.com'], url, { PAIRPLUG_DB_LABEL: 'production' }); assert.notEqual(a.status, 0); assert.match(a.stderr, /--confirm-host 0\.0\.0\.0/);
    const b = cli(['reset', '--email', 'jayrichards857@gmail.com', '--confirm-host', host], url); assert.notEqual(b.status, 0); assert.match(b.stderr, /PAIRPLUG_DB_LABEL/);
    const c = cli(['reset', '--email', 'jayrichards857@gmail.com', '--confirm-host', 'other.example'], url, { PAIRPLUG_DB_LABEL: 'production' }); assert.notEqual(c.status, 0);
    const d = cli(['reset', '--email', 'jayrichards857@gmail.com', '--confirm-host', host], url, { PAIRPLUG_DB_LABEL: 'production' });
    assert.notEqual(d.status, 0); assert.match(d.stderr, /schema is version 0/); assert.match(d.stdout, /database: 0\.0\.0\.0\/.* \(REMOTE\)/);
    assert.equal(await tables(), 0, 'nothing was created in the remote database');
    const s = cli(['status'], url); assert.match(s.stderr, /schema is version 0/); assert.equal(await tables(), 0, 'even a read-only command does not migrate a remote database');
    assert.doesNotMatch(a.stdout + a.stderr + d.stdout + d.stderr, /postgres(ql)?:\/\//, 'no connection string is printed');
  } finally { testdb.dropSync(db.name); }
});

test('remote target, existing admin: reset gives ONE temporary password (hash stored), forces a change, signs the admin out, and touches nobody else', async () => {
  const db = testdb.createSync();
  try {
    assert.equal(migrate(db.url).status, 0);
    const email = 'jayrichards857@gmail.com', url = remote(db.url), L = { PAIRPLUG_DB_LABEL: 'production' };
    // an existing admin (created the normal way on the local target), another admin-less user, a session for the admin
    const setup = cli(['setup', '--email', email], db.url); assert.equal(setup.status, 0, setup.stderr);
    await sql(db.url, "INSERT INTO users(email, password_hash, display_name, created_at) VALUES('buyer@example.test', 'buyer-hash', 'Buyer', 1)");
    const adminId = (await sql(db.url, 'SELECT id FROM users WHERE email = $1', [email]))[0].id, before = (await sql(db.url, 'SELECT id, email, password_hash, is_admin FROM users ORDER BY id'));
    await sql(db.url, "INSERT INTO sessions(token_hash, user_id, expires_at) VALUES('x', $1, 9999999999)", [adminId]);
    assert.equal(Number((await sql(db.url, 'SELECT COUNT(*) n FROM sessions WHERE user_id = $1', [adminId]))[0].n), 1);
    const st = cli(['status'], url); assert.equal(st.status, 0, st.stderr); assert.match(st.stdout, new RegExp(email)); assert.match(st.stdout, /\(REMOTE\)/);
    const r = cli(['reset', '--email', email, '--confirm-host', '0.0.0.0'], url, L);
    assert.equal(r.status, 0, r.stderr); const pw = /\n {4}(\S{20})\n/.exec(r.stdout)[1]; assert.ok(pw, 'a temporary password is shown once');
    const after = await sql(db.url, 'SELECT id, email, password_hash, is_admin, must_change_password FROM users ORDER BY id');
    const a = after.find((u) => u.email === email), a0 = before.find((u) => u.email === email), other = after.find((u) => u.email === 'buyer@example.test');
    assert.notEqual(a.password_hash, a0.password_hash); assert.ok(!a.password_hash.includes(pw), 'only a hash is stored'); assert.equal(Number(a.must_change_password), 1); assert.equal(Number(a.is_admin), 1);
    assert.deepEqual(other, { ...before.find((u) => u.email === 'buyer@example.test'), must_change_password: other.must_change_password }, 'other users untouched');
    assert.equal(after.length, before.length, 'no account created'); assert.equal(Number((await sql(db.url, 'SELECT COUNT(*) n FROM sessions WHERE user_id = $1', [adminId]))[0].n), 0, 'admin signed out everywhere');
    assert.ok((await sql(db.url, "SELECT 1 FROM audit_log WHERE action = 'admin_password_reset'")).length === 1);
    const { verifyPassword } = require('../src/auth'); assert.equal(verifyPassword(pw, a.password_hash), true, 'the displayed password is the new one');
    // refusals: unknown email, and an account that is not an admin
    assert.match(cli(['reset', '--email', 'nobody@example.test', '--confirm-host', '0.0.0.0'], url, L).stderr, /No account/);
    assert.match(cli(['reset', '--email', 'buyer@example.test', '--confirm-host', '0.0.0.0'], url, L).stderr, /not an administrator/);
    assert.equal(Number((await sql(db.url, 'SELECT COUNT(*) n FROM users'))[0].n), before.length);
  } finally { testdb.dropSync(db.name); }
});
