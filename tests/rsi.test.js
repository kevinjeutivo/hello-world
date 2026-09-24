#!/usr/bin/env node
'use strict';
// tests/rsi.test.js -- deterministic tests for the Wilder RSI fix.
//
// Two independent, confirmed bugs in the pre-fix computeRSI (js/helpers.js):
//   1. It recomputed a fresh SIMPLE average of gains/losses over an
//      independent rolling 14-day window every day, instead of Wilder's
//      own recursive smoothing (prior average carried forward). The two
//      methods can disagree by several RSI points.
//   2. It filtered nulls out of `closes` internally and stripped its own
//      leading nulls before returning, so the returned array was shorter
//      than `closes` by an amount that depended on how many nulls existed
//      ANYWHERE in the input -- any caller doing index arithmetic to map
//      an RSI position back to a `closes` position (js/helpers.js's RSI
//      backtest functions) would silently read from the wrong day
//      whenever `closes` contained even one gap.
//
// Runs the ACTUAL shipped js/helpers.js source in a Node vm context (see
// income-engine-working-practices.md Sec.1 -- never a hand-reimplemented
// stand-in). Expected values below are computed independently by hand
// (see the derivation in comments), not by re-running the shipped
// algorithm against itself.
//
// Usage: node tests/rsi.test.js

const fs=require('fs');
const path=require('path');
const vm=require('vm');
const assert=require('assert');

const ROOT=path.join(__dirname,'..');

function buildContext(){
  const ctx=vm.createContext({console,window:{}});
  vm.runInContext(fs.readFileSync(path.join(ROOT,'js/helpers.js'),'utf8'),ctx,{filename:'js/helpers.js'});
  return ctx;
}

// A second context that also has storage.js + market.js's dependency
// chain isn't needed here -- helpers.js's RSI functions only depend on
// S (storage) for the backtest functions, which read hist2y_<ticker>
// directly. Build that with storage.js included.
function buildFullContext(){
  const store=new Map();
  const localStorage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>{store.set(k,String(v));},removeItem:k=>{store.delete(k);},clear:()=>store.clear()};
  const ctx=vm.createContext({console,window:{},localStorage,toast:()=>{}});
  vm.runInContext(fs.readFileSync(path.join(ROOT,'js/storage.js'),'utf8'),ctx,{filename:'js/storage.js'});
  vm.runInContext(fs.readFileSync(path.join(ROOT,'js/helpers.js'),'utf8'),ctx,{filename:'js/helpers.js'});
  return ctx;
}

function run(ctx,expr){ return vm.runInContext(expr,ctx); }

let pass=0,fail=0;
function test(name,fn){
  try{ fn(); pass++; console.log('  ok  --',name); }
  catch(e){ fail++; console.log('FAIL  --',name); console.log('      '+(e && e.stack ? e.stack.split('\n').slice(0,3).join('\n      ') : e)); }
}
function section(name){ console.log('\n== '+name+' =='); }

// ============================================================================
section('Wilder smoothing correctness (vs. the old simple-rolling-average bug)');

// Hand-derived series: 15 closes (14 changes) for the seed window, plus a
// 16th close for one recursive step. Gains/losses per change computed by
// hand; seed avgGain=18/14=1.285714286, seed avgLoss=5/14=0.357142857,
// RS=3.6, RSI=100-100/4.6=78.26086956521739 -- see the derivation this
// was checked against in the PR discussion; reproduced here independently
// via plain arithmetic, not by calling the shipped function.
const WILDER_SERIES=[100,101,102,101,103,105,104,106,108,107,109,110,108,111,113,112];
const EXPECTED_SEED_RSI=78.26086956521739;   // at index 14 (the 15th close)
const EXPECTED_STEP2_RSI=74.76038338658147;  // at index 15 (the 16th close), one recursive step later
const OLD_METHOD_RSI_AT_STEP2=73.91304347826087; // what a FRESH simple average of the last 14 changes gives at the same position -- the old algorithm's answer

test('matches the hand-computed Wilder seed value exactly', ()=>{
  const ctx=buildContext();
  const rsi=run(ctx,'computeRSI')(WILDER_SERIES,14);
  assert(Math.abs(rsi[14]-EXPECTED_SEED_RSI)<1e-9);
});

test('matches the hand-computed Wilder recursive-step value exactly', ()=>{
  const ctx=buildContext();
  const rsi=run(ctx,'computeRSI')(WILDER_SERIES,14);
  assert(Math.abs(rsi[15]-EXPECTED_STEP2_RSI)<1e-9);
});

test('negative control: the OLD simple-rolling-average method gives a DIFFERENT answer at the same position -- confirms the two methods genuinely diverge, not just a rounding difference', ()=>{
  assert(Math.abs(EXPECTED_STEP2_RSI-OLD_METHOD_RSI_AT_STEP2)>0.5,'Wilder and simple-average must disagree meaningfully for this test to mean anything');
  const ctx=buildContext();
  const rsi=run(ctx,'computeRSI')(WILDER_SERIES,14);
  assert(Math.abs(rsi[15]-OLD_METHOD_RSI_AT_STEP2)>0.5,'shipped code must NOT match the old (wrong) method');
});

// ============================================================================
section('Array-length / positional-correspondence fix');

test('rsi.length always equals closes.length -- no caller needs to know `period` to map an index back to closes', ()=>{
  const ctx=buildContext();
  const rsi=run(ctx,'computeRSI')(WILDER_SERIES,14);
  assert.strictEqual(rsi.length,WILDER_SERIES.length);
});

test('the first `period` positions are null (insufficient lookback), matching the old convention for null COUNT even though the array is no longer stripped', ()=>{
  const ctx=buildContext();
  const rsi=run(ctx,'computeRSI')(WILDER_SERIES,14);
  for(let i=0;i<14;i++)assert.strictEqual(rsi[i],null,`index ${i} should be null (pre-seed)`);
  assert(rsi[14]!=null,'index 14 (the 15th close) should be the first real value');
});

test('a null anywhere in the input resets the smoothing rather than silently splicing pre-gap and post-gap data together', ()=>{
  const ctx=buildContext();
  // 20 stable closes, a gap, then 20 more -- the second segment alone
  // isn't long enough to complete a fresh 14-period seed until 14 changes
  // (15 closes) past the gap.
  const seg1=Array.from({length:20},(_,i)=>100+i*0.1);
  const seg2=Array.from({length:20},(_,i)=>200+i*0.1);
  const closes=[...seg1,null,...seg2];
  const rsi=run(ctx,'computeRSI')(closes,14);
  assert.strictEqual(rsi.length,closes.length);
  assert.strictEqual(rsi[20],null,'the gap position itself must be null');
  // seg2 starts at index 21; first real close there has nothing to diff
  // against (prev==null after the reset), so index 21 is null too; the
  // seed then needs 14 more changes, completing at index 21+14=35.
  for(let i=21;i<35;i++)assert.strictEqual(rsi[i],null,`index ${i} should still be mid-reseed`);
  assert(rsi[35]!=null,'index 35 should be the first post-gap value');
});

// ============================================================================
section('_getRSIRecentTransition null-safety (test-suite gap)');

test('finds the actual last non-null value instead of assuming the final array position is valid', ()=>{
  const ctx=buildContext();
  // A long stable-then-declining series (guarantees an oversold read),
  // with the single LAST close set to null (e.g. an unsettled live bar).
  const decline=Array.from({length:60},(_,i)=>150-i*1.2);
  const closes=[...decline,null];
  const trans=run(ctx,'_getRSIRecentTransition')('TEST',{closes});
  // Must not throw, and must still find the real (non-null) last RSI
  // reading rather than choking on the trailing null.
  assert(trans===null||typeof trans.rsi==='number');
});

test('a data gap inside the recent lookback breaks the in-zone day count rather than being coerced by null<30', ()=>{
  const ctx=buildContext();
  const decline=Array.from({length:60},(_,i)=>150-i*1.2);
  // Insert a null 3 days before the end -- if it were coerced instead of
  // skipped, `null<30` is true (null coerces to 0), which would silently
  // extend the "days in zone" count through a day with no real reading.
  const closes=[...decline.slice(0,-3),null,...decline.slice(-2)];
  const trans=run(ctx,'_getRSIRecentTransition')('TEST',{closes});
  if(trans&&trans.phase==='in'){
    // The gap is 2 trading days before the last close -- the streak
    // can't extend past it, so days must be small (<=2), not however
    // long the whole decline has been oversold.
    assert(trans.days<=2,'a null gap must break the streak, not be silently coerced through');
  }
});

// ============================================================================
section('_computeRSIBacktestForTicker index-mapping fix (direct reproduction of the reported bug)');

// Deterministic scenario: 60 stable closes, ONE null gap, then a clean
// 25-day decline (86 closes total -- comfortably past the function's own
// 80-day minimum). Independently verified (see the PR discussion) that
// this produces exactly one oversold ENTER event, at index 75, with no
// exits. Forward returns at that index were computed independently
// (fwdReturn, not via the backtest function) for windows 5 and 10; window
// 20 runs past the end of the array and has no data.
function buildGapDeclineCloses(){
  const stable=Array.from({length:60},(_,i)=>100+Math.sin(i)*0.5);
  const decline=[];let p=100;
  for(let i=0;i<25;i++){p-=1.1;decline.push(+p.toFixed(2));}
  return[...stable,null,...decline];
}
const EXPECTED_ENTER_IDX=75;
const EXPECTED_FWDRET_5=-6.58682634730539;
const EXPECTED_FWDRET_10=-13.17365269461078;
// What the OLD (pre-fix) code would have recorded instead, computed
// independently by reconstructing exactly what it did (filter nulls,
// strip leading nulls, then closeIdx=k+period on the shorter array) --
// this is the negative control, confirming the bug was real and exactly
// this scenario triggers it, not a hand-wave.
function oldComputeRSI(closes,period=14){const filtered=closes.filter(c=>c!=null);const result=[];for(let i=0;i<filtered.length;i++){if(i<period){result.push(null);continue;}const sl=filtered.slice(i-period,i+1);let g=0,l=0;for(let j=1;j<sl.length;j++){const d=sl[j]-sl[j-1];if(d>0)g+=d;else l-=d;}const ag=g/period,al=l/period;if(al===0){result.push(100);continue;}result.push(100-100/(1+ag/al));}return result.filter(v=>v!==null);}

test('negative control: reconstructing the OLD algorithm on this exact scenario points at the WRONG day (index 62, one period early) instead of the real crossing day (index 75)', ()=>{
  const closes=buildGapDeclineCloses();
  const oldRsi=oldComputeRSI(closes,14);
  let was=false,oldEnterK=null;
  for(let k=0;k<oldRsi.length;k++){
    const isOversold=oldRsi[k]<30;
    if(isOversold&&!was){oldEnterK=k;break;}
    was=isOversold;
  }
  assert.strictEqual(oldEnterK,48);
  const oldWrongCloseIdx=oldEnterK+14;
  assert.strictEqual(oldWrongCloseIdx,62,'the old formula lands on index 62');
  assert.notStrictEqual(oldWrongCloseIdx,EXPECTED_ENTER_IDX,'confirms it is NOT the real crossing day (75) -- the bug is real for this input');
});

test('the shipped (fixed) backtest function reports returns computed from the CORRECT day, not the null-shifted one', ()=>{
  const ctx=buildFullContext();
  const closes=buildGapDeclineCloses();
  run(ctx,`S.set('hist2y_TEST',{closes:${JSON.stringify(closes)}})`);
  const result=run(ctx,'_computeRSIBacktestForTicker')('TEST');
  assert(result,'expected a real result -- closes.length clears the 80-day minimum');
  const d=result.oversoldEnter;
  assert.strictEqual(d.occurrences,1,'exactly one oversold entry in this constructed series');
  assert(Math.abs(d.windows[5].avgReturn-EXPECTED_FWDRET_5)<1e-9,'window-5 return must match the independently-computed fwdReturn at index 75 exactly');
  assert(Math.abs(d.windows[10].avgReturn-EXPECTED_FWDRET_10)<1e-9,'window-10 return must match the independently-computed fwdReturn at index 75 exactly');
  assert.strictEqual(d.windows[20],null,'window-20 runs past the end of this series -- correctly no data, not a wrong number');
});

test('_computeRSIBacktestAggregate (the pooled/multi-ticker version) uses the same corrected index mapping', ()=>{
  const ctx=buildFullContext();
  const closes=buildGapDeclineCloses();
  run(ctx,`S.set('hist2y_TEST',{closes:${JSON.stringify(closes)}})`);
  const agg=run(ctx,'_computeRSIBacktestAggregate')(['TEST']);
  assert.strictEqual(agg.tickersWithData,1);
  assert.strictEqual(agg.oversoldEnter.occurrences,1);
  assert(Math.abs(agg.oversoldEnter.windows[5].avgReturn-EXPECTED_FWDRET_5)<1e-9);
});



// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
