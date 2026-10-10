'use strict';
// Static syntax check of every JS file (server + browser), since the project has no build step or linter dependency.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'data' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
let bad = 0;
for (const f of walk(path.resolve(__dirname, '..'))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad++; console.error(`✖ ${f}\n${e.stderr}`); }
}
console.log(bad ? `${bad} file(s) failed` : 'All JS files parse cleanly'); process.exit(bad ? 1 : 0);
