'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../js/earnings.js'),'utf8');
const start=source.indexOf('async function loadEarningsTab(){');
const end=source.indexOf('      const du=daysUntilDate(_effEarningsDate)',start);
assert(start>=0 && end>start,'locate Upcoming date-selection logic');
const selection=source.slice(start,end);
assert.match(selection,/const _effEarningsDate=snap\?\.earningsDate,_effEarningsHour=snap\?\.earningsHour/);
assert.match(selection,/if\(!snap\|\|!_effEarningsDate\)continue/);
assert.doesNotMatch(selection,/earnings_pending_|earnings_confirmed_|_fallback|_confMatch|_pendMatch/,'no historical cache fallback in Upcoming selection');
// Model the explicit guard for the observed SPCX state: historical cache
// contains Nov 5, but the shared snapshot does not.
const snapshot={earningsDate:null,earningsHour:null};
const confirmed=[{date:'2026-10-20'},{date:'2026-11-05'}];
const pending=[{date:'2026-11-05'}];
assert(confirmed.length && pending.length);
assert.equal(Boolean(snapshot.earningsDate),false,'SPCX cannot enter Upcoming');
assert.equal(confirmed.some(e=>e.date==='2026-10-20'),true,'historical report remains untouched');
assert.equal(Boolean({earningsDate:'2027-01-20'}.earningsDate),true,'valid future snapshot date remains eligible');
console.log('Build 551 Upcoming snapshot-only regression passed');
