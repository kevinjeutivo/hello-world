#!/usr/bin/env node
'use strict';
// tests/extended-hours-558.test.js -- build 558: pre-market prices.
//
// Before: the Yahoo fetch already captured the pre-market quote (mapped into the
// "postMarket*" slot with marketState 'PRE'), but the Ticker card hid the
// extended-hours line during pre-market, so it could never show; and a pre-market
// price fetched in the morning could reappear at 4:00pm labeled "Pre-market".
// Now: _extendedHoursLine decides by SESSION and by when the extended price was
// OBSERVED (postMarketAsOf); the price bar shows a compact PM/AH quote; and
// pre-market has its own freshness rule.
//
// Runs the ACTUAL shipped helpers.js / ui.js, and the real fetchAfterHoursPrice
// extracted from api.js. All market times are hand-checked UTC instants
// (EST = UTC-5 from Nov 1 2026, EDT = UTC-4 before; 4:00am ET = 09:00 UTC in
// November, 08:00 UTC in late October).
// Usage: node tests/extended-hours-558.test.js

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
let fetchImpl=async()=>({ok:false});
const ctx=vm.createContext({console,localStorage:makeLocalStorage(),window:{scrollY:0,scrollTo(){},addEventListener(){}},toast:()=>{},
  setTimeout:()=>1,setInterval:()=>1,requestAnimationFrame:f=>f(),navigator:{onLine:true},
  fetch:(...a)=>fetchImpl(...a),
  document:{getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},createElement:()=>({style:{}})}});
for(const f of ['js/storage.js','js/helpers.js','js/ui.js']) vm.runInContext(src(f),ctx,{filename:f});
vm.runInContext("var currentTicker=''; var offlineMode=false; var WORKER_URL='https://w.example';",ctx);
const run=code=>vm.runInContext(code,ctx);
function call(fn,...args){ ctx.__a=args; return vm.runInContext(`${fn}(...__a)`,ctx); }
function json(fn,...args){ ctx.__a=args; return JSON.parse(vm.runInContext(`JSON.stringify(${fn}(...__a))`,ctx)); }
function setNow(ms){ run('Date.now=()=>'+ms); }

function extractFn(code,name){
  const a=code.indexOf('async function '+name+'('),b=code.indexOf('function '+name+'(');
  const start=a>=0?a:b;
  if(start<0)throw new Error('cannot find '+name);
  let i=code.indexOf('{',start),depth=0;
  for(;i<code.length;i++){ if(code[i]==='{')depth++; else if(code[i]==='}'){depth--; if(depth===0){i++;break;}} }
  return code.slice(start,i);
}
const API=src('js/api.js'),TICKER=src('js/ticker.js'),PREFETCH=src('js/prefetch.js'),UI=src('js/ui.js'),HELPERS=src('js/helpers.js'),INDEX=src('index.html');
vm.runInContext(extractFn(API,'fetchAfterHoursPrice'),ctx,{filename:'api.js:fetchAfterHoursPrice'});

let pass=0,fail=0;
const queue=[];
function test(name,fn){ queue.push({name,fn}); }
function section(name){ queue.push({section:name}); }

// ============================================================================
section('Pre-market clock helpers (ET boundaries, DST, holidays)');
const pm=ms=>call('_isPremarketAt',ms);
test('Mon Nov 16: 3:59am closed, 4:00am pre-market, 9:29am pre-market, 9:30am no longer',()=>{
  assert.strictEqual(pm(utc(2026,11,16,8,59)),false); assert.strictEqual(pm(utc(2026,11,16,9,0)),true);
  assert.strictEqual(pm(utc(2026,11,16,14,29)),true); assert.strictEqual(pm(utc(2026,11,16,14,30)),false);
});
test('EDT: Fri Oct 30 3:59am EDT closed (07:59 UTC), 4:00am EDT pre-market (08:00 UTC)',()=>{
  assert.strictEqual(pm(utc(2026,10,30,7,59)),false); assert.strictEqual(pm(utc(2026,10,30,8,0)),true);
});
test('weekend and holiday mornings are not pre-market (Sat Nov 14, Thanksgiving Nov 26)',()=>{
  assert.strictEqual(pm(utc(2026,11,14,12,0)),false); assert.strictEqual(pm(utc(2026,11,26,12,0)),false);
});
test('_premarketStartEpoch is 4:00am ET on the date (EST and EDT)',()=>{
  assert.strictEqual(call('_premarketStartEpoch',utc(2026,11,16,15,0)),utc(2026,11,16,9,0));
  assert.strictEqual(call('_premarketStartEpoch',utc(2026,10,30,12,0)),utc(2026,10,30,8,0));
});

// ============================================================================
section('Pre-market freshness rule (_isPriceCacheFresh)');
const fresh=(ep,now)=>call('_isPriceCacheFresh',ep,now);
const MON7=utc(2026,11,16,12,0); // 7:00am EST
test('the first look of the morning refetches: last evening\'s snapshot is stale at 7am',()=>{
  assert.strictEqual(fresh(utc(2026,11,13,22,30),MON7),false);
});
test('later looks reuse the cache for 10 minutes (strict at exactly 10:00)',()=>{
  assert.strictEqual(fresh(MON7-5*MIN,MON7),true);
  assert.strictEqual(fresh(MON7-10*MIN,MON7),false);
  assert.strictEqual(fresh(MON7-10*MIN+1000,MON7),true);
  assert.strictEqual(fresh(MON7-10*MIN-1000,MON7),false);
});
test('a snapshot taken before 4:00am never counts, even if only minutes old (4:05am look, 3:58am snapshot)',()=>{
  const now=utc(2026,11,16,9,5);
  assert.strictEqual(fresh(utc(2026,11,16,8,58),now),false);
  assert.strictEqual(fresh(utc(2026,11,16,9,1),now),true);
});
test('holiday morning is not pre-market: Thanksgiving 7am, a Wednesday 5:30pm snapshot is still fresh',()=>{
  assert.strictEqual(fresh(utc(2026,11,25,22,30),utc(2026,11,26,12,0)),true);
});
test('regular session, evening and weekend rules are unchanged (spot checks)',()=>{
  const open=utc(2026,11,16,15,0);
  assert.strictEqual(fresh(open-2*MIN,open),true); assert.strictEqual(fresh(open-6*MIN,open),false);
  assert.strictEqual(fresh(utc(2026,11,13,22,30),utc(2026,11,15,20,0)),true);
  assert.strictEqual(fresh(utc(2026,11,11,22,0),utc(2026,11,15,20,0)),false);
});

// ============================================================================
section('fetchAfterHoursPrice: the real Yahoo field mapping');
const PM_TIME=Math.floor(utc(2026,11,16,11,30)/1000); // epoch SECONDS, as Yahoo reports
const quote=o=>async()=>({ok:true,json:async()=>({quoteResponse:{result:[Object.assign({regularMarketPrice:246.18,preMarketPrice:247.1,preMarketChange:0.92,preMarketChangePercent:0.37,preMarketTime:PM_TIME,postMarketPrice:240,postMarketChange:-6.18,postMarketChangePercent:-2.5,postMarketTime:PM_TIME-86400},o)]}})});
async function fetchQ(o){ fetchImpl=quote(o); return await run('fetchAfterHoursPrice("WELL")'); }
test('PRE: price, change, percent and TIME come from the pre-market fields (not yesterday\'s post-market ones)',async()=>{
  const r=await fetchQ({marketState:'PRE'});
  assert.deepStrictEqual([r.postMarketPrice,r.postMarketChange,r.postMarketChangePct,r.postMarketTime,r.marketState,r.hasExtended],[247.1,0.92,0.37,PM_TIME,'PRE',true]);
});
test('POST and POSTPOST use the post-market fields and their time',async()=>{
  for(const st of ['POST','POSTPOST']){
    const r=await fetchQ({marketState:st});
    assert.deepStrictEqual([r.postMarketPrice,r.postMarketChange,r.postMarketTime,r.marketState],[240,-6.18,PM_TIME-86400,st],st);
  }
});
test('CLOSED (weekend/holiday) uses the post-market fields',async()=>{
  const r=await fetchQ({marketState:'CLOSED'}); assert.deepStrictEqual([r.postMarketPrice,r.postMarketTime],[240,PM_TIME-86400]);
});
test('REGULAR and PREPRE report no extended price and no time',async()=>{
  for(const st of ['REGULAR','PREPRE']){
    const r=await fetchQ({marketState:st}); assert.deepStrictEqual([r.postMarketPrice,r.postMarketTime,r.hasExtended],[null,null,false],st);
  }
});
test('a missing time field yields null (the code must not depend on Yahoo supplying it)',async()=>{
  const r=await fetchQ({marketState:'PRE',preMarketTime:undefined}); assert.strictEqual(r.postMarketPrice,247.1); assert.strictEqual(r.postMarketTime,null);
});
test('PRE with no pre-market price yet: nothing, and no time',async()=>{
  const r=await fetchQ({marketState:'PRE',preMarketPrice:undefined}); assert.deepStrictEqual([r.postMarketPrice,r.postMarketTime,r.hasExtended],[null,null,false]);
});

// ============================================================================
section('_resolvePostMarketFields: observation time ("as of") through every branch');
const resolve=(fresh_,prev)=>json('_resolvePostMarketFields',fresh_,prev);
const NOWX=utc(2026,11,16,12,0);
test('fresh extended price with a Yahoo print time in SECONDS -> asOf in ms',()=>{
  setNow(NOWX); assert.strictEqual(resolve({marketState:'PRE',postMarketPrice:247.1,postMarketChange:0.92,postMarketChangePct:0.37,postMarketTime:PM_TIME},null).postMarketAsOf,PM_TIME*1000);
});
test('print time already in ms is kept; unusable times fall back to now',()=>{
  setNow(NOWX);
  assert.strictEqual(resolve({postMarketPrice:1,postMarketTime:PM_TIME*1000},null).postMarketAsOf,PM_TIME*1000);
  for(const bad of [null,undefined,0,-5,NaN,'x']) assert.strictEqual(resolve({postMarketPrice:1,postMarketTime:bad},null).postMarketAsOf,NOWX,String(bad));
});
test('a fresh PRE or REGULAR quote with no extended price CLEARS the old after-hours price and its time',()=>{
  const prev={postMarketPrice:240,marketState:'POST',postMarketAsOf:utc(2026,11,13,22,30),tsEpoch:1};
  for(const st of ['PRE','REGULAR']){ const r=resolve({marketState:st},prev); assert.deepStrictEqual([r.postMarketPrice,r.postMarketAsOf,r.marketState],[null,null,st],st); }
});
test('overnight/weekend refresh with no extended price CARRIES FORWARD the price and keeps its ORIGINAL time',()=>{
  const prev={postMarketPrice:240,postMarketChange:-1,postMarketChangePct:-0.4,marketState:'POST',postMarketAsOf:utc(2026,11,11,22,30),tsEpoch:utc(2026,11,14,15,0)};
  const r=resolve({marketState:'CLOSED'},prev);
  assert.deepStrictEqual([r.postMarketPrice,r.marketState,r.postMarketAsOf],[240,'POST',utc(2026,11,11,22,30)]);
});
test('legacy snapshot without postMarketAsOf: carries its fetch time; nothing anywhere gives nulls; a failed fetch (null quote) still carries',()=>{
  assert.strictEqual(resolve({marketState:'CLOSED'},{postMarketPrice:240,marketState:'POST',tsEpoch:777}).postMarketAsOf,777);
  const none=resolve({marketState:'CLOSED'},{});
  assert.deepStrictEqual([none.postMarketPrice,none.postMarketAsOf],[null,null]);
  assert.strictEqual(resolve(null,{postMarketPrice:240,marketState:'POST',postMarketAsOf:55}).postMarketAsOf,55);
});

// ============================================================================
section('_extendedHoursLine: what to show, by session and observation time');
const line=(snap,now)=>json('_extendedHoursLine',snap,now);
const pre=asOf=>({price:246.18,marketState:'PRE',postMarketPrice:247.1,postMarketChange:0.92,postMarketChangePct:0.37,postMarketAsOf:asOf,tsEpoch:asOf});
const post=asOf=>({price:246.18,marketState:'POST',postMarketPrice:247.5,postMarketChange:1.32,postMarketChangePct:0.54,postMarketAsOf:asOf,tsEpoch:asOf});
test('7am pre-market with a pre-market quote observed at 6:30am: shown, labeled Pre-market',()=>{
  const x=line(pre(utc(2026,11,16,11,30)),MON7);
  assert.deepStrictEqual([x.kind,x.label,x.price,x.change,x.pct],['pre','Pre-market',247.1,0.92,0.37]);
});
test('7am pre-market with only last evening\'s after-hours price: NOTHING (until the first pre-market print)',()=>{
  assert.strictEqual(line(post(utc(2026,11,13,22,30)),MON7),null);
});
test('pre-market never shows a non-PRE quote even if its time is after 4:00am (a legacy snapshot refreshed at 6am still holding yesterday\'s after-hours price)',()=>{
  const legacy={price:246.18,marketState:'POST',postMarketPrice:247.5,tsEpoch:utc(2026,11,16,11,0)}; // no postMarketAsOf: falls back to the 6:00am fetch time
  assert.strictEqual(line(legacy,MON7),null);
  assert.strictEqual(line(post(utc(2026,11,16,10,0)),MON7),null);
});
test('the 4:00am boundary: a pre-market quote observed at exactly 4:00:00 shows, 3:59:59 does not',()=>{
  const now=utc(2026,11,16,9,0);
  assert.strictEqual(line(pre(utc(2026,11,16,9,0)),now).kind,'pre');
  assert.strictEqual(line(pre(utc(2026,11,16,8,59,59)),now),null);
});
test('3:59am (overnight, not yet pre-market): the after-hours price still shows; a pre-market one does not',()=>{
  const now=utc(2026,11,16,8,59);
  assert.strictEqual(line(post(utc(2026,11,13,22,30)),now).kind,'post');
  assert.strictEqual(line(pre(utc(2026,11,16,8,0)),now),null);
});
test('regular session (Mon 10am ET): nothing, for either kind',()=>{
  const now=utc(2026,11,16,15,0);
  assert.strictEqual(line(pre(utc(2026,11,16,11,30)),now),null); assert.strictEqual(line(post(utc(2026,11,13,22,30)),now),null);
});
test('4:05pm: after-hours observed after the close shows; one observed before the 4:00pm close does not',()=>{
  const now=utc(2026,11,16,21,5);
  assert.strictEqual(line(post(utc(2026,11,16,21,3)),now).label,'After-hours');
  assert.strictEqual(line(post(utc(2026,11,16,20,59)),now),null);
});
test('THE STALE-LABEL QUIRK: a pre-market quote from 7am must NOT reappear at 4:05pm as "Pre-market"',()=>{
  assert.strictEqual(line(pre(utc(2026,11,16,12,0)),utc(2026,11,16,21,5)),null);
});
test('overnight (11pm ET Monday): that evening\'s after-hours price shows',()=>{
  assert.strictEqual(line(post(utc(2026,11,16,22,30)),utc(2026,11,17,4,0)).kind,'post');
});
test('weekend: Friday\'s after-hours price shows; a carried-forward Wednesday one and a Friday-morning pre-market one do not',()=>{
  const now=utc(2026,11,14,18,0);
  assert.strictEqual(line(post(utc(2026,11,13,22,30)),now).kind,'post');
  assert.strictEqual(line(post(utc(2026,11,11,22,30)),now),null);
  assert.strictEqual(line(pre(utc(2026,11,13,12,0)),now),null);
});
test('Thanksgiving morning (holiday): Wednesday evening\'s after-hours price shows',()=>{
  assert.strictEqual(line(post(utc(2026,11,25,22,30)),utc(2026,11,26,15,0)).kind,'post');
});
test('early close (day after Thanksgiving): hidden at 12:30pm, after-hours shows from the 1:00pm close',()=>{
  assert.strictEqual(line(post(utc(2026,11,27,18,10)),utc(2026,11,27,17,30)),null);
  assert.strictEqual(line(post(utc(2026,11,27,18,10)),utc(2026,11,27,18,30)).kind,'post');
});
test('EDT pre-market (Fri Oct 30, 8am EDT): quote at 4:00:00am EDT shows, 3:59:59 does not',()=>{
  const now=utc(2026,10,30,12,0);
  assert.strictEqual(line(pre(utc(2026,10,30,8,0)),now).kind,'pre'); assert.strictEqual(line(pre(utc(2026,10,30,7,59,59)),now),null);
});
test('yesterday\'s pre-market snapshot is stale the next morning',()=>{
  assert.strictEqual(line(pre(utc(2026,11,16,12,0)),utc(2026,11,17,12,0)),null);
});
test('legacy snapshots without postMarketAsOf fall back to their fetch time',()=>{
  const legacyPost={price:246.18,marketState:'POST',postMarketPrice:247.5,tsEpoch:utc(2026,11,13,22,30)};
  assert.strictEqual(line(legacyPost,utc(2026,11,14,18,0)).kind,'post');
  const legacyPre={price:246.18,marketState:'PRE',postMarketPrice:247.1,tsEpoch:utc(2026,11,16,11,30)};
  assert.strictEqual(line(legacyPre,MON7).kind,'pre');
});
test('guards: equal price, zero/NaN/missing price, missing times, null snapshot -> null',()=>{
  assert.strictEqual(line(Object.assign(pre(utc(2026,11,16,11,30)),{postMarketPrice:246.18}),MON7),null);
  for(const bad of [0,NaN,undefined,null,-1,'247']) assert.strictEqual(line(Object.assign(pre(utc(2026,11,16,11,30)),{postMarketPrice:bad}),MON7),null,String(bad));
  assert.strictEqual(line({price:1,marketState:'PRE',postMarketPrice:2},MON7),null);
  assert.strictEqual(line(null,MON7),null);
});

// ============================================================================
section('_extendedHoursHtml (Ticker card line)');
const html=(snap,now)=>call('_extendedHoursHtml',snap,now);
test('pre-market, up: label, price, change with percent, state, green',()=>{
  const h=html(pre(utc(2026,11,16,11,30)),MON7);
  assert.ok(h.includes('Pre-market: $247.10')&&h.includes('+0.92 (+0.37%)')&&h.includes('(PRE)')&&h.includes('var(--green)'),h);
});
test('after-hours, down: red with minus signs',()=>{
  const s=Object.assign(post(utc(2026,11,16,21,3)),{postMarketPrice:245.5,postMarketChange:-0.68,postMarketChangePct:-0.28});
  const h=html(s,utc(2026,11,16,21,5));
  assert.ok(h.includes('After-hours: $245.50')&&h.includes('-0.68 (-0.28%)')&&h.includes('var(--red)')&&h.includes('(POST)'),h);
});
test('no change value: no change span (as before); nothing to show: empty string',()=>{
  const s=Object.assign(pre(utc(2026,11,16,11,30)),{postMarketChange:null,postMarketChangePct:null});
  assert.ok(!html(s,MON7).includes('font-size:11px'));
  assert.strictEqual(html(post(utc(2026,11,13,22,30)),MON7),'');
});

// ============================================================================
section('Price bar (_renderContextBar) with an extended-hours quote');
function dom(){
  const bar={style:{}},sym={textContent:''}; let h='';
  const price={get innerHTML(){return h;},set innerHTML(v){h=v;}};
  ctx.document.getElementById=id=>({'context-bar':bar,'context-bar-symbol':sym,'context-bar-price':price})[id]||null;
  return{bar,sym,price};
}
function bar(tab,snapObj,now){
  const d=dom(); setNow(now);
  ctx.__s=snapObj; run(`S.set('snap_${snapObj.ticker}',__s)`);
  run(`_activeTabName='${tab}';currentTicker='${snapObj.ticker}';`); call('_renderContextBar');
  return d.price.innerHTML;
}
test('pre-market: compact "PM $247.10 +0.37%" after the regular price and percent (dollar change dropped to fit)',()=>{
  const h=bar('ticker',Object.assign(pre(utc(2026,11,16,11,30)),{ticker:'PMA',change:1.04,changePct:0.42}),MON7);
  assert.ok(h.startsWith('$246.18 <span style="color:var(--green)">+0.42%</span>'),h);
  assert.ok(h.includes('PM $247.10 +0.37%')&&h.includes('title="Pre-market quote"'),h);
  assert.ok(!h.includes('+1.04')&&!h.includes('(+0.42%)'),'absolute change and parentheses are dropped when an extended quote is shown');
});
test('same on the Options tab (one shared bar); after-hours says AH and goes red when below the close',()=>{
  const s=Object.assign(post(utc(2026,11,16,21,3)),{ticker:'AHB',change:-0.19,changePct:-0.18,postMarketPrice:245.5,postMarketChange:-0.68,postMarketChangePct:-0.28});
  const h=bar('options',s,utc(2026,11,16,21,5));
  assert.ok(h.includes('AH $245.50 -0.28%')&&h.includes('var(--red)')&&h.includes('title="After-hours quote"'),h);
});
test('missing percent is computed from the two prices: 247.10 vs 246.18 -> +0.37%',()=>{
  const h=bar('ticker',Object.assign(pre(utc(2026,11,16,11,30)),{ticker:'NOPC',change:0,changePct:0,postMarketChangePct:null}),MON7);
  assert.ok(h.includes('PM $247.10 +0.37%'),h);
});
test('no extended quote to show (regular session, or yesterday\'s after-hours at 7am): the ORIGINAL format is unchanged',()=>{
  const reg=bar('ticker',Object.assign(post(utc(2026,11,13,22,30)),{ticker:'REGB',change:1.04,changePct:0.42}),utc(2026,11,16,15,0));
  assert.ok(reg.includes('+1.04 (+0.42%)')&&!reg.includes('AH $')&&!reg.includes('PM $'),reg);
  const morning=bar('ticker',Object.assign(post(utc(2026,11,13,22,30)),{ticker:'MORN',change:1.04,changePct:0.42}),MON7);
  assert.ok(morning.includes('+1.04 (+0.42%)')&&!morning.includes('AH $'),morning);
});
test('the extended quote and the age tag never appear together (no crowding of the slim bar)',()=>{
  // a snapshot old enough to be tagged "behind the last close" cannot carry an extended price observed after that close
  setNow(utc(2026,11,15,20,0));
  const old={ticker:'TAGX',price:246.18,change:1,changePct:0.4,marketState:'POST',postMarketPrice:247.5,postMarketAsOf:utc(2026,11,13,19,0),tsEpoch:utc(2026,11,13,19,0)};
  const h=bar('options',old,utc(2026,11,15,20,0));
  assert.ok(h.includes('var(--warn)')&&!h.includes('AH $'),h);
});

// ============================================================================
section('Wiring and bookkeeping (guards against the old behavior returning)');
test('the Ticker card uses the shared display rule; the old clock-only inline rule is gone',()=>{
  assert.ok(TICKER.includes('${_extendedHoursHtml(snap)}'));
  assert.ok(!TICKER.includes('suppress during open session and premarket')&&!TICKER.includes('const _isPre=_ms==='));
});
test('all three snapshot builders carry postMarketAsOf (loadTicker, refreshSingleTicker, Prefetch All)',()=>{
  assert.ok(TICKER.includes('postMarketAsOf:_pmFields.postMarketAsOf')&&TICKER.includes('postMarketAsOf:_rPmFields.postMarketAsOf'));
  assert.ok(PREFETCH.includes('postMarketAsOf:_pfPmFields.postMarketAsOf'));
});
test('the Yahoo fetch returns the extended print time; the resolver is the single place it is carried',()=>{
  assert.ok(API.includes('postMarketTime:extTime||null'));
  assert.ok(HELPERS.includes('postMarketAsOf:_extTimeToMs(freshQuote.postMarketTime)??Date.now()'));
  assert.ok(HELPERS.includes('postMarketAsOf:prevSnap.postMarketAsOf??prevSnap.tsEpoch??null'));
});
test('freshness rule has its pre-market branch between the market window and the evening rule; bar uses the display rule',()=>{
  const f=UI.slice(UI.indexOf('function _isPriceCacheFresh'),UI.indexOf('function _openTickerFromCacheOrRefresh'));
  assert.ok(f.indexOf('_isMarketActiveWindow(now)')<f.indexOf('_isPremarketAt(now)')&&f.indexOf('_isPremarketAt(now)')<f.indexOf('_lastCompletedCloseEpoch(now)'));
  assert.ok(UI.includes('const ext=_extendedHoursLine(snap);'));
});
test('Build 558 bookkeeping: sw build >= 558, Release Notes v4.4.10 above v4.4.9',()=>{
  const sw=src('sw.js'); assert.ok(Number(sw.match(/const APP_BUILD = (\d+)/)[1])>=558);
  assert.strictEqual(sw.match(/income-engine-v(\d+)/)[1],sw.match(/const APP_BUILD = (\d+)/)[1]);
  const i10=INDEX.indexOf('\nv4.4.10 -- 2026-11-'),i9=INDEX.indexOf('\nv4.4.9 -- 2026-11-');
  assert.ok(i10>0&&i10<i9); assert.ok(INDEX.indexOf('Service worker: v558')>0);
});

// ============================================================================
(async()=>{
  for(const q of queue){
    if(q.section){ console.log('\n== '+q.section+' =='); continue; }
    try{ await q.fn(); pass++; console.log('  ok  --',q.name); }
    catch(e){ fail++; console.log('FAIL  --',q.name); console.log('      '+(e&&e.stack?e.stack.split('\n').slice(0,3).join('\n      '):e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
