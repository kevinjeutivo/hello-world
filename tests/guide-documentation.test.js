// Guide documentation integration regression checks — Build 540.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const guide = src.split('<div id="tab-guide" class="tab-panel">')[1]?.split('<!-- SETTINGS OVERLAY -->')[0];
assert.ok(guide, 'Guide section must exist');
for (const phrase of [
  'EPS estimate revisions noticed', 'first observed', 'not a complete revision log',
  'Approaching Strike (OTM)', 'Dashboard button alert', 'All Accounts warning badges',
  'median simulated return', '“Worst”', 'Options chain freshness',
  'Missing or failed chains', 'Fetched', 'not that every option quote',
]) assert.ok(guide.includes(phrase), `Guide missing: ${phrase}`);
for (const id of ['layers','wheel','multhist','dashanalytics','options','data','income','about']) {
  assert.ok(guide.includes(`id="gb-${id}"`), `Missing Guide section ${id}`);
}
assert.equal((guide.match(/id="gb-[^"]+"/g)||[]).length, new Set((guide.match(/id="gb-[^"]+"/g)||[])).size, 'Duplicate Guide body IDs');
console.log('Guide documentation integration checks passed');
