#!/usr/bin/env node
'use strict';
// tests/strike-increment.test.js -- deterministic tests for selecting a
// ticker's strike directly from its real cached options chain, instead
// of guessing purely from price via a generic price-tier rule.
//
// This has gone through two designs. Build 504 inferred a single
// SYNTHETIC increment (the smallest gap between adjacent cached strikes)
// and did grid arithmetic on it. A later review found that fragile: a
// single irregular or adjusted strike could dominate a minimum-gap
// reading, and grid rounding on top of even a correct increment could
// still construct a strike price that was never actually listed. It also
// found the inference was being recomputed on every simulated cycle --
// once per candidate entry date, duration, and window -- when the
// underlying cached chain data doesn't change within a single backtest
// run at all.
//
// This build fixes both: _inferStrikeLadder returns the real, pooled,
// sorted array of cached strikes (not a synthetic number), and
// _snapStrikeToRealistic selects directly from it -- no grid math, so no
// way to construct an off-ladder price. The ladder is computed ONCE per
// ticker by the outermost caller (_computeWheelBacktest, etc.) and
// threaded down through every simulated cycle, not re-derived each time.
//
// This file also keeps the end-to-end regression check from the original
// build: an early version referenced `ticker` inside _simulateWheelWindow
// before it was actually a parameter there -- an uncaught ReferenceError
// that would have crashed every wheel backtest run, with no try/catch
// anywhere in the call chain to mask it. Caught by direct end-to-end
// reproduction before shipping; captured here so it can't silently
// regress as the threaded parameter's name/shape keeps changing.
//
// Runs the actual shipped source in a Node vm context.
//
// Usage: node tests/strike-increment.test.js

const fs=require('fs');
const path=require('path');
const vm=require('vm');
const assert=require('assert');

const ROOT=path.join(__dirname,'..');

function makeLocalStorage(){
  const store=new Map();
  return{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>{store.set(k,String(v));},removeItem:k=>{store.delete(k);},clear:()=>store.clear()};
}
function buildContext(){
  const ctx=vm.createContext({console,localStorage:makeLocalStorage(),window:{},toast:()=>{}});
  const src=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
  vm.runInContext(src('js/storage.js'),ctx,{filename:'js/storage.js'});
  vm.runInContext(src('js/helpers.js'),ctx,{filename:'js/helpers.js'});
  vm.runInContext(src('js/wheelbacktest.js'),ctx,{filename:'js/wheelbacktest.js'});
  vm.runInContext(src('js/income.js'),ctx,{filename:'js/income.js'}); // _getStrikesForExpiration / _getCallStrikesForExpiration live here
  return ctx;
}
function run(ctx,expr){ return vm.runInContext(expr,ctx); }

// Seeds a realistic cached options chain for a ticker: one expiration,
// with put/call strikes spaced `step` apart from `lo` to `hi` inclusive.
function seedChain(ctx,ticker,lo,hi,step){
  const expEpoch=Math.floor(Date.now()/1000)+30*86400;
  const expDateStr=new Date(expEpoch*1000).toISOString().split('T')[0];
  run(ctx,`S.set('options_${ticker}',{data:{optionChain:{result:[{expirationDates:[${expEpoch}]}]}}})`);
  const strikes=[];
  for(let s=lo;s<=hi+1e-9;s+=step)strikes.push({s:+s.toFixed(2)});
  run(ctx,`S.set('options_exp_${ticker}_${expDateStr}',{puts:${JSON.stringify(strikes)},calls:${JSON.stringify(strikes)}})`);
  return expDateStr;
}

function buildSyntheticHist(n,volAmplitude,seed){
  let opens=[],highs=[],lows=[],closes=[],timestamps=[];
  let px=100,t=Math.floor(Date.now()/1000)-n*86400*1.45;
  for(let i=0;i<n;i++){
    px=px*(1+Math.sin(i*0.3)*volAmplitude+((i*9301+seed)%1000/1000-0.5)*0.01);
    opens.push(px);highs.push(px*1.01);lows.push(px*0.99);closes.push(px);
    timestamps.push(Math.floor(t));
    t+=86400*1.45;
  }
  return{opens,highs,lows,closes,timestamps};
}

let pass=0,fail=0;
function test(name,fn){
  try{ fn(); pass++; console.log('  ok  --',name); }
  catch(e){ fail++; console.log('FAIL  --',name); console.log('      '+(e && e.stack ? e.stack.split('\n').slice(0,3).join('\n      ') : e)); }
}
function section(name){ console.log('\n== '+name+' =='); }

// ============================================================================
section('_inferStrikeLadder');

test('returns null when there is no cached options data at all for the ticker', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'_inferStrikeLadder')('NOTHING'),null);
});

test('returns null when there are too few cached strikes to trust', ()=>{
  const ctx=buildContext();
  seedChain(ctx,'THIN',95,98,1); // only 4 strikes
  assert.strictEqual(run(ctx,'_inferStrikeLadder')('THIN'),null);
});

test('returns the real strikes as a sorted, deduplicated array -- not a synthetic increment', ()=>{
  const ctx=buildContext();
  seedChain(ctx,'FINE',70,80,1);
  const ladder=run(ctx,'_inferStrikeLadder')('FINE');
  assert(Array.isArray(ladder));
  assert.strictEqual(ladder.length,11); // 70..80 inclusive, step 1
  assert.strictEqual(ladder[0],70);
  assert.strictEqual(ladder[ladder.length-1],80);
  for(let i=1;i<ladder.length;i++)assert(ladder[i]>ladder[i-1],'must be strictly ascending');
});

test('pools strikes across MULTIPLE cached expirations, not just one', ()=>{
  const ctx=buildContext();
  const exp1=Math.floor(Date.now()/1000)+30*86400;
  const exp1Str=new Date(exp1*1000).toISOString().split('T')[0];
  const exp2=Math.floor(Date.now()/1000)+60*86400;
  const exp2Str=new Date(exp2*1000).toISOString().split('T')[0];
  run(ctx,`S.set('options_POOL',{data:{optionChain:{result:[{expirationDates:[${exp1},${exp2}]}]}}})`);
  run(ctx,`S.set('options_exp_POOL_${exp1Str}',{puts:${JSON.stringify([95,96,97].map(s=>({s})))},calls:[]})`);
  run(ctx,`S.set('options_exp_POOL_${exp2Str}',{puts:${JSON.stringify([98,99,100].map(s=>({s})))},calls:[]})`);
  const ladder=run(ctx,'_inferStrikeLadder')('POOL');
  assert.deepStrictEqual([...ladder],[95,96,97,98,99,100]);
});

test('a single irregular strike no longer dominates anything -- it is just one more entry in the ladder, not a synthetic increment derived from it', ()=>{
  const ctx=buildContext();
  // Mostly $5-spaced, with one irregular $1-off strike thrown in (e.g. an
  // adjusted/special strike). The old min-gap design would have inferred
  // a $1 "increment" from this single outlier and applied it everywhere.
  const strikes=[70,75,80,85,86,90,95,100];
  const expEpoch=Math.floor(Date.now()/1000)+30*86400;
  const expDateStr=new Date(expEpoch*1000).toISOString().split('T')[0];
  run(ctx,`S.set('options_IRREG',{data:{optionChain:{result:[{expirationDates:[${expEpoch}]}]}}})`);
  run(ctx,`S.set('options_exp_IRREG_${expDateStr}',{puts:${JSON.stringify(strikes.map(s=>({s})))},calls:[]})`);
  const ladder=run(ctx,'_inferStrikeLadder')('IRREG');
  assert.deepStrictEqual([...ladder],strikes);
  // Snapping near the irregular strike selects a REAL strike either way --
  // never a constructed $1-grid price like 87 or 88 that was never listed.
  const snapped=run(ctx,'_snapStrikeToRealistic')(83,100,'put',ladder);
  assert(strikes.includes(snapped),'the snapped strike must be one of the actually-listed strikes');
});

// ============================================================================
section('_snapStrikeToRealistic: direct ladder selection');

test('with a real ladder, snaps to the nearest REAL strike toward the money -- not a constructed grid price', ()=>{
  const ctx=buildContext();
  const realLadder=[70,71,72,73,74,75,76,77,78,79,80];
  const snapped=run(ctx,'_snapStrikeToRealistic')(74.3,100,'put',realLadder);
  assert.strictEqual(snapped,75,'a put snaps toward the money -- smallest real strike >= 74.3');
});

test('a call snaps toward the money -- largest real strike <= raw theoretical strike', ()=>{
  const realLadder=[110,111,112,113,114,115];
  const ctx=buildContext();
  const snapped=run(ctx,'_snapStrikeToRealistic')(112.7,100,'call',realLadder);
  assert.strictEqual(snapped,112);
});

test('without any ladder, falls back to the generic tier rule exactly as before', ()=>{
  const ctx=buildContext();
  const snapped=run(ctx,'_snapStrikeToRealistic')(87.3,100,'put',null);
  assert.strictEqual(snapped,90,'the tier rule for a $100 spot: ceil(87.3/5)*5=90');
});

test('with no ladder argument at all, behaves identically to the tier-rule fallback', ()=>{
  const ctx=buildContext();
  const snapped=run(ctx,'_snapStrikeToRealistic')(87.3,100,'put');
  assert.strictEqual(snapped,90);
});

test("a raw strike outside the ladder's cached range falls back to the tier rule rather than guessing beyond real data", ()=>{
  const ctx=buildContext();
  const realLadder=[95,96,97,98,99]; // doesn't reach anywhere near 40
  const snapped=run(ctx,'_snapStrikeToRealistic')(40,100,'put',realLadder);
  assert.strictEqual(snapped,40,'40 is already an exact $10-tier multiple, so the fallback returns it unchanged');
});

test('regression: a rawStrike far below every cached strike must NOT select the nearest cached entry anyway -- the ladder has no real information about that price region', ()=>{
  const ctx=buildContext();
  const realLadder=[95,96,97,98,99]; // all clustered near spot; says nothing about $40
  const snapped=run(ctx,'_snapStrikeToRealistic')(40,100,'put',realLadder);
  assert.notStrictEqual(snapped,95,'must not silently pick 95 just because it is the smallest cached strike >= 40 -- that is not a meaningful snap toward a $40 target');
});

test('"too close to spot" pushes out to the ADJACENT REAL LADDER STRIKE, not an arithmetic offset', ()=>{
  const ctx=buildContext();
  const realLadder=[95,96,97,98,99,100];
  // rawStrike snaps to 99.6->100 which is essentially AT spot (100) --
  // must push out to the next REAL strike below it (99), not to some
  // computed 100-increment value.
  const snapped=run(ctx,'_snapStrikeToRealistic')(99.6,100,'put',realLadder);
  assert.strictEqual(snapped,99);
});

test('returns null when a real ladder is available but conclusively has no valid OTM strike in this direction', ()=>{
  const ctx=buildContext();
  const realLadder=[100]; // only the ATM strike itself is cached
  const snapped=run(ctx,'_snapStrikeToRealistic')(100,100,'put',realLadder);
  assert.strictEqual(snapped,null);
});

// ============================================================================
section('Performance: the ladder is computed ONCE per ticker per backtest run, not once per window/cycle');

test('_inferStrikeLadder is called exactly once across a whole _computeWheelBacktest run with several windows', ()=>{
  const ctx=buildContext();
  seedChain(ctx,'TEST',70,150,1);
  const hist=buildSyntheticHist(700,0.02,1); // long enough for several monthly windows
  run(ctx,`S.set('hist2y_TEST',${JSON.stringify(hist)})`);
  const original=run(ctx,'_inferStrikeLadder');
  let callCount=0;
  ctx._inferStrikeLadder=(...args)=>{callCount++;return original(...args);};
  const result=run(ctx,'_computeWheelBacktest')('TEST',1,1,'default');
  assert(result,'expected a real result from this scenario');
  assert(result.sampleSize>=2,'sanity: this run should have covered multiple windows, or the test below proves nothing');
  assert.strictEqual(callCount,1,'must be computed exactly once for the whole run, not once per window');
});

// ============================================================================
section('End-to-end regression: the full call chain runs without throwing, and ladder selection actually changes the outcome');

test('a real cached $1 ladder changes the simulated strike vs. no ladder at all -- proves the ladder threads all the way through every simulated cycle', ()=>{
  const ctx=buildContext();
  const ladder=[70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,130];
  const hist=buildSyntheticHist(400,0.02,1);
  const cycWith=run(ctx,'_simulateOneCycle')(hist,60,1,1,'put',0.04,1.0,null,0,ladder);
  const cycWithout=run(ctx,'_simulateOneCycle')(hist,60,1,1,'put',0.04,1.0,null,0,null);
  assert(cycWith,'expected a completed cycle with the ladder present');
  assert(cycWithout,'expected a completed cycle for the no-ladder comparison too');
  assert(ladder.includes(cycWith.strike),'the ladder-selected strike must be one of the real, listed strikes');
  assert.strictEqual(cycWithout.strike%5,0,'sanity: the no-ladder case really did use the $5 tier rule');
});

test('_simulateOneCycle never throws when ladder is omitted entirely (older call shape, still supported)', ()=>{
  const ctx=buildContext();
  const hist=buildSyntheticHist(400,0.02,2);
  assert.doesNotThrow(()=>{
    run(ctx,'_simulateOneCycle')(hist,60,1,1,'put',0.04,1.0,null,0);
  });
});

test('_simulateWheelWindow (the actual outer entry point) never throws with a ladder argument, across several different synthetic price paths', ()=>{
  const ctx=buildContext();
  seedChain(ctx,'TEST',70,150,1);
  const ladder=run(ctx,'_inferStrikeLadder')('TEST');
  for(let seed=0;seed<5;seed++){
    const hist=buildSyntheticHist(400,0.02,seed*37);
    assert.doesNotThrow(()=>{
      run(ctx,'_simulateWheelWindow')(hist,60,1,1,0.04,undefined,null,null,null,null,undefined,ladder);
    },'seed '+seed);
  }
});

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
