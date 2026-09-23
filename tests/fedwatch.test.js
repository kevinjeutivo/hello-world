#!/usr/bin/env node
'use strict';
// tests/fedwatch.test.js -- deterministic tests for the FOMC / Fed Funds
// Futures Phase-1 fix (build 495): day-count correction, NY-Fed-official
// resolution of past meetings, and the forecast/history contamination fix.
//
// Runs the ACTUAL shipped js/storage.js, js/helpers.js and js/market.js
// source inside a Node vm context (never a hand-reimplemented stand-in --
// see income-engine-working-practices.md §1: "Extract and test the actual
// shipped code... a reimplementation can accidentally 'fix' the bug in the
// test harness without validating what actually ships"), with a minimal
// in-memory localStorage and a fixed system clock so meeting-past/future
// classification is reproducible regardless of when this is actually run.
//
// Usage: node tests/fedwatch.test.js

const fs=require('fs');
const path=require('path');
const vm=require('vm');
const assert=require('assert');

const ROOT=path.join(__dirname,'..');

// ── Minimal in-memory localStorage, backing the REAL storage.js's S ──────
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
  const localStorage=makeLocalStorage();
  const ctx=vm.createContext({
    console,
    localStorage,
    window:{},
    toast:()=>{}, // storage.js's S.set only calls this on a write failure
  });
  const src=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
  vm.runInContext(src('js/storage.js'),ctx,{filename:'js/storage.js'});
  vm.runInContext(src('js/helpers.js'),ctx,{filename:'js/helpers.js'});
  vm.runInContext(src('js/market.js'),ctx,{filename:'js/market.js'});
  return ctx;
}

// ── Fixed-clock helper -- overrides Date for the duration of fn() only,
// so _todayET() (which calls `new Date()` internally) is deterministic. ──
function withFixedNow(ctx,isoInstant,fn){
  const RealDate=vm.runInContext('Date',ctx);
  function FixedDate(...args){
    if(args.length===0)return new RealDate(isoInstant);
    return new RealDate(...args);
  }
  FixedDate.prototype=RealDate.prototype;
  FixedDate.now=()=>RealDate.parse(isoInstant);
  ctx.Date=FixedDate;
  try{ return fn(); }
  finally{ ctx.Date=RealDate; }
}

function run(ctx,expr){ return vm.runInContext(expr,ctx); }
function setGlobal(ctx,name,value){ ctx[name]=value; }

function contract(month,impliedRate,extra){
  return Object.assign({ticker:'ZQ_TEST',month,price:+(100-impliedRate).toFixed(3),impliedRate},extra||{});
}

// ── Test scaffolding ──────────────────────────────────────────────────
let pass=0,fail=0;
function test(name,fn){
  try{ fn(); pass++; console.log('  ok  --',name); }
  catch(e){ fail++; console.log('FAIL  --',name); console.log('      '+(e && e.stack ? e.stack.split('\n').slice(0,3).join('\n      ') : e)); }
}
function section(name){ console.log('\n== '+name+' =='); }

// ============================================================================
section('Day-count fix (meeting date belongs to the PRE-meeting bucket)');

test('negative control: the pre-495 formula (meetingDay-1) really did give 20/9-days-off, not 21/9', ()=>{
  // CME's own published example: Sept 21 meeting, 30-day month -> 21
  // pre-meeting days, 9 post. The old code computed daysBefore=meetingDay-1.
  const meetingDay=21, daysInMonth=30;
  const oldDaysBefore=meetingDay-1, oldDaysAfter=daysInMonth-oldDaysBefore;
  assert.strictEqual(oldDaysBefore,20);
  assert.strictEqual(oldDaysAfter,10);
  assert.notStrictEqual([oldDaysBefore,oldDaysAfter].join('/'),'21/9','sanity: confirms a real bug existed to fix');
});

test('shipped code now produces a day-count-sensitive result matching the NEW (21/9) split, not the OLD (20/10) one', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-09-21'])`);
  // Constructed so the CORRECT (21/9) split yields a clean -25bp move
  // (postMeetingRate=3.75, currentRate=4.00) -- and, as a negative
  // control, the SAME impliedRate fed through the OLD (20/10) formula
  // produces a materially different, non-clean answer, proving this test
  // can actually tell the two formulas apart rather than passing either way.
  const currentRate=4.00, targetPostNew=3.75, daysInMonth=30;
  const impliedRate=+(( (currentRate*21) + (targetPostNew*9) ) / daysInMonth).toFixed(6);
  const oldPostMeetingRate=(impliedRate*daysInMonth - currentRate*20)/10;
  assert(Math.abs(oldPostMeetingRate-targetPostNew)>0.01,'old-formula result must differ from the new target, or this test cannot discriminate');

  withFixedNow(ctx,'2026-08-01T12:00:00Z',()=>{ // before the meeting -- forecast branch
    const fedFutures=[contract('Aug 2026',currentRate),contract('Sep 2026',impliedRate)];
    const results=run(ctx,`_computeFedMeetingProbabilities`)(fedFutures,[]);
    const sep=results.find(r=>r.meetingDate==='2026-09-21');
    assert(sep,'Sep 2026 meeting should be present in results');
    // A clean -25bp move under the NEW day count should read as pCut25=100.
    // Under the OLD day count it would have come out ~90/10 (see negative
    // control above) -- so landing on exactly 100/0/0 confirms the fix.
    assert.strictEqual(sep.pCut25,100,'expected 100% cut25 under the corrected day count');
    assert.strictEqual(sep.pHold,0);
    assert.strictEqual(sep.pHike25,0);
  });
});

// ============================================================================
section('NY Fed official resolution of past meetings');

test('a past meeting brackets cleanly (before/after both present, bounds agree) -> resolved via nyfed-official', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-08-27'])`);
  withFixedNow(ctx,'2026-09-05T12:00:00Z',()=>{ // meeting is in the past
    const fedFutures=[contract('Jul 2026',4.25),contract('Aug 2026',4.10,{stale:false})];
    const effrRows=[
      {effectiveDate:'2026-08-25',percentRate:4.33,targetRateFrom:4.25,targetRateTo:4.50},
      {effectiveDate:'2026-08-26',percentRate:4.32,targetRateFrom:4.25,targetRateTo:4.50}, // last one BEFORE the meeting
      {effectiveDate:'2026-08-28',percentRate:4.08,targetRateFrom:4.00,targetRateTo:4.25}, // first one AFTER
      {effectiveDate:'2026-08-29',percentRate:4.07,targetRateFrom:4.00,targetRateTo:4.25},
    ];
    const results=run(ctx,`_computeFedMeetingProbabilities`)(fedFutures,effrRows);
    const aug=results.find(r=>r.meetingDate==='2026-08-27');
    assert(aug,'Aug 2026 meeting should be present');
    assert.strictEqual(aug.resolved,true);
    assert.strictEqual(aug.outcome,'cut25');
    assert.strictEqual(aug.source,'nyfed-official');
    const history=run(ctx,`S.get('fomc_meeting_history')`);
    assert.strictEqual(history['2026-08-27'].rate,4.08,'history should store the OFFICIAL post-meeting EFFR value, not a futures-implied guess');
    assert.strictEqual(history['2026-08-27'].source,'nyfed-official');
  });
});

test('_resolveMeetingFromEffr returns null (never guesses) when bounds do not bracket the meeting', ()=>{
  const ctx=buildContext();
  const resolve=run(ctx,'_resolveMeetingFromEffr');
  // Only "before" data, nothing after -- meeting is too recent for EFFR to
  // have published a post-meeting business day yet.
  const onlyBefore=[{effectiveDate:'2026-08-26',percentRate:4.32,targetRateFrom:4.25,targetRateTo:4.50}];
  assert.strictEqual(resolve('2026-08-27',onlyBefore),null);
  // Only "after", nothing before.
  const onlyAfter=[{effectiveDate:'2026-08-28',percentRate:4.08,targetRateFrom:4.00,targetRateTo:4.25}];
  assert.strictEqual(resolve('2026-08-27',onlyAfter),null);
  // No data at all.
  assert.strictEqual(resolve('2026-08-27',[]),null);
  assert.strictEqual(resolve('2026-08-27',null),null);
});

test('_resolveMeetingFromEffr returns null on a lower/upper bound mismatch rather than reporting an ambiguous move', ()=>{
  const ctx=buildContext();
  const resolve=run(ctx,'_resolveMeetingFromEffr');
  const rows=[
    {effectiveDate:'2026-08-26',percentRate:4.32,targetRateFrom:4.25,targetRateTo:4.50},
    {effectiveDate:'2026-08-28',percentRate:4.08,targetRateFrom:4.00,targetRateTo:4.30}, // upper only moved 20bp, not 25 -- mismatch
  ];
  assert.strictEqual(resolve('2026-08-27',rows),null);
});

test('no NY Fed bracket available, but the contract is fresh -> falls back to futures-implied and IS persisted (it is a genuine resolved outcome, just via the fallback method)', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-08-27'])`);
  withFixedNow(ctx,'2026-09-05T12:00:00Z',()=>{
    // Same clean -25bp scenario as the day-count test, but for a PAST
    // meeting with no effrRows at all.
    const currentRate=4.00, targetPost=3.75, daysInMonth=31; // August has 31 days
    const impliedRate=+(( (currentRate*27) + (targetPost*4) ) / daysInMonth).toFixed(6); // meetingDay=27 -> daysBefore=27, daysAfter=4
    const fedFutures=[contract('Jul 2026',currentRate),contract('Aug 2026',impliedRate,{stale:false})];
    const results=run(ctx,`_computeFedMeetingProbabilities`)(fedFutures,[]);
    const aug=results.find(r=>r.meetingDate==='2026-08-27');
    assert.strictEqual(aug.resolved,true);
    assert.strictEqual(aug.source,'futures-implied');
    const history=run(ctx,`S.get('fomc_meeting_history')`);
    assert.strictEqual(history['2026-08-27'].source,'futures-implied');
  });
});

test('no NY Fed bracket available AND the contract is stale -> outcomePending, and NOT persisted to history', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-08-27'])`);
  withFixedNow(ctx,'2026-09-05T12:00:00Z',()=>{
    const fedFutures=[contract('Jul 2026',4.00),contract('Aug 2026',3.90,{stale:true})];
    const results=run(ctx,`_computeFedMeetingProbabilities`)(fedFutures,[]);
    const aug=results.find(r=>r.meetingDate==='2026-08-27');
    assert.strictEqual(aug.outcomePending,true);
    assert(!aug.resolved);
    const history=run(ctx,`S.get('fomc_meeting_history')`);
    assert(!history||!history['2026-08-27'],'a stale, unresolved meeting must never be written to history');
  });
});

// ============================================================================
section('Forecast/history contamination fix');

test('a FUTURE meeting forecast is never written to fomc_meeting_history', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-09-21'])`);
  withFixedNow(ctx,'2026-08-01T12:00:00Z',()=>{ // meeting is upcoming
    const fedFutures=[contract('Aug 2026',4.00),contract('Sep 2026',3.925)];
    run(ctx,`_computeFedMeetingProbabilities`)(fedFutures,[]);
    const history=run(ctx,`S.get('fomc_meeting_history')`);
    assert(!history||Object.keys(history).length===0,'no entry should have been written for a meeting that has not happened yet');
  });
});

test('a repeated forecast across multiple fetches for the SAME future meeting still never accumulates a history entry', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-09-21'])`);
  withFixedNow(ctx,'2026-08-01T12:00:00Z',()=>{
    const compute=run(ctx,`_computeFedMeetingProbabilities`);
    compute([contract('Aug 2026',4.00),contract('Sep 2026',3.90)],[]);
    compute([contract('Aug 2026',4.00),contract('Sep 2026',3.95)],[]); // futures reprice on the next fetch
    compute([contract('Aug 2026',4.00),contract('Sep 2026',3.80)],[]);
    const history=run(ctx,`S.get('fomc_meeting_history')`);
    assert(!history||Object.keys(history).length===0);
  });
});

test('migration: a pre-495 contaminated entry (keyed by a still-future meeting date) is purged on load', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-09-21','2026-07-29'])`);
  // Seed a history blob shaped like what a pre-495 build would have left
  // behind: a legitimate past resolution AND a contaminated future forecast.
  run(ctx,`S.set('fomc_meeting_history',{
    '2026-07-29':{rate:4.33},
    '2026-09-21':{rate:3.90}
  })`);
  withFixedNow(ctx,'2026-08-15T12:00:00Z',()=>{ // between the two meeting dates
    run(ctx,`_computeFedMeetingProbabilities`)([contract('Aug 2026',4.10)],[]);
    const history=run(ctx,`S.get('fomc_meeting_history')`);
    assert(!('2026-09-21' in history),'future-dated (contaminated) entry must be purged');
    assert.strictEqual(history['2026-07-29'].rate,4.33,'legitimate past entry must survive the migration untouched');
  });
});

// ============================================================================
section('Options-tab result-shape compatibility');

test('forecast results still expose pHold/pCut25/pHike25 at the top level (js/options.js reads these directly)', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-09-21'])`);
  withFixedNow(ctx,'2026-08-01T12:00:00Z',()=>{
    const results=run(ctx,`_computeFedMeetingProbabilities`)([contract('Aug 2026',4.00),contract('Sep 2026',3.90)],[]);
    const sep=results.find(r=>r.meetingDate==='2026-09-21');
    assert('pHold' in sep && 'pCut25' in sep && 'pHike25' in sep);
    assert.strictEqual(typeof sep.pHold,'number');
  });
});

test('probability mass sums to 100 for a forecast meeting', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-09-21'])`);
  withFixedNow(ctx,'2026-08-01T12:00:00Z',()=>{
    const results=run(ctx,`_computeFedMeetingProbabilities`)([contract('Aug 2026',4.00),contract('Sep 2026',3.90)],[]);
    const sep=results.find(r=>r.meetingDate==='2026-09-21');
    assert.strictEqual(sep.pHold+sep.pCut25+sep.pHike25,100);
  });
});

// ============================================================================
section('Existing behavior unaffected by this build (regression check)');

test('insufficientBaseline still surfaces when no earlier month or history can supply a starting rate', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-09-21'])`);
  withFixedNow(ctx,'2026-08-01T12:00:00Z',()=>{
    // Only the meeting month itself is in the window -- no meeting-free
    // prior month, no history.
    const results=run(ctx,`_computeFedMeetingProbabilities`)([contract('Sep 2026',3.90)],[]);
    const sep=results.find(r=>r.meetingDate==='2026-09-21');
    assert.strictEqual(sep.insufficientBaseline,true);
  });
});

test('a meeting-free month still seeds currentRate directly, unaffected by the day-count change', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-09-21'])`);
  withFixedNow(ctx,'2026-08-01T12:00:00Z',()=>{
    const results=run(ctx,`_computeFedMeetingProbabilities`)([contract('Aug 2026',4.125),contract('Sep 2026',3.90)],[]);
    // No assertion failure means the loop ran clean; specifically check Aug
    // (meeting-free) produced no entry in results (it's silently skipped,
    // by design) while Sep did.
    assert.strictEqual(results.filter(r=>r.meetingDate).length,1);
    assert.strictEqual(results[0].meetingDate,'2026-09-21');
  });
});

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
