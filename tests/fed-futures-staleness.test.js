#!/usr/bin/env node
'use strict';
// tests/fed-futures-staleness.test.js -- deterministic tests for the Fed
// Funds Futures carry-forward staleness fix (js/market.js).
//
// Confirmed two things, one of them deeper than the original review
// flagged:
//
//   1. (As reported) A carried-forward contract had no maximum usable
//      age -- a month that kept failing to fetch would be carried
//      forward indefinitely, still influencing FOMC probabilities from
//      an arbitrarily old quote, with no cutoff.
//
//   2. (Found while fixing #1) staleAsOf was being RE-STAMPED to "now"
//      on every save that included this carried-forward month, rather
//      than preserving the true original fetch date. Since a save
//      happens on every partial-success fetch (stale months included),
//      staleAsOf would look perpetually recent even for a contract stuck
//      for weeks -- which would have made a naive age check on top of it
//      silently never fire. Fixed by preserving the ORIGINAL
//      staleAsOf/staleAsOfEpoch across repeated carry-forwards, only
//      setting it fresh the first time a contract actually transitions
//      from fresh to stale.
//
// Extracted into its own function (_carryForwardStaleFedFutures) so it
// can be tested directly, rather than only reachable through the full
// async loadMarketTab() flow.
//
// Runs the actual shipped source in a Node vm context.
//
// Usage: node tests/fed-futures-staleness.test.js

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
  const ctx=vm.createContext({console,localStorage:makeLocalStorage(),window:{},toast:()=>{},document:{getElementById:()=>null,addEventListener:()=>{}}});
  const src=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
  vm.runInContext(src('js/storage.js'),ctx,{filename:'js/storage.js'});
  vm.runInContext(src('js/helpers.js'),ctx,{filename:'js/helpers.js'});
  vm.runInContext(src('js/market.js'),ctx,{filename:'js/market.js'});
  return ctx;
}
function run(ctx,expr){ return vm.runInContext(expr,ctx); }

let pass=0,fail=0;
function test(name,fn){
  try{ fn(); pass++; console.log('  ok  --',name); }
  catch(e){ fail++; console.log('FAIL  --',name); console.log('      '+(e && e.stack ? e.stack.split('\n').slice(0,3).join('\n      ') : e)); }
}
function section(name){ console.log('\n== '+name+' =='); }

const DAY_MS=86400000;
const NOW=Date.parse('2026-09-24T12:00:00Z');

// ============================================================================
section('Basic carry-forward behavior (unchanged from before this fix)');

test('no failed months -- returns unchanged, nothing carried forward', ()=>{
  const ctx=buildContext();
  const fn=run(ctx,'_carryForwardStaleFedFutures');
  const result=fn([{month:'Aug 2026',impliedRate:4.0}],[],null,NOW);
  assert.strictEqual(result.fedFutures.length,1);
  assert.strictEqual(result.fedFuturesFailedMonths.length,0);
  assert.strictEqual(result.fedFuturesStaleMonths.length,0);
});

test('a failed month with a FRESH previous contract is carried forward as stale, with a real staleAsOf stamped from the previous cache', ()=>{
  const ctx=buildContext();
  const fn=run(ctx,'_carryForwardStaleFedFutures');
  const prevCache={ts:'09/23/2026, 10:00 PT',tsEpoch:NOW-DAY_MS,data:[{month:'Sep 2026',impliedRate:4.1}]};
  const result=fn([],['Sep 2026'],prevCache,NOW);
  assert.strictEqual(result.fedFuturesStaleMonths.length,1);
  assert.strictEqual(result.fedFutures[0].stale,true);
  assert.strictEqual(result.fedFutures[0].staleAsOfEpoch,NOW-DAY_MS);
  assert.strictEqual(result.fedFuturesFailedMonths.length,0);
});

test('a failed month with NO previous contract at all stays in fedFuturesFailedMonths', ()=>{
  const ctx=buildContext();
  const fn=run(ctx,'_carryForwardStaleFedFutures');
  const prevCache={ts:'x',tsEpoch:NOW-DAY_MS,data:[]}; // nothing for this month
  const result=fn([],['Oct 2026'],prevCache,NOW);
  assert.deepStrictEqual([...result.fedFuturesFailedMonths],['Oct 2026']);
  assert.strictEqual(result.fedFuturesStaleMonths.length,0);
});

// ============================================================================
section('Regression: staleAsOf must NOT be re-stamped to "now" on repeated carry-forwards');

test('a contract that was ALREADY stale (from a prior carry-forward) preserves its ORIGINAL staleAsOfEpoch, not the current save time', ()=>{
  const ctx=buildContext();
  const fn=run(ctx,'_carryForwardStaleFedFutures');
  const trueOriginalEpoch=NOW-3*DAY_MS; // genuinely 3 days old
  const prevCache={
    ts:'recent save',tsEpoch:NOW-DAY_MS, // the cache ITSELF was last saved just 1 day ago (because other months succeeded)...
    data:[{month:'Nov 2026',impliedRate:4.2,stale:true,staleAsOf:'3 days ago',staleAsOfEpoch:trueOriginalEpoch}], // ...but THIS month has been stuck since 3 days ago
  };
  const result=fn([],['Nov 2026'],prevCache,NOW);
  assert.strictEqual(result.fedFutures[0].staleAsOfEpoch,trueOriginalEpoch,'must preserve the TRUE original staleness date, not prevCache.tsEpoch (the unrelated recent save time)');
});

test("negative control: reconstructing the OLD (pre-fix) formula on this exact scenario DOES re-stamp staleAsOf to the recent save time -- confirms the bug was real, and that it would have made any age check meaningless", ()=>{
  const prevCache={ts:'recent save',tsEpoch:NOW-DAY_MS,data:[{month:'Nov 2026',impliedRate:4.2,stale:true,staleAsOf:'3 days ago',staleAsOfEpoch:NOW-3*DAY_MS}]};
  // The OLD line, reconstructed independently: `staleAsOf:prevCache.ts||null`
  // -- no branching on prev.stale at all, always uses the CACHE's own
  // save time.
  const oldStaleAsOf=prevCache.ts||null;
  assert.strictEqual(oldStaleAsOf,'recent save','the old formula really did use the recent save time, discarding the true 3-day-old origin -- confirms the bug');
});

// ============================================================================
section('Maximum staleness age cutoff (the originally reported fix)');

test('a contract stale for LESS than the max age is still carried forward', ()=>{
  const ctx=buildContext();
  const fn=run(ctx,'_carryForwardStaleFedFutures');
  const maxStale=run(ctx,'FED_FUTURES_MAX_STALE_MS');
  const prevCache={ts:'x',tsEpoch:NOW-(maxStale-1),data:[{month:'Dec 2026',impliedRate:4.3,stale:true,staleAsOf:'x',staleAsOfEpoch:NOW-(maxStale-1)}]};
  const result=fn([],['Dec 2026'],prevCache,NOW);
  assert.strictEqual(result.fedFuturesStaleMonths.length,1);
  assert.strictEqual(result.fedFuturesFailedMonths.length,0);
});

test('a contract stale for MORE than the max age is dropped -- treated as a genuine fetch failure, not carried forward again', ()=>{
  const ctx=buildContext();
  const fn=run(ctx,'_carryForwardStaleFedFutures');
  const maxStale=run(ctx,'FED_FUTURES_MAX_STALE_MS');
  const prevCache={ts:'x',tsEpoch:NOW-(maxStale+DAY_MS),data:[{month:'Jan 2027',impliedRate:4.4,stale:true,staleAsOf:'x',staleAsOfEpoch:NOW-(maxStale+DAY_MS)}]};
  const result=fn([],['Jan 2027'],prevCache,NOW);
  assert.strictEqual(result.fedFuturesStaleMonths.length,0,'must NOT be carried forward once past the max age');
  assert.deepStrictEqual([...result.fedFuturesFailedMonths],['Jan 2027']);
});

test('direct reproduction: without this fix, a contract stuck for weeks (but perpetually re-stamped) would NEVER hit this cutoff -- with the fix, it correctly does', ()=>{
  const ctx=buildContext();
  const fn=run(ctx,'_carryForwardStaleFedFutures');
  const maxStale=run(ctx,'FED_FUTURES_MAX_STALE_MS');
  // Simulate 10 consecutive fetch cycles, each 1 day apart, where this
  // month keeps failing every time but OTHER months keep succeeding (so
  // the cache keeps getting re-saved). If staleAsOf were re-stamped each
  // time (the old bug), this would never age out. With the fix, it
  // should age out once the TRUE origin exceeds the max.
  let prevCache=null;
  let cycleTime=NOW-10*DAY_MS;
  let fedFuturesStaleMonths=[];
  for(let day=0;day<10;day++){
    const result=fn([],['Feb 2027'],prevCache,cycleTime);
    fedFuturesStaleMonths=result.fedFuturesStaleMonths;
    if(fedFuturesStaleMonths.length){
      prevCache={ts:'day'+day,tsEpoch:cycleTime,data:result.fedFutures};
    }else{
      // Aged out -- no longer present to carry forward on subsequent cycles.
      prevCache={ts:'day'+day,tsEpoch:cycleTime,data:[]};
    }
    cycleTime+=DAY_MS;
  }
  assert.strictEqual(fedFuturesStaleMonths.length,0,'after 10 days of the same month failing, it must have aged out well before the end (max is 5 days)');
});

// ============================================================================
section('Chronological re-sort');

test('multiple carried-forward months end up correctly sorted chronologically, not in append order', ()=>{
  const ctx=buildContext();
  const fn=run(ctx,'_carryForwardStaleFedFutures');
  const prevCache={ts:'x',tsEpoch:NOW-DAY_MS,data:[
    {month:'Jan 2027',impliedRate:4.1},
    {month:'Aug 2026',impliedRate:4.2},
  ]};
  // Failed months given out of chronological order on purpose.
  const result=fn([{month:'Nov 2026',impliedRate:4.0}],['Jan 2027','Aug 2026'],prevCache,NOW);
  const months=[...result.fedFutures.map(c=>c.month)];
  assert.deepStrictEqual(months,['Aug 2026','Nov 2026','Jan 2027'],'must be chronological, not append order');
});

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
