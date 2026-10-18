const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<span class="guide-key">Year-end closure<\/span><span class="guide-val">([^<]*)<\/span>/);
assert.ok(m, 'Year-end closure entry must exist');
for (const phrase of ['concurrent chains', 'December 31', 'does not guarantee', '30-day window extending into January', 'straddle rules', 'assignments']) assert.ok(m[1].includes(phrase), phrase);
assert.ok(!m[1].includes('This makes the aggregate tax result equivalent'), 'old guarantee must be removed');
console.log('Guide year-end closure regression passed');
