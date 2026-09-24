#!/usr/bin/env node
'use strict';
// tests/strike-increment.test.js -- deterministic tests for inferring a
// ticker's strike increment from its real cached options chain, instead
// of guessing purely from price via a generic price-tier rule.
//
// The old _realisticStrikeIncrement(spot) used a universal rule (<=$25:
// $2.50, <=$200: $5, else $10) with no awareness of the specific ticker.
// Real strike ladders vary by liquidity, program eligibility, and split
// history -- plenty of actively-traded names under $200 actually have $1
// strikes. The fix infers each ticker's typical increment from its own
// currently cached real options chain when there's enough data to trust,
// falling back to the generic rule otherwise.
//
// This file also includes the end-to-end regression check that would
// have caught a real bug found while building this fix: _ticker_ was
// referenced inside _simulateWheelWindow before it was actually added as
// a parameter there -- an uncaught ReferenceError that would have
// crashed every wheel backtest run, with no try/catch anywhere in the
// call chain to mask it. Caught by direct end-to-end reproduction before
// shipping, not by this test suite catching it after the fact -- but the
// scenario is captured here specifically so it can't silently regress.
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
section('_inferStrikeIncrement');

test('returns null when there is no cached options data at all for the ticker', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'_inferStrikeIncrement')('NOTHING'),null);
});

test('returns null when there are too few cached strikes to trust (below _MIN_STRIKES_FOR_INCREMENT_INFERENCE)', ()=>{
  const ctx=buildContext();
  seedChain(ctx,'THIN',95,98,1); // only 4 strikes
  assert.strictEqual(run(ctx,'_inferStrikeIncrement')('THIN'),null);
});

test('correctly infers a $1 increment from a realistic $1-spaced chain', ()=>{
  const ctx=buildContext();
  seedChain(ctx,'FINE',70,130,1);
  const inc=run(ctx,'_inferStrikeIncrement')('FINE');
  assert(Math.abs(inc-1)<1e-9);
});

test('correctly infers a $5 increment from a $5-spaced chain', ()=>{
  const ctx=buildContext();
  seedChain(ctx,'COARSE',50,150,5);
  const inc=run(ctx,'_inferStrikeIncrement')('COARSE');
  assert(Math.abs(inc-5)<1e-9);
});

test('uses the SMALLEST common gap, not the average, when a chain has genuinely mixed spacing (fine near the money, coarser further out -- realistic)', ()=>{
  const ctx=buildContext();
  const ctx2=ctx;
  // Fine ($1) strikes near the money, coarser ($5) strikes further out --
  // build this by hand since seedChain assumes one uniform step.
  const expEpoch=Math.floor(Date.now()/1000)+30*86400;
  const expDateStr=new Date(expEpoch*1000).toISOString().split('T')[0];
  run(ctx2,`S.set('options_MIXED',{data:{optionChain:{result:[{expirationDates:[${expEpoch}]}]}}})`);
  const strikes=[];
  for(let s=70;s<=90;s+=5)strikes.push({s}); // coarse, far OTM
  for(let s=95;s<=105;s+=1)strikes.push({s}); // fine, near the money
  for(let s=110;s<=130;s+=5)strikes.push({s}); // coarse, far OTM
  run(ctx2,`S.set('options_exp_MIXED_${expDateStr}',{puts:${JSON.stringify(strikes)},calls:${JSON.stringify(strikes)}})`);
  const inc=run(ctx2,'_inferStrikeIncrement')('MIXED');
  assert(Math.abs(inc-1)<1e-9,'the finer near-the-money spacing should win, not an average of $1 and $5');
});

test('pools strikes across MULTIPLE cached expirations, not just one', ()=>{
  const ctx=buildContext();
  // Two separate expirations, each individually below the minimum
  // strike count, but together clearing it -- and each contributing a
  // $1 gap somewhere.
  const exp1=Math.floor(Date.now()/1000)+30*86400;
  const exp1Str=new Date(exp1*1000).toISOString().split('T')[0];
  const exp2=Math.floor(Date.now()/1000)+60*86400;
  const exp2Str=new Date(exp2*1000).toISOString().split('T')[0];
  run(ctx,`S.set('options_POOL',{data:{optionChain:{result:[{expirationDates:[${exp1},${exp2}]}]}}})`);
  run(ctx,`S.set('options_exp_POOL_${exp1Str}',{puts:${JSON.stringify([95,96,97].map(s=>({s})))},calls:[]})`);
  run(ctx,`S.set('options_exp_POOL_${exp2Str}',{puts:${JSON.stringify([98,99,100].map(s=>({s})))},calls:[]})`);
  const inc=run(ctx,'_inferStrikeIncrement')('POOL');
  assert(Math.abs(inc-1)<1e-9);
});

// ============================================================================
section('_snapStrikeToRealistic: uses inference when trustworthy, falls back otherwise');

test('with a trustworthy cached chain, snaps to the INFERRED increment, not the generic tier rule', ()=>{
  const ctx=buildContext();
  seedChain(ctx,'FINE',70,130,1);
  const snapped=run(ctx,'_snapStrikeToRealistic')(87.3,100,'put','FINE');
  assert.strictEqual(snapped,88,'a put snaps via Math.ceil (toward the money) -- nearest real $1 strike at or above 87.3');
});

test('without cached data, falls back to the generic tier rule exactly as before', ()=>{
  const ctx=buildContext();
  const snapped=run(ctx,'_snapStrikeToRealistic')(87.3,100,'put','NOTHING');
  assert.strictEqual(snapped,90,'the old $5-tier rule for a $100 spot: ceil(87.3/5)*5=90');
});

test('with no ticker argument at all, behaves identically to the pre-fix signature (backward compatible)', ()=>{
  const ctx=buildContext();
  const snapped=run(ctx,'_snapStrikeToRealistic')(87.3,100,'put');
  assert.strictEqual(snapped,90);
});

// ============================================================================
section('End-to-end regression: the full call chain (_simulateOneCycle -> _snapStrikeToRealistic -> _inferStrikeIncrement -> _cachedExpEntries/_getStrikesForExpiration) runs without throwing, and inference actually changes the outcome');

test('a real cached $1 chain changes the simulated strike vs. the same setup with no cache -- proves ticker threads all the way through, not just at the top level', ()=>{
  const ctx=buildContext();
  seedChain(ctx,'TEST',70,130,1);
  const hist=buildSyntheticHist(400,0.02,1);
  const cycWith=run(ctx,'_simulateOneCycle')(hist,60,1,1,'put',0.04,1.0,null,0,'TEST');
  const cycWithout=run(ctx,'_simulateOneCycle')(hist,60,1,1,'put',0.04,1.0,null,0,'NOCACHE');
  assert(cycWith,'expected a completed cycle with the cached chain present');
  assert(cycWithout,'expected a completed cycle for the no-cache comparison too');
  assert.notStrictEqual(cycWith.strike,cycWithout.strike,'the cached-chain strike should differ from the generic-tier-rule strike for this scenario');
  assert.strictEqual(cycWithout.strike%5,0,'sanity: the no-cache case really did use the $5 tier rule');
});

test('_simulateOneCycle never throws when ticker is omitted entirely (older call shape, still supported)', ()=>{
  const ctx=buildContext();
  const hist=buildSyntheticHist(400,0.02,2);
  assert.doesNotThrow(()=>{
    run(ctx,'_simulateOneCycle')(hist,60,1,1,'put',0.04,1.0,null,0);
  });
});

test('_simulateWheelWindow (the actual outer entry point) never throws with a ticker argument, across several different synthetic price paths', ()=>{
  const ctx=buildContext();
  seedChain(ctx,'TEST',70,150,1);
  for(let seed=0;seed<5;seed++){
    const hist=buildSyntheticHist(400,0.02,seed*37);
    assert.doesNotThrow(()=>{
      run(ctx,'_simulateWheelWindow')(hist,60,1,1,0.04,undefined,null,null,null,null,undefined,'TEST');
    },'seed '+seed);
  }
});

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
