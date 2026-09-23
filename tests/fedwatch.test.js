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

// ── Harness for testing js/api.js's fetchEffrHistory in isolation, with a
// mocked `fetch` (never hits the real network) ──────────────────────────
function buildApiContext(fetchImpl){
  const ctx=vm.createContext({
    console,
    fetch:fetchImpl,
    WORKER_URL:'https://worker.example',
    offlineMode:false,
    FINNHUB_KEY:'',
    window:{},
  });
  const src=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
  vm.runInContext(src('js/helpers.js'),ctx,{filename:'js/helpers.js'}); // addDays/fmtDate
  vm.runInContext(src('js/api.js'),ctx,{filename:'js/api.js'});
  return ctx;
}

// ── Harness for testing cloudflare-proxy/worker.js's EFFR route directly.
// Strips the `export default { fetch(...) {...} };` ES-module wrapper
// (worker.js is a Worker module, not a plain script) so the plain
// function declarations after it -- corsJson, handleEffrProxy,
// _isValidISODate -- can run in a vm context; those functions themselves
// are untouched, real shipped code. The REAL Node Response constructor is
// injected into the context (not left to a context-local one) so a
// returned Response can be read normally from outside without hitting
// the vm module's cross-realm-array gotcha documented further down. ──
function buildWorkerContext(fetchImpl){
  const raw=fs.readFileSync(path.join(ROOT,'cloudflare-proxy/worker.js'),'utf8');
  const stripped=raw.replace(/^export default \{[\s\S]*?\n\};\n/m,'');
  if(stripped===raw)throw new Error('failed to strip the export-default wrapper -- worker.js structure may have changed');
  const ctx=vm.createContext({console,fetch:fetchImpl,Response});
  vm.runInContext(stripped,ctx,{filename:'cloudflare-proxy/worker.js (export wrapper stripped for testing)'});
  return ctx;
}

// Returns a local-calendar Y-M-D string (not UTC) -- matches how the app's
// own date helpers (addDays/new Date(y,m,d)) operate, so assertions stay
// correct regardless of the machine's timezone (unlike .toISOString(),
// which would silently shift by a day in a non-UTC+0 timezone).
function localYMD(d){
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

// ── Test scaffolding ──────────────────────────────────────────────────
let pass=0,fail=0;
function test(name,fn){
  try{ fn(); pass++; console.log('  ok  --',name); }
  catch(e){ fail++; console.log('FAIL  --',name); console.log('      '+(e && e.stack ? e.stack.split('\n').slice(0,3).join('\n      ') : e)); }
}
// Deferred async tests -- collected here, actually run (in order, awaited)
// by the async tail at the very end of this file, after every synchronous
// test above has already run to completion.
const _asyncTests=[];
function testAsync(name,fn){ _asyncTests.push({name,fn,section:_currentSection}); }
let _currentSection='';
function section(name){ _currentSection=name; console.log('\n== '+name+' =='); }

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
section('Adjacent 25bp outcome split (Phase 2)');

test('a move under one 25bp step still reduces to exactly the OLD hold/cut25 model (backward compatibility)', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-09-21'])`);
  withFixedNow(ctx,'2026-08-01T12:00:00Z',()=>{
    // 0.6 of a step (~15bp) -- OLD model: pCut=60%, pHold=40%, pHike=0%.
    const currentRate=4.00, targetPost=4.00-(0.6*0.25), daysInMonth=30;
    const impliedRate=+(( (currentRate*21) + (targetPost*9) ) / daysInMonth).toFixed(6);
    const results=run(ctx,`_computeFedMeetingProbabilities`)([contract('Aug 2026',currentRate),contract('Sep 2026',impliedRate)],[]);
    const sep=results.find(r=>r.meetingDate==='2026-09-21');
    // Values extracted from a vm-context array carry that context's own
    // Array constructor (a cross-realm quirk of Node's vm module, not
    // anything about the app) -- spread into a local-realm array first so
    // deepStrictEqual compares values, not foreign array identity.
    assert.deepStrictEqual([...sep.outcomes.map(o=>o.moveBp)].sort((a,b)=>a-b),[-25,0]);
    const hold=sep.outcomes.find(o=>o.moveBp===0), cut=sep.outcomes.find(o=>o.moveBp===-25);
    assert.strictEqual(hold.probability,40);
    assert.strictEqual(cut.probability,60);
    assert.strictEqual(sep.pHold,40);
    assert.strictEqual(sep.pCut25,60,'alias field must still exist for js/options.js');
  });
});

test('a ~37bp move (1.48 steps) splits between adjacent 25bp and 50bp outcomes, summing to exactly 100', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-09-21'])`);
  withFixedNow(ctx,'2026-08-01T12:00:00Z',()=>{
    const currentRate=4.00, targetPost=4.00-(1.48*0.25), daysInMonth=30; // -0.37
    const impliedRate=+(( (currentRate*21) + (targetPost*9) ) / daysInMonth).toFixed(6);
    const results=run(ctx,`_computeFedMeetingProbabilities`)([contract('Aug 2026',currentRate),contract('Sep 2026',impliedRate)],[]);
    const sep=results.find(r=>r.meetingDate==='2026-09-21');
    const c25=sep.outcomes.find(o=>o.moveBp===-25), c50=sep.outcomes.find(o=>o.moveBp===-50);
    assert(c25 && c50,'expected both a -25bp and a -50bp outcome, not a single capped one');
    assert.strictEqual(c25.probability,52);
    assert.strictEqual(c50.probability,48);
    assert.strictEqual(c25.probability+c50.probability,100);
    assert.strictEqual(sep.pHold,0,'no hold probability once the market is pricing at least one full step');
    // The old model would have shown this as a flat 100% cut25 -- confirm
    // the aggregate alias reflects "any cut" (100%), while outcomes[]
    // now carries the granularity the old pCut25 alone could not.
    assert.strictEqual(sep.pCut25,100);
    assert.strictEqual(sep.pAnyCut,100);
  });
});

test('a symmetric ~37bp HIKE move splits the same way in the positive direction', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-09-21'])`);
  withFixedNow(ctx,'2026-08-01T12:00:00Z',()=>{
    const currentRate=4.00, targetPost=4.00+(1.48*0.25), daysInMonth=30;
    const impliedRate=+(( (currentRate*21) + (targetPost*9) ) / daysInMonth).toFixed(6);
    const results=run(ctx,`_computeFedMeetingProbabilities`)([contract('Aug 2026',currentRate),contract('Sep 2026',impliedRate)],[]);
    const sep=results.find(r=>r.meetingDate==='2026-09-21');
    const h25=sep.outcomes.find(o=>o.moveBp===25), h50=sep.outcomes.find(o=>o.moveBp===50);
    assert(h25 && h50);
    assert.strictEqual(h25.probability,52);
    assert.strictEqual(h50.probability,48);
    assert.strictEqual(sep.pHike25,100);
    assert.strictEqual(sep.pAnyHike,100);
  });
});

test('a clean, exact-fraction move produces a single outcome, not a spurious zero-probability entry', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-09-21'])`);
  withFixedNow(ctx,'2026-08-01T12:00:00Z',()=>{
    const currentRate=4.00, targetPost=3.75, daysInMonth=30; // exactly 1 step, frac=0
    const impliedRate=+(( (currentRate*21) + (targetPost*9) ) / daysInMonth).toFixed(6);
    const results=run(ctx,`_computeFedMeetingProbabilities`)([contract('Aug 2026',currentRate),contract('Sep 2026',impliedRate)],[]);
    const sep=results.find(r=>r.meetingDate==='2026-09-21');
    assert.strictEqual(sep.outcomes.length,1,'no 0%-probability entry should be included');
    assert.strictEqual(sep.outcomes[0].moveBp,-25);
    assert.strictEqual(sep.outcomes[0].probability,100);
  });
});

test('each individual meeting sums to exactly 100 across a run of several meetings (per-meeting normalization only -- this app deliberately has no cross-meeting recombining probability tree, see the Phase-3 scoping discussion)', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-07-29','2026-09-21'])`);
  withFixedNow(ctx,'2026-07-01T12:00:00Z',()=>{
    const results=run(ctx,`_computeFedMeetingProbabilities`)(
      [contract('Jun 2026',4.50),contract('Jul 2026',4.30),contract('Aug 2026',4.05),contract('Sep 2026',3.80)],[]
    );
    results.filter(r=>r.outcomes).forEach(r=>{
      const total=r.outcomes.reduce((s,o)=>s+o.probability,0);
      assert.strictEqual(total,100,'meeting '+r.meetingDate+' outcomes must sum to exactly 100');
    });
  });
});

// ============================================================================
section('Baseline anchoring fix (Phase 2)');

test('EVERY meeting-free month re-anchors the baseline, not just the first one', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-09-21'])`);
  withFixedNow(ctx,'2026-08-01T12:00:00Z',()=>{
    // Two meeting-free months (Jul, Aug) before the Sep meeting. Jul is
    // stale/wrong-looking on purpose (4.50) -- the fix must use Aug's
    // fresher 4.20 as the baseline, not Jul's.
    const daysInMonth=30;
    const targetPost=3.95; // a clean -25bp move FROM THE CORRECT (Aug=4.20) baseline
    const impliedRateSep=+(( (4.20*21) + (targetPost*9) ) / daysInMonth).toFixed(6);
    const results=run(ctx,`_computeFedMeetingProbabilities`)(
      [contract('Jul 2026',4.50),contract('Aug 2026',4.20),contract('Sep 2026',impliedRateSep)],[]
    );
    const sep=results.find(r=>r.meetingDate==='2026-09-21');
    // Negative control: confirm that if the OLD (first-month-only)
    // anchoring were still in effect -- baseline stuck at Jul's 4.50
    // instead of re-anchoring to Aug's 4.20 -- this SAME impliedRate
    // would produce a wildly different (and clearly wrong) result, so a
    // passing assertion below can only mean the new anchoring is what ran.
    const oldPostMeetingRate=(impliedRateSep*daysInMonth - 4.50*21)/9;
    assert(Math.abs(oldPostMeetingRate-targetPost)>0.3,'old-anchoring result must differ sharply from the correct target, or this test cannot discriminate');
    assert.strictEqual(sep.outcomes.length,1);
    assert.strictEqual(sep.outcomes[0].moveBp,-25);
    assert.strictEqual(sep.outcomes[0].probability,100);
  });
});



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
section('Regression: Market->Options must never downgrade official history (Must-fix 1)');

test('a caller that omits effrRows (like js/options.js used to) reuses an existing nyfed-official entry instead of overwriting it with a futures-implied guess', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-08-27'])`);
  withFixedNow(ctx,'2026-09-05T12:00:00Z',()=>{
    const compute=run(ctx,`_computeFedMeetingProbabilities`);
    // Step 1: simulate the Market tab -- a call WITH effrRows resolves the
    // meeting authoritatively and writes it to history.
    const effrRows=[
      {effectiveDate:'2026-08-26',percentRate:4.32,targetRateFrom:4.25,targetRateTo:4.50},
      {effectiveDate:'2026-08-28',percentRate:4.08,targetRateFrom:4.00,targetRateTo:4.25},
    ];
    compute([contract('Jul 2026',4.25),contract('Aug 2026',4.10)],effrRows);
    let history=run(ctx,`S.get('fomc_meeting_history')`);
    assert.strictEqual(history['2026-08-27'].source,'nyfed-official','sanity: Market-tab-style call should resolve officially first');

    // Step 2: simulate js/options.js's OLD behavior -- calling with NO
    // effrRows at all (a very different futures reading this time, to
    // make sure a fallback silently succeeding would be obviously wrong
    // if it happened).
    const resultsFromOptionsLikeCall=compute([contract('Jul 2026',4.25),contract('Aug 2026',3.50)],[]);
    const aug=resultsFromOptionsLikeCall.find(r=>r.meetingDate==='2026-08-27');
    assert.strictEqual(aug.source,'nyfed-official','a caller without EFFR data must still get back the authoritative answer, not a futures-implied guess');
    assert.strictEqual(aug.outcome,'cut25','must be the ORIGINAL official outcome, not something derived from the very different second-call futures data');

    history=run(ctx,`S.get('fomc_meeting_history')`);
    assert.strictEqual(history['2026-08-27'].source,'nyfed-official','the official history entry must NOT have been downgraded');
  });
});

test('the actual js/options.js code path (via _getQualifyingFomcMeetings) does not downgrade a Market-tab-resolved meeting', ()=>{
  const localStorage=makeLocalStorage();
  const ctx=vm.createContext({console,localStorage,window:{},toast:()=>{}});
  const src=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
  vm.runInContext(src('js/storage.js'),ctx,{filename:'js/storage.js'});
  vm.runInContext(src('js/helpers.js'),ctx,{filename:'js/helpers.js'});
  vm.runInContext(src('js/market.js'),ctx,{filename:'js/market.js'});
  vm.runInContext(src('js/options.js'),ctx,{filename:'js/options.js'});
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-08-27'])`);
  withFixedNow(ctx,'2026-09-05T12:00:00Z',()=>{
    const effrRows=[
      {effectiveDate:'2026-08-26',percentRate:4.32,targetRateFrom:4.25,targetRateTo:4.50},
      {effectiveDate:'2026-08-28',percentRate:4.08,targetRateFrom:4.00,targetRateTo:4.25},
    ];
    // Market tab resolves and caches, exactly like loadMarketTab() does.
    run(ctx,`_computeFedMeetingProbabilities`)([contract('Jul 2026',4.25),contract('Aug 2026',4.10)],effrRows);
    run(ctx,`S.set('fomc_effr_cache',{rows:${JSON.stringify(effrRows)},ts:'x',tsEpoch:0})`);
    run(ctx,`S.set('fed_futures',{data:${JSON.stringify([contract('Jul 2026',4.25),contract('Aug 2026',3.50)])},failedMonths:[],ts:'x',tsEpoch:0})`); // deliberately different data, as if the futures moved since
    // Now call the REAL js/options.js function, unmodified.
    const meetings=run(ctx,`_getQualifyingFomcMeetings`)();
    const history=run(ctx,`S.get('fomc_meeting_history')`);
    assert.strictEqual(history['2026-08-27'].source,'nyfed-official','visiting Options must not have downgraded the official record');
    // The resolved Aug meeting is a HOLD/CUT/HIKE fact, not a >=hold
    // forecast -- _getQualifyingFomcMeetings only inspects pCut25/pHold/
    // pHike25 (forecast-shaped fields), so a resolved meeting simply
    // won't appear in its output. The real assertion here is the history
    // check above; this just confirms the call didn't throw.
    assert(Array.isArray(meetings));
  });
});

// ============================================================================
section('Regression: missing intermediate contract must not corrupt later odds (Must-fix 2)');

test('direct reproduction of the reported bug: Aug present, Sep MISSING, Oct present -> Oct must not read as a 250bp+ cut', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-09-16','2026-10-28'])`);
  withFixedNow(ctx,'2026-10-01T12:00:00Z',()=>{ // Oct meeting still upcoming
    const fedFutures=[
      contract('Aug 2026',4.00),
      // September's contract is entirely absent -- not stale, not
      // present at all (a failed fetch with no prior cache to fall back
      // to for that specific month).
      contract('Oct 2026',3.75),
    ];
    const results=run(ctx,`_computeFedMeetingProbabilities`)(fedFutures,[]);
    const oct=results.find(r=>r.meetingDate==='2026-10-28');
    assert(oct,'October meeting should still produce a row');
    assert.strictEqual(oct.insufficientBaseline,true,'a gap across a meeting-bearing month must invalidate the baseline rather than silently using a 2-months-stale rate');
    assert(!oct.outcomes,'must not produce a fabricated outcome split from a broken chain');
  });
});

test('a gap is harmless when the NEXT contract is meeting-free -- it always re-anchors from its own price regardless', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-11-16'])`);
  withFixedNow(ctx,'2026-10-01T12:00:00Z',()=>{
    const fedFutures=[
      contract('Aug 2026',4.50),
      // Sep missing
      contract('Oct 2026',4.10), // meeting-free -- re-anchors here regardless of the Aug->Oct gap
      contract('Nov 2026',3.95),
    ];
    const results=run(ctx,`_computeFedMeetingProbabilities`)(fedFutures,[]);
    const nov=results.find(r=>r.meetingDate==='2026-11-16');
    assert(nov && !nov.insufficientBaseline,'Nov should resolve fine -- Oct (meeting-free, immediately before Nov, no gap between them) supplies a fresh baseline');
  });
});

test('the day-count/anchoring/split tests upstream in this file all use CONTIGUOUS months -- confirm a normal contiguous run is unaffected by the gap check', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-09-21'])`);
  withFixedNow(ctx,'2026-08-01T12:00:00Z',()=>{
    const results=run(ctx,`_computeFedMeetingProbabilities`)([contract('Aug 2026',4.00),contract('Sep 2026',3.925)],[]);
    const sep=results.find(r=>r.meetingDate==='2026-09-21');
    assert(!sep.insufficientBaseline);
    assert(sep.outcomes && sep.outcomes.length>0);
  });
});

// ============================================================================
section('Official hold/hike outcomes via NY Fed data (test-suite gap)');

test('a resolved meeting can be an official HOLD (moveBp===0), not just a cut', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-08-27'])`);
  withFixedNow(ctx,'2026-09-05T12:00:00Z',()=>{
    const effrRows=[
      {effectiveDate:'2026-08-26',percentRate:4.33,targetRateFrom:4.25,targetRateTo:4.50},
      {effectiveDate:'2026-08-28',percentRate:4.32,targetRateFrom:4.25,targetRateTo:4.50}, // unchanged range
    ];
    const results=run(ctx,`_computeFedMeetingProbabilities`)([contract('Jul 2026',4.25),contract('Aug 2026',4.30)],effrRows);
    const aug=results.find(r=>r.meetingDate==='2026-08-27');
    assert.strictEqual(aug.outcome,'hold');
    assert.strictEqual(aug.source,'nyfed-official');
  });
});

test('a resolved meeting can be an official HIKE', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-08-27'])`);
  withFixedNow(ctx,'2026-09-05T12:00:00Z',()=>{
    const effrRows=[
      {effectiveDate:'2026-08-26',percentRate:4.33,targetRateFrom:4.25,targetRateTo:4.50},
      {effectiveDate:'2026-08-28',percentRate:4.58,targetRateFrom:4.50,targetRateTo:4.75},
    ];
    const results=run(ctx,`_computeFedMeetingProbabilities`)([contract('Jul 2026',4.25),contract('Aug 2026',4.60)],effrRows);
    const aug=results.find(r=>r.meetingDate==='2026-08-27');
    assert.strictEqual(aug.outcome,'hike25');
    assert.strictEqual(aug.source,'nyfed-official');
  });
});

// ============================================================================
section('Holiday/weekend bracketing (test-suite gap)');

test('_resolveMeetingFromEffr correctly brackets a meeting even when the surrounding days are a weekend/holiday gap (no EFFR published on non-business days)', ()=>{
  const ctx=buildContext();
  const resolve=run(ctx,'_resolveMeetingFromEffr');
  // A Friday Sep 18 meeting; EFFR has nothing for Sat/Sun, next published
  // value is the following Tuesday (Monday a holiday, e.g. -- the exact
  // reason doesn't matter, only that there's a real multi-day gap).
  const rows=[
    {effectiveDate:'2026-09-17',percentRate:4.33,targetRateFrom:4.25,targetRateTo:4.50},
    // 09-18 (meeting day), 09-19 (Sat), 09-20 (Sun), 09-21 (holiday Mon) -- no data
    {effectiveDate:'2026-09-22',percentRate:4.08,targetRateFrom:4.00,targetRateTo:4.25},
  ];
  const result=resolve('2026-09-18',rows);
  assert(result,'should still resolve across a multi-day publishing gap');
  assert.strictEqual(result.moveBp,-25);
  assert.strictEqual(result.resolvedRate,4.08);
});

// ============================================================================
section('EFFR window boundary (test-suite gap)');

test('_earliestEffrStartNeeded computes the start date from the EARLIEST month actually present, minus a 10-day buffer', ()=>{
  const ctx=buildContext();
  const fn=run(ctx,'_earliestEffrStartNeeded');
  const fedFutures=[contract('Oct 2026',3.90),contract('Aug 2026',4.10),contract('Sep 2026',4.00)]; // deliberately out of order
  const start=fn(fedFutures);
  assert.strictEqual(localYMD(start),'2026-07-22','Aug 1 minus 10 days, using LOCAL calendar arithmetic (matches how the app itself constructs/consumes these dates)');
});

test('_earliestEffrStartNeeded returns null for an empty or missing fedFutures window', ()=>{
  const ctx=buildContext();
  const fn=run(ctx,'_earliestEffrStartNeeded');
  assert.strictEqual(fn([]),null);
  assert.strictEqual(fn(null),null);
});

// ============================================================================
section('Legacy history migration (test-suite gap)');

test('a legacy PAST-dated history entry with no source field is left alone by the migration, then transparently upgraded the next time that meeting is resolved with fresh EFFR data', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('fomc_meeting_dates_override',['2026-08-27'])`);
  // Shaped exactly like a pre-Phase-1 entry: just a bare rate, no source/
  // moveBp/resolvedAt metadata at all.
  run(ctx,`S.set('fomc_meeting_history',{'2026-08-27':{rate:4.10}})`);
  withFixedNow(ctx,'2026-09-05T12:00:00Z',()=>{
    const effrRows=[
      {effectiveDate:'2026-08-26',percentRate:4.32,targetRateFrom:4.25,targetRateTo:4.50},
      {effectiveDate:'2026-08-28',percentRate:4.08,targetRateFrom:4.00,targetRateTo:4.25},
    ];
    const results=run(ctx,`_computeFedMeetingProbabilities`)([contract('Jul 2026',4.25),contract('Aug 2026',4.10)],effrRows);
    const aug=results.find(r=>r.meetingDate==='2026-08-27');
    assert.strictEqual(aug.source,'nyfed-official','fresh EFFR data should resolve and upgrade it, not just leave the legacy value in place');
    const history=run(ctx,`S.get('fomc_meeting_history')`);
    assert.strictEqual(history['2026-08-27'].source,'nyfed-official');
    assert.strictEqual(history['2026-08-27'].rate,4.08,'the upgraded entry should hold the real official rate, not the old legacy 4.10 guess');
  });
});

// ============================================================================
section('Worker EFFR route validation (test-suite gap)');

testAsync('rejects a request missing startDate/endDate', async()=>{
  const ctx=buildWorkerContext(async()=>{throw new Error('fetch must not be called for an invalid request');});
  const res=await run(ctx,'handleEffrProxy')(new URL('https://worker.example/?type=effr'));
  assert.strictEqual(res.status,400);
});

testAsync('rejects a calendar-impossible date (Feb 30) instead of silently rolling it forward to Mar 2', async()=>{
  const ctx=buildWorkerContext(async()=>{throw new Error('fetch must not be called for an invalid request');});
  const res=await run(ctx,'handleEffrProxy')(new URL('https://worker.example/?type=effr&startDate=2026-02-30&endDate=2026-03-01'));
  assert.strictEqual(res.status,400);
});

testAsync('rejects startDate after endDate', async()=>{
  const ctx=buildWorkerContext(async()=>{throw new Error('fetch must not be called for an invalid request');});
  const res=await run(ctx,'handleEffrProxy')(new URL('https://worker.example/?type=effr&startDate=2026-09-20&endDate=2026-09-01'));
  assert.strictEqual(res.status,400);
});

testAsync('rejects an oversized date range (>120 days)', async()=>{
  const ctx=buildWorkerContext(async()=>{throw new Error('fetch must not be called for an invalid request');});
  const res=await run(ctx,'handleEffrProxy')(new URL('https://worker.example/?type=effr&startDate=2026-01-01&endDate=2026-12-31'));
  assert.strictEqual(res.status,400);
});

testAsync('accepts a well-formed, in-range request and forwards it to the NY Fed endpoint', async()=>{
  let calledUrl=null;
  const ctx=buildWorkerContext(async(u)=>{calledUrl=u;return{ok:true,json:async()=>({refRates:[]})};});
  const res=await run(ctx,'handleEffrProxy')(new URL('https://worker.example/?type=effr&startDate=2026-08-01&endDate=2026-09-01'));
  assert.strictEqual(res.status,200);
  assert(calledUrl.includes('markets.newyorkfed.org'));
  assert(calledUrl.includes('startDate=2026-08-01'));
});

// ============================================================================
section('fetchEffrHistory fetch/normalization failures (test-suite gap)');

testAsync('normalizes, sorts ascending by date, and filters rows missing required fields', async()=>{
  const calls=[];
  const fetchImpl=async(url)=>{
    calls.push(url);
    return{json:async()=>({refRates:[
      {effectiveDate:'2026-08-28',percentRate:4.08,targetRateFrom:4.00,targetRateTo:4.25},
      {effectiveDate:'2026-08-26',percentRate:4.32,targetRateFrom:4.25,targetRateTo:4.50},
      {effectiveDate:'2026-08-27',percentRate:null,targetRateFrom:4.00,targetRateTo:4.25}, // incomplete
    ]})};
  };
  const ctx=buildApiContext(fetchImpl);
  const rows=await run(ctx,'fetchEffrHistory')(new Date(2026,7,1)); // local Aug 1 2026
  assert.strictEqual(rows.length,2,'the incomplete row must be filtered out');
  assert.strictEqual(rows[0].effectiveDate,'2026-08-26','must be sorted ascending');
  assert.strictEqual(rows[1].effectiveDate,'2026-08-28');
  assert(calls[0].includes('type=effr'));
});

testAsync('returns null (not a throw) on a fetch failure', async()=>{
  const ctx=buildApiContext(async()=>{throw new Error('network down');});
  const rows=await run(ctx,'fetchEffrHistory')(new Date(2026,7,1));
  assert.strictEqual(rows,null);
});

testAsync('returns null when the response shape is unexpected (refRates missing or not an array)', async()=>{
  const ctx=buildApiContext(async()=>({json:async()=>({error:'bad request'})}));
  const rows=await run(ctx,'fetchEffrHistory')(new Date(2026,7,1));
  assert.strictEqual(rows,null);
});

testAsync('falls back to a default lookback window when no startDate argument is passed', async()=>{
  let capturedUrl=null;
  const ctx=buildApiContext(async(url)=>{capturedUrl=url;return{json:async()=>({refRates:[]})};});
  await run(ctx,'fetchEffrHistory')();
  assert(/startDate=\d{4}-\d{2}-\d{2}/.test(capturedUrl),'expected a well-formed startDate param even with no explicit argument');
});

// ============================================================================
(async()=>{
  let lastAsyncSection=null;
  for(const{name,fn,section:sec}of _asyncTests){
    if(sec!==lastAsyncSection){ console.log('\n== '+sec+' =='); lastAsyncSection=sec; }
    try{ await fn(); pass++; console.log('  ok  --',name); }
    catch(e){ fail++; console.log('FAIL  --',name); console.log('      '+(e && e.stack ? e.stack.split('\n').slice(0,3).join('\n      ') : e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
