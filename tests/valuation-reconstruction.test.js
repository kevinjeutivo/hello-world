#!/usr/bin/env node
'use strict';
// tests/valuation-reconstruction.test.js -- deterministic tests for two
// fixes to js/ticker.js's historical valuation reconstruction:
//
//   1. _mhFindReportInfo() used to do an UNBOUNDED "earliest earnings
//      date at or after quarter-end" search. If the correct quarter's
//      report was missing from tracked earnings history (a data gap),
//      it would silently attach the FOLLOWING quarter's report instead
//      -- a valid-looking but wrong report date, price, and TTM
//      multiple. Now bounded to _MH_MAX_REPORT_LAG_DAYS (120 days).
//
//   2. _updateNextFYHistory() used to archive the current fiscal-year
//      track and start a new one on a SINGLE fetch reporting a
//      different +1y end date. A transient Yahoo data inconsistency
//      (glitch-then-revert) could archive a perfectly good, still-
//      current year. Now requires the same new end date on two
//      CONSECUTIVE fetches, plus a chronological-plausibility check
//      (roughly a fiscal year later, not backward or nonsensical).
//
// Runs the actual shipped source in a Node vm context.
//
// Usage: node tests/valuation-reconstruction.test.js

const fs=require('fs');
const path=require('path');
const vm=require('vm');
const assert=require('assert');

const ROOT=path.join(__dirname,'..');

function makeLocalStorage(){
  const store=new Map();
  return{
    getItem:k=>store.has(k)?store.get(k):null,
    setItem:(k,v)=>{store.set(k,String(v));},
    removeItem:k=>{store.delete(k);},
    clear:()=>store.clear(),
  };
}

function buildContext(){
  const ctx=vm.createContext({
    console,
    localStorage:makeLocalStorage(),
    window:{},
    toast:()=>{},
    document:{getElementById:()=>null,addEventListener:()=>{}},
  });
  const src=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
  vm.runInContext(src('js/storage.js'),ctx,{filename:'js/storage.js'});
  vm.runInContext(src('js/helpers.js'),ctx,{filename:'js/helpers.js'});
  vm.runInContext(src('js/wheelbacktest.js'),ctx,{filename:'js/wheelbacktest.js'});
  vm.runInContext(src('js/ticker.js'),ctx,{filename:'js/ticker.js'});
  return ctx;
}

function run(ctx,expr){ return vm.runInContext(expr,ctx); }

let pass=0,fail=0;
function test(name,fn){
  try{ fn(); pass++; console.log('  ok  --',name); }
  catch(e){ fail++; console.log('FAIL  --',name); console.log('      '+(e && e.stack ? e.stack.split('\n').slice(0,3).join('\n      ') : e)); }
}
function section(name){ console.log('\n== '+name+' =='); }

// Seeds earnings_hist_<ticker> in the shape _getEarningsWithOverrides
// expects (a cache wrapper around a plain array of {date,hour} entries,
// all within the 730-day purge window).
function seedEarnings(ctx,ticker,entries){
  run(ctx,`S.set('earnings_hist_${ticker}',{data:${JSON.stringify(entries)}})`);
}

// ============================================================================
section('_mhFindReportInfo: bounded report-date matching (Fix 1)');

test('finds the correct report when it exists, unaffected by the bound', ()=>{
  const ctx=buildContext();
  seedEarnings(ctx,'TEST',[{date:'2026-05-15',hour:'bmo'}]);
  const info=run(ctx,'_mhFindReportInfo')('TEST','2026-03-31');
  assert(info);
  assert.strictEqual(info.date,'2026-05-15');
});

test('regression: when the correct quarter is missing, no longer silently attaches the FOLLOWING quarter\'s report months later', ()=>{
  const ctx=buildContext();
  // Q1 (ended 2026-03-31) report is MISSING from earnings history --
  // only Q2's report (ended 2026-06-30, reporting ~2026-08-15) is
  // present. An unbounded search would have grabbed this as if it were
  // Q1's report -- 137 days after Q1's quarter-end, well past any real
  // reporting cadence.
  seedEarnings(ctx,'TEST',[{date:'2026-08-15',hour:'bmo'}]);
  const info=run(ctx,'_mhFindReportInfo')('TEST','2026-03-31');
  assert.strictEqual(info,null,'must NOT attach a report 137 days out -- that is a different quarter entirely');
});

test('accepts a genuinely late reporter within the bound (close to but under 120 days)', ()=>{
  const ctx=buildContext();
  seedEarnings(ctx,'TEST',[{date:'2026-07-20',hour:'bmo'}]); // 111 days after 2026-03-31
  const info=run(ctx,'_mhFindReportInfo')('TEST','2026-03-31');
  assert(info,'a report 111 days out is still within the 120-day bound');
  assert.strictEqual(info.date,'2026-07-20');
});

test('rejects a report just past the bound, picks nothing rather than guessing', ()=>{
  const ctx=buildContext();
  seedEarnings(ctx,'TEST',[{date:'2026-08-01',hour:'bmo'}]); // 123 days after 2026-03-31
  const info=run(ctx,'_mhFindReportInfo')('TEST','2026-03-31');
  assert.strictEqual(info,null);
});

test('with a report BOTH within and past the bound available, picks the in-bound one, not just the earliest overall', ()=>{
  const ctx=buildContext();
  seedEarnings(ctx,'TEST',[{date:'2026-08-01',hour:'bmo'},{date:'2026-05-01',hour:'amc'}]);
  const info=run(ctx,'_mhFindReportInfo')('TEST','2026-03-31');
  assert(info);
  assert.strictEqual(info.date,'2026-05-01');
});

// ============================================================================
section('_updateNextFYHistory: two-fetch confirmation + plausibility (Fix 2)');

function snapWithP1Y(endDate,epsMean){
  return{price:100,earningsTrend:[{period:'+1y',endDate,epsMean}]};
}
const EMPTY_HIST2Y={timestamps:[],closes:[]};

test('first-ever observation for a ticker starts tracking directly, no confirmation needed (nothing to protect yet)', ()=>{
  const ctx=buildContext();
  run(ctx,'_updateNextFYHistory')('TEST',snapWithP1Y('2027-12-31',5.00),EMPTY_HIST2Y);
  const track=run(ctx,`S.get('nextfy_track_TEST')`);
  assert(track);
  assert.strictEqual(track.targetFYEnd,'2027-12-31');
  assert.strictEqual(track.entries.length,1);
});

test('regression: a SINGLE differing fetch does not roll over -- waits for confirmation', ()=>{
  const ctx=buildContext();
  run(ctx,'_updateNextFYHistory')('TEST',snapWithP1Y('2027-12-31',5.00),EMPTY_HIST2Y);
  // One fetch reporting a different end date (simulating a glitch).
  run(ctx,'_updateNextFYHistory')('TEST',snapWithP1Y('2028-12-31',5.20),EMPTY_HIST2Y);
  const track=run(ctx,`S.get('nextfy_track_TEST')`);
  const hist=run(ctx,`S.get('nextfy_hist_TEST')`);
  assert.strictEqual(track.targetFYEnd,'2027-12-31','must NOT have rolled over on one observation');
  assert.strictEqual(track.pendingFYEnd,'2028-12-31','the new value should be noted as pending');
  assert(!hist||!hist.length,'nothing should be archived yet');
});

test('a glitch that reverts on the very next fetch never accumulates a second confirmation -- no rollover, no archive', ()=>{
  const ctx=buildContext();
  run(ctx,'_updateNextFYHistory')('TEST',snapWithP1Y('2027-12-31',5.00),EMPTY_HIST2Y);
  run(ctx,'_updateNextFYHistory')('TEST',snapWithP1Y('2028-12-31',5.20),EMPTY_HIST2Y); // glitch, 1st sighting
  run(ctx,'_updateNextFYHistory')('TEST',snapWithP1Y('2027-12-31',5.00),EMPTY_HIST2Y); // reverts back
  const track=run(ctx,`S.get('nextfy_track_TEST')`);
  const hist=run(ctx,`S.get('nextfy_hist_TEST')`);
  assert.strictEqual(track.targetFYEnd,'2027-12-31');
  assert.strictEqual(track.pendingFYEnd,null,'the stale pending marker must be cleared once the value reverts');
  assert(!hist||!hist.length,'the original track was never actually endangered -- nothing to archive');
});

test('the SAME new end date confirmed on two CONSECUTIVE fetches, chronologically plausible -- rolls over and archives', ()=>{
  const ctx=buildContext();
  run(ctx,'_updateNextFYHistory')('TEST',snapWithP1Y('2027-12-31',5.00),EMPTY_HIST2Y);
  run(ctx,'_updateNextFYHistory')('TEST',snapWithP1Y('2028-12-31',5.20),EMPTY_HIST2Y); // 1st sighting
  run(ctx,'_updateNextFYHistory')('TEST',snapWithP1Y('2028-12-31',5.20),EMPTY_HIST2Y); // 2nd, confirmed -- 366 days later, plausible
  const track=run(ctx,`S.get('nextfy_track_TEST')`);
  const hist=run(ctx,`S.get('nextfy_hist_TEST')`);
  assert.strictEqual(track.targetFYEnd,'2028-12-31','should now be tracking the new fiscal year');
  assert(hist&&hist.length===1,'the old fiscal year should be archived exactly once');
  assert.strictEqual(hist[0].fyEndDate,'2027-12-31');
});

test('confirmed twice but chronologically IMPLAUSIBLE (backward) -- does not roll over even with two matching observations', ()=>{
  const ctx=buildContext();
  run(ctx,'_updateNextFYHistory')('TEST',snapWithP1Y('2027-12-31',5.00),EMPTY_HIST2Y);
  // "New" end date is actually EARLIER than the current one -- two
  // stale/bad reads in a row, not a real rollover.
  run(ctx,'_updateNextFYHistory')('TEST',snapWithP1Y('2027-06-30',5.20),EMPTY_HIST2Y);
  run(ctx,'_updateNextFYHistory')('TEST',snapWithP1Y('2027-06-30',5.20),EMPTY_HIST2Y);
  const track=run(ctx,`S.get('nextfy_track_TEST')`);
  const hist=run(ctx,`S.get('nextfy_hist_TEST')`);
  assert.strictEqual(track.targetFYEnd,'2027-12-31','must not roll over to an earlier date');
  assert(!hist||!hist.length);
});

test('confirmed twice but chronologically IMPLAUSIBLE (too small a gap) -- does not roll over', ()=>{
  const ctx=buildContext();
  run(ctx,'_updateNextFYHistory')('TEST',snapWithP1Y('2027-12-31',5.00),EMPTY_HIST2Y);
  run(ctx,'_updateNextFYHistory')('TEST',snapWithP1Y('2028-01-15',5.20),EMPTY_HIST2Y); // only 15 days later
  run(ctx,'_updateNextFYHistory')('TEST',snapWithP1Y('2028-01-15',5.20),EMPTY_HIST2Y);
  const track=run(ctx,`S.get('nextfy_track_TEST')`);
  assert.strictEqual(track.targetFYEnd,'2027-12-31','a 15-day jump is not a real fiscal-year rollover');
});

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
