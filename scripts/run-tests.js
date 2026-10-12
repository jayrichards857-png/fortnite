'use strict';
// `npm test`: runs the suite against a THROWAWAY PostgreSQL server. Every test file creates and drops its own pp_test_* database there,
// so nothing real is ever touched. Start a local throwaway server with:  scripts/pg-test.sh start && eval "$(scripts/pg-test.sh env)"
//   PAIRPLUG_TEST_PG   admin connection URL (default postgres://postgres@127.0.0.1:5432/postgres)
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const testdb = require('../test/testdb');

(async () => {
  const url = testdb.adminUrl();
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await c.connect(); await c.end(); }
  catch (e) {
    console.error(`Cannot reach the test PostgreSQL server (${new URL(url).host}): ${e.message}\n\nThe tests need a throwaway PostgreSQL 16 server. To start one locally:\n\n    scripts/pg-test.sh start\n    eval "$(scripts/pg-test.sh env)"\n    npm test\n\nor point PAIRPLUG_TEST_PG at another local server you do not mind the tests creating pp_test_* databases on.`);
    process.exit(2);
  }
  const dir = path.join(__dirname, '..', 'test');
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const files = only.length ? only : fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).map((f) => path.join('test', f));
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=120000', ...files], { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  process.exit(r.status === null ? 1 : r.status);
})();
