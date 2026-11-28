#!/usr/bin/env node
'use strict';
// tests/price-cache-freshness-557.test.js -- build 557.
//
// Bug fixed: (1) loadTicker's gate treated any cached snapshot as fresh forever
// outside 9:30am-5pm ET, so a mid-week snapshot was served all weekend; and
// (2) app launch / opening the Ticker tab restored from cache with NO age check.
//
// New rule (_isPriceCacheFresh): inside the market window a snapshot is fresh
// for 5 minutes; outside it, only if taken >= 1 hour after the last completed
// close. Runs the ACTUAL shipped helpers.js/ui.js code, and the real loadTicker
// gate extracted from ticker.js. All market dates are hand-checked UTC instants.
// Usage: node tests/price-cache-freshness-557.test.js

const fs=require('fs');
const path=require('path');
const vm=require('vm');
const assert=require('assert');

const ROOT=path.join(__dirname,'..');
const src=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
const utc=(y,mo,d,h,mi,s=0)=>Date.UTC(y,mo-1,d,h,mi,s);
const MIN=60000;

function makeLocalStorage(){
  const store=new Map();
  return{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>{store.set(k,String(v));},removeItem:k=>{store.delete(k);},clear:()=>store.clear()};
}
const nav={onLine:true};
const ctx=vm.createContext({console,localStorage:makeLocalStorage(),window:{scrollY:0,scrollTo(){},addEventListener(){}},toast:()=>{},
  setTimeout:()=>1,setInterval:()=>1,requestAnimationFrame:f=>f(),navigator:nav,
  document:{getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},createElement:()=>({style:{}})}});
for(const f of ['js/storage.js','js/helpers.js','js/ui.js']) vm.runInContext(src(f),ctx,{filename:f});
vm.runInContext("var currentTicker=''; var currentBBSpan='6m'; var currentRPSpan='2y';",ctx);
const run=code=>vm.runInContext(code,ctx);
function call(fn,...args){ ctx.__a=args; return vm.runInContext(`${fn}(...__a)`,ctx); }
function setNow(ms){ run('Date.now=()=>'+ms); }

function extractFn(code,name){
  const start=code.indexOf('async function '+name+'(')>=0?code.indexOf('async function '+name+'('):code.indexOf('function '+name+'(');
  if(start<0)throw new Error('cannot find '+name);
  let i=code.indexOf('{',start),depth=0;
  for(;i<code.length;i++){ if(code[i]==='{')depth++; else if(code[i]==='}'){depth--; if(depth===0){i++;break;}} }
  return code.slice(start,i);
}
const TICKER=src('js/ticker.js');
vm.runInContext(extractFn(TICKER,'loadTicker'),ctx,{filename:'ticker.js:loadTicker'});

let pass=0,fail=0;
function test(name,fn){
  try{ fn(); pass++; console.log('  ok  --',name); }
  catch(e){ fail++; console.log('FAIL  --',name); console.log('      '+(e&&e.stack?e.stack.split('\n').slice(0,3).join('\n      '):e)); }
}
function section(name){ console.log('\n== '+name+' =='); }

// ============================================================================
section('_isMarketActiveWindow(nowMs): optional instant');
const win=ms=>call('_isMarketActiveWindow',ms);
test('9:29am closed, 9:30am open, 4:59pm open, 5:00pm closed; weekend closed (EST instants)',()=>{
  assert.strictEqual(win(utc(2026,11,16,14,29)),false); assert.strictEqual(win(utc(2026,11,16,14,30)),true);
  assert.strictEqual(win(utc(2026,11,16,21,59)),true);  assert.strictEqual(win(utc(2026,11,16,22,0)),false);
  assert.strictEqual(win(utc(2026,11,14,15,0)),false);  assert.strictEqual(win(utc(2026,11,15,15,0)),false);
});
test('no argument still works (returns a boolean, behavior unchanged)',()=>{
  assert.strictEqual(typeof run('_isMarketActiveWindow()'),'boolean');
});

// ============================================================================
section('_isPriceCacheFresh: hand-checked cases');
const fresh=(ep,now)=>call('_isPriceCacheFresh',ep,now);

// Sun Nov 15 2026 20:00 UTC. Last close Fri Nov 13 4:00pm EST = 21:00 UTC; settle boundary 5:00pm EST = 22:00 UTC.
const SUN=utc(2026,11,15,20,0);
test('weekend: a Friday 5:30pm snapshot is fresh (loads instantly, no fetch)',()=>assert.strictEqual(fresh(utc(2026,11,13,22,30),SUN),true));
test('weekend: the settle boundary is exact (5:00:00pm fresh, 4:59:59pm not)',()=>{
  assert.strictEqual(fresh(utc(2026,11,13,22,0),SUN),true);
  assert.strictEqual(fresh(utc(2026,11,13,21,59,59),SUN),false);
});
test('weekend: a 4:30pm Friday snapshot (before the close print settled) and a 3pm snapshot are stale',()=>{
  assert.strictEqual(fresh(utc(2026,11,13,21,30),SUN),false);
  assert.strictEqual(fresh(utc(2026,11,13,19,0),SUN),false);
});
test('weekend: a mid-week snapshot and a weeks-old snapshot are stale -- the original bug',()=>{
  assert.strictEqual(fresh(utc(2026,11,11,22,0),SUN),false);        // Wednesday
  assert.strictEqual(fresh(utc(2026,10,24,22,30),SUN),false);       // three weeks earlier
});
test('Monday pre-market (8am ET): last evening\'s snapshot is now STALE (build 558: the first look of the morning refetches to get the pre-market quote)',()=>{
  const now=utc(2026,11,16,13,0);
  assert.strictEqual(fresh(utc(2026,11,13,22,30),now),false);
  assert.strictEqual(fresh(utc(2026,11,13,21,30),now),false);
});
test('market hours (Mon 10am ET): 5-minute TTL, strict at exactly 5:00',()=>{
  const now=utc(2026,11,16,15,0);
  assert.strictEqual(fresh(now-2*MIN,now),true);
  assert.strictEqual(fresh(now-5*MIN,now),false);
  assert.strictEqual(fresh(now-5*MIN+1000,now),true);
  assert.strictEqual(fresh(now-6*MIN,now),false);
  assert.strictEqual(fresh(utc(2026,11,13,22,30),now),false,'Friday snapshot is stale once the market is open');
});
test('4:30pm ET is still inside the window (until 5pm): 2 minutes old fresh, 10 minutes old not',()=>{
  const now=utc(2026,11,16,21,30);
  assert.strictEqual(fresh(now-2*MIN,now),true); assert.strictEqual(fresh(now-10*MIN,now),false);
});
test('after hours (Mon 5:30pm ET): 4:30pm snapshot stale, 5:00pm and 5:10pm fresh',()=>{
  const now=utc(2026,11,16,22,30);
  assert.strictEqual(fresh(utc(2026,11,16,21,30),now),false);
  assert.strictEqual(fresh(utc(2026,11,16,22,0),now),true);
  assert.strictEqual(fresh(utc(2026,11,16,22,10),now),true);
});
test('Thanksgiving evening (Thu Nov 26, 6pm ET): settle is Wednesday 5pm ET',()=>{
  const now=utc(2026,11,26,23,0);
  assert.strictEqual(fresh(utc(2026,11,25,22,30),now),true);
  assert.strictEqual(fresh(utc(2026,11,25,20,0),now),false);
});
test('day after Thanksgiving (1pm early close): evening settle is 2pm ET -- 1:30pm stale, 3pm fresh',()=>{
  const now=utc(2026,11,27,23,0);
  assert.strictEqual(fresh(utc(2026,11,27,18,30),now),false);
  assert.strictEqual(fresh(utc(2026,11,27,20,0),now),true);
});
test('Christmas weekend (Sat Dec 26): last close is the 1pm early close on Thu Dec 24, settle 2pm ET',()=>{
  const now=utc(2026,12,26,12,0);
  assert.strictEqual(fresh(utc(2026,12,24,19,30),now),true);
  assert.strictEqual(fresh(utc(2026,12,24,17,0),now),false);
});
test('daylight saving: the Sunday after the clocks change (Nov 1), the last close was an EDT close (settle 21:00 UTC)',()=>{
  const now=utc(2026,11,1,18,0);
  assert.strictEqual(fresh(utc(2026,10,30,21,30),now),true);
  assert.strictEqual(fresh(utc(2026,10,30,20,30),now),false);
});
test('clock skew (snapshot in the future), missing, NaN and non-numeric epochs are never fresh',()=>{
  assert.strictEqual(fresh(SUN+MIN,SUN),false);
  for(const bad of [null,undefined,NaN,'1700000000000',Infinity]) assert.strictEqual(call('_isPriceCacheFresh',bad,SUN),false,String(bad));
});

// ============================================================================
section('_openTickerFromCacheOrRefresh (launch and Ticker-tab open)');
function entryRun(t,snap,{online=true,now=SUN}={}){
  const calls=[];
  ctx.restoreTickerFromCache=x=>calls.push('restore:'+x);
  ctx.loadTicker=()=>calls.push('load');
  nav.onLine=online; setNow(now);
  if(snap){ ctx.__s=snap; run(`S.set('snap_${t}',__s)`); } // tickers are unique per test, so a missing snapshot is simply never stored
  call('_openTickerFromCacheOrRefresh',t);
  nav.onLine=true;
  return calls;
}
// loadTicker is re-declared by later tests; restore the real one afterwards
const REAL_LOAD=extractFn(TICKER,'loadTicker');
test('current snapshot: restores from cache, no fetch',()=>{
  assert.deepStrictEqual(entryRun('FRSH',{ticker:'FRSH',price:1,tsEpoch:utc(2026,11,13,22,30)}),['restore:FRSH']);
});
test('stale snapshot while online: runs the full loadTicker',()=>{
  assert.deepStrictEqual(entryRun('STAL',{ticker:'STAL',price:1,tsEpoch:utc(2026,11,11,22,0)}),['load']);
});
test('stale snapshot while OFFLINE: restores from cache, no fetch attempt',()=>{
  assert.deepStrictEqual(entryRun('OFFL',{ticker:'OFFL',price:1,tsEpoch:utc(2026,10,24,22,0)},{online:false}),['restore:OFFL']);
});
test('snapshot with unknown age while online: refetches (age cannot be trusted)',()=>{
  assert.deepStrictEqual(entryRun('NOTS',{ticker:'NOTS',price:1}),['load']);
});
test('no snapshot at all: falls to restore (which no-ops), never a fetch; empty ticker does nothing',()=>{
  assert.deepStrictEqual(entryRun('NONE',null),['restore:NONE']);
  const calls=entryRun('',null); assert.deepStrictEqual(calls,[]);
});

// ============================================================================
section('The real loadTicker gate');
vm.runInContext(REAL_LOAD,ctx);
function gateRun({snap,online=true,now=SUN,selectVal='WELL'}){
  const calls=[],content={innerHTML:''};
  ctx.document.getElementById=id=>id==='ticker-select'?{value:selectVal}:id==='options-ticker-select'?{value:''}:id==='ticker-content'?content:({style:{},classList:{add(){},remove(){}},querySelector(){return null},innerHTML:'',textContent:'',value:''});
  ctx.restoreTickerFromCache=x=>calls.push('restore:'+x);
  ctx.showOfflineBanner=(a,b)=>calls.push('banner:'+a+'|'+b);
  ctx.clearOptionsState=()=>{};
  // anything past the gate runs the network path: make every fetcher hang, so nothing throws or resolves
  const hang=()=>new Promise(()=>{});
  ctx.fh=hang; ctx.fetchAfterHoursPrice=hang; ctx.fetchQuoteSummary=hang; ctx.yahooHistory=hang; ctx._tkTimeout=p=>p;
  run("currentTicker='WELL'");
  nav.onLine=online; setNow(now);
  if(snap){ ctx.__s=snap; run("S.set('snap_WELL',__s)"); } else run("localStorage.removeItem('snap_WELL')");
  const done=run('loadTicker()'); // async: the gate decision happens synchronously, before the first await
  nav.onLine=true;
  return{calls,fetching:content.innerHTML.includes('spinner')};
}
test('weekend, snapshot from Friday 5:30pm: restored from cache, no spinner, no fetch',()=>{
  const r=gateRun({snap:{ticker:'WELL',price:246.18,ts:'x',tsEpoch:utc(2026,11,13,22,30)}});
  assert.deepStrictEqual(r.calls,['restore:WELL']); assert.strictEqual(r.fetching,false);
});
test('THE BUG: weekend, snapshot from three weeks ago -> fetches (the old rule restored it from cache)',()=>{
  const r=gateRun({snap:{ticker:'WELL',price:246.18,ts:'x',tsEpoch:utc(2026,10,24,22,30)}});
  assert.deepStrictEqual(r.calls,[]); assert.strictEqual(r.fetching,true);
});
test('weekend, snapshot from Wednesday -> fetches',()=>{
  const r=gateRun({snap:{ticker:'WELL',price:1,tsEpoch:utc(2026,11,11,22,0)}});
  assert.strictEqual(r.fetching,true); assert.deepStrictEqual(r.calls,[]);
});
test('market hours: 2 minutes old restores, 6 minutes old fetches (unchanged policy)',()=>{
  const now=utc(2026,11,16,15,0);
  assert.deepStrictEqual(gateRun({snap:{ticker:'WELL',price:1,tsEpoch:now-2*MIN},now}).calls,['restore:WELL']);
  assert.strictEqual(gateRun({snap:{ticker:'WELL',price:1,tsEpoch:now-6*MIN},now}).fetching,true);
});
test('offline with a stale cache: restores immediately and shows the offline banner; no spinner',()=>{
  const r=gateRun({snap:{ticker:'WELL',price:1,ts:'Oct 24',tsEpoch:utc(2026,10,24,22,30)},online:false});
  assert.deepStrictEqual(r.calls,['restore:WELL','banner:Oct 24|'+utc(2026,10,24,22,30)]); assert.strictEqual(r.fetching,false);
});
test('offline with no cache: falls through to the normal path (which reports "no data")',()=>{
  const r=gateRun({snap:null,online:false}); assert.deepStrictEqual(r.calls,[]); assert.strictEqual(r.fetching,true);
});
test('online with a snapshot of unknown age: fetches, as before',()=>{
  const r=gateRun({snap:{ticker:'WELL',price:1}}); assert.strictEqual(r.fetching,true); assert.deepStrictEqual(r.calls,[]);
});

// ============================================================================
section('Wiring (guards against the old rule and the ungated restores coming back)');
const UI=src('js/ui.js'),INDEX=src('index.html');
test('loadTicker gate: uses the shared rule, no "Infinity" TTL, offline check first',()=>{
  const start=TICKER.indexOf('async function loadTicker()');
  const end=TICKER.indexOf('spinner',start);
  assert.ok(start>0&&end>start,'found the gate region (up to the first spinner markup)');
  const gate=TICKER.slice(start,end);
  const call_=gate.indexOf('_isPriceCacheFresh(_cachedSnap.tsEpoch)'),offline=gate.indexOf('navigator.onLine===false');
  assert.ok(call_>0,'gate calls the shared rule');
  assert.ok(!gate.includes('Infinity')&&!gate.includes('_ttlMs')&&!gate.includes('300000'));
  assert.ok(offline>0&&offline<call_,'offline short-circuit comes before the freshness check');
});
test('showTab and app launch go through _openTickerFromCacheOrRefresh, not a bare restore',()=>{
  assert.ok(UI.includes('_openTickerFromCacheOrRefresh(currentTicker)'));
  assert.ok(!UI.includes('restoreTickerFromCache(currentTicker)'));
  assert.ok(INDEX.includes('_openTickerFromCacheOrRefresh(lt)')&&!INDEX.includes('restoreTickerFromCache(lt)'));
});
test('Build 557 bookkeeping: sw build >= 557, Release Notes v4.4.9 above v4.4.8',()=>{
  const sw=src('sw.js'); assert.ok(Number(sw.match(/const APP_BUILD = (\d+)/)[1])>=557);
  assert.strictEqual(sw.match(/income-engine-v(\d+)/)[1],sw.match(/const APP_BUILD = (\d+)/)[1]);
  const i9=INDEX.indexOf('\nv4.4.9 -- 2026-11-'),i8=INDEX.indexOf('\nv4.4.8 -- 2026-11-');
  assert.ok(i9>0&&i9<i8); assert.ok(INDEX.indexOf('Service worker: v557')>0);
});

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
