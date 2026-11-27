#!/usr/bin/env node
'use strict';
// tests/context-bar-556.test.js -- build 556.
//
// Bug fixed: the sticky ticker price bar was pinned with a hardcoded top:130px,
// so when the header grew (VIX badge row, wrapped market banner) the bar slid
// behind it and vanished. It now lives inside #sticky-chrome, under the tabs,
// so layout keeps it flush. It also appears on the Options tab (Ticker and
// Options share one currentTicker) and carries a session-aware price-age tag.
//
// Runs the ACTUAL shipped js/ui.js (plus storage.js and helpers.js) in a vm.
// All market dates are hand-checked (UTC instants written out below).
// Usage: node tests/context-bar-556.test.js

const fs=require('fs');
const path=require('path');
const vm=require('vm');
const assert=require('assert');

const ROOT=path.join(__dirname,'..');
const src=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
const utc=(y,mo,d,h,mi,s=0)=>Date.UTC(y,mo-1,d,h,mi,s);

function makeLocalStorage(){
  const store=new Map();
  return{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>{store.set(k,String(v));},removeItem:k=>{store.delete(k);},clear:()=>store.clear()};
}
const ctx=vm.createContext({console,localStorage:makeLocalStorage(),window:{scrollY:0,scrollTo(){},addEventListener(){}},toast:()=>{},
  setTimeout:()=>1,setInterval:()=>1,requestAnimationFrame:f=>f(),navigator:{},
  document:{getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},createElement:()=>({style:{}})}});
for(const f of ['js/storage.js','js/helpers.js','js/ui.js']) vm.runInContext(src(f),ctx,{filename:f});
vm.runInContext("var currentTicker=''; var lastOptionsTickerLoaded='';",ctx);

const run=code=>vm.runInContext(code,ctx);
function call(fn,...args){ ctx.__a=args; return vm.runInContext(`${fn}(...__a)`,ctx); }
function setNow(ms){ run('Date.now=()=>'+ms); }

let pass=0,fail=0;
function test(name,fn){
  try{ fn(); pass++; console.log('  ok  --',name); }
  catch(e){ fail++; console.log('FAIL  --',name); console.log('      '+(e&&e.stack?e.stack.split('\n').slice(0,3).join('\n      '):e)); }
}
function section(name){ console.log('\n== '+name+' =='); }

// ============================================================================
section('New York time helpers (EST vs EDT, no 24:00)');

test('_etPartsAt: 16:00 EST, 16:00 EDT, and midnight reads 0 not 24',()=>{
  let p=call('_etPartsAt',utc(2026,11,13,21,0));  assert.deepStrictEqual([p.y,p.mo,p.d,p.h,p.mi],[2026,11,13,16,0]);
  p=call('_etPartsAt',utc(2026,7,2,20,0));        assert.deepStrictEqual([p.y,p.mo,p.d,p.h,p.mi],[2026,7,2,16,0]);
  p=call('_etPartsAt',utc(2026,11,14,5,0));       assert.deepStrictEqual([p.d,p.h,p.mi],[14,0,0]);
});
test('_etWallToEpoch: 4pm ET across both DST changes (DST ends Sun Nov 1 2026, starts Sun Mar 8 2026)',()=>{
  assert.strictEqual(call('_etWallToEpoch',2026,11,13,16,0),utc(2026,11,13,21,0)); // EST = UTC-5
  assert.strictEqual(call('_etWallToEpoch',2026,10,30,16,0),utc(2026,10,30,20,0)); // EDT = UTC-4
  assert.strictEqual(call('_etWallToEpoch',2026,11,2,16,0),utc(2026,11,2,21,0));   // first Monday after DST ends
  assert.strictEqual(call('_etWallToEpoch',2026,3,6,16,0),utc(2026,3,6,21,0));     // Friday before DST starts
  assert.strictEqual(call('_etWallToEpoch',2026,3,9,16,0),utc(2026,3,9,20,0));     // Monday after
});

// ============================================================================
section('_lastCompletedCloseEpoch (weekends, holidays, early closes, DST)');

const lc=ms=>call('_lastCompletedCloseEpoch',ms);
test('Saturday and Monday pre-market both resolve to Friday 4:00pm ET',()=>{
  assert.strictEqual(lc(utc(2026,11,14,18,0)),utc(2026,11,13,21,0));
  assert.strictEqual(lc(utc(2026,11,16,13,0)),utc(2026,11,13,21,0)); // Mon 8:00am ET
});
test('exactly at the bell is "completed"; one second before is not',()=>{
  assert.strictEqual(lc(utc(2026,11,16,21,0)),utc(2026,11,16,21,0));
  assert.strictEqual(lc(utc(2026,11,16,20,59,59)),utc(2026,11,13,21,0));
});
test('Thanksgiving (Thu Nov 26 2026) is skipped: previous close is Wednesday',()=>{
  assert.strictEqual(lc(utc(2026,11,26,15,0)),utc(2026,11,25,21,0));
});
test('day after Thanksgiving closes at 1:00pm ET; before that bell the last close is Wednesday',()=>{
  assert.strictEqual(lc(utc(2026,11,27,18,30)),utc(2026,11,27,18,0));
  assert.strictEqual(lc(utc(2026,11,27,17,59)),utc(2026,11,25,21,0));
});
test('DST: EDT close on Fri Oct 30, EST close on Mon Nov 2',()=>{
  assert.strictEqual(lc(utc(2026,10,30,21,0)),utc(2026,10,30,20,0));
  assert.strictEqual(lc(utc(2026,11,2,21,30)),utc(2026,11,2,21,0));
});
test('Christmas 2026: Fri Dec 25 is a holiday and Thu Dec 24 closes early (1:00pm ET)',()=>{
  assert.strictEqual(lc(utc(2026,12,26,12,0)),utc(2026,12,24,18,0));
});

section('_isRegularSessionAt');
const open=ms=>call('_isRegularSessionAt',ms);
test('9:29 closed, 9:30 open, 3:59pm open, 4:00pm closed',()=>{
  assert.strictEqual(open(utc(2026,11,16,14,29)),false); assert.strictEqual(open(utc(2026,11,16,14,30)),true);
  assert.strictEqual(open(utc(2026,11,16,20,59)),true);  assert.strictEqual(open(utc(2026,11,16,21,0)),false);
});
test('early-close day, holiday and weekend',()=>{
  assert.strictEqual(open(utc(2026,11,27,17,59)),true);  assert.strictEqual(open(utc(2026,11,27,18,0)),false);
  assert.strictEqual(open(utc(2026,11,26,15,0)),false);  assert.strictEqual(open(utc(2026,11,14,15,0)),false);
});

// ============================================================================
section('_priceAgeTag (session-aware rule + 30-minute open-market check)');

const NOW_SUN=utc(2026,11,15,20,0), NOW_MON_PRE=utc(2026,11,16,13,0), NOW_OPEN=utc(2026,11,16,17,0), NOW_POST=utc(2026,11,16,21,30);
const tag=(ep,now)=>call('_priceAgeTag',{price:1,tsEpoch:ep},now);

test('Friday post-close print viewed Sunday: NOT flagged (nothing has traded since)',()=>{
  assert.strictEqual(tag(utc(2026,11,13,21,30),NOW_SUN),null);
});
test('Friday close viewed Monday before the open (3 days old): NOT flagged -- the naive "2 days" rule would have been wrong',()=>{
  assert.strictEqual(tag(utc(2026,11,13,21,30),NOW_MON_PRE),null);
});
test('snapshot taken at 3pm Friday (before the close) viewed Sunday: flagged "2d ago"',()=>{
  const t=tag(utc(2026,11,13,19,0),NOW_SUN); assert.deepStrictEqual([t.kind,t.text],['session','2d ago']);
});
test('a session missed (Wednesday evening snapshot viewed Sunday): "4d ago"',()=>{
  const t=tag(utc(2026,11,11,21,30),NOW_SUN); assert.deepStrictEqual([t.kind,t.text],['session','4d ago']);
});
test('market open: 40 minutes old flagged, 20 minutes old not, exactly 30 minutes not, 30m01s flagged',()=>{
  const m=60000;
  const t=tag(NOW_OPEN-40*m,NOW_OPEN); assert.deepStrictEqual([t.kind,t.text],['intraday','40m ago']);
  assert.strictEqual(tag(NOW_OPEN-20*m,NOW_OPEN),null);
  assert.strictEqual(tag(NOW_OPEN-30*m,NOW_OPEN),null);
  assert.strictEqual(tag(NOW_OPEN-30*m-1000,NOW_OPEN).kind,'intraday');
});
test('market open Monday with a Friday-close snapshot: flagged "3d ago" (not behind a close, but stale against live)',()=>{
  const t=tag(utc(2026,11,13,21,30),NOW_OPEN); assert.deepStrictEqual([t.kind,t.text],['intraday','3d ago']);
});
test('after the bell: a 3pm snapshot is behind the close ("2h ago"); a 4:10pm snapshot is current',()=>{
  const t=tag(utc(2026,11,16,20,0),NOW_POST); assert.deepStrictEqual([t.kind,t.text],['session','2h ago']);
  assert.strictEqual(tag(utc(2026,11,16,21,10),NOW_POST),null);
});
test('early-close Friday Nov 27 viewed 1:30pm ET: a 12:00pm snapshot is behind the 1:00pm close; a 1:10pm one is current',()=>{
  const now=utc(2026,11,27,18,30);
  assert.strictEqual(tag(utc(2026,11,27,17,0),now).kind,'session');
  assert.strictEqual(tag(utc(2026,11,27,18,10),now),null);
});
test('unknown age or no snapshot gives no tag and never throws',()=>{
  assert.strictEqual(call('_priceAgeTag',{price:1},NOW_SUN),null);
  assert.strictEqual(call('_priceAgeTag',null,NOW_SUN),null);
  assert.strictEqual(call('_priceAgeTag',undefined,NOW_SUN),null);
});
test('_ageTextAt has the same wording and thresholds as relAge (parity, pinned clock)',()=>{
  setNow(NOW_SUN);
  for(const secs of [10,59,60,61,3599,3600,3601,86399,86400,90000,6*86400]){
    const ep=NOW_SUN-secs*1000;
    assert.strictEqual(call('_ageTextAt',ep,NOW_SUN),call('relAge',null,ep),'secs='+secs);
  }
});

// ============================================================================
section('_renderContextBar');

function dom(){
  const writes={n:0};
  const bar={style:{}},sym={textContent:''};
  let html='';
  const price={get innerHTML(){return html;},set innerHTML(v){html=v;writes.n++;}};
  ctx.document.getElementById=id=>({'context-bar':bar,'context-bar-symbol':sym,'context-bar-price':price})[id]||null;
  return{bar,sym,price,writes};
}
function ctxState(tab,tk){ run(`_activeTabName='${tab}';currentTicker='${tk}';`); }
const FRESH=utc(2026,11,13,21,30);
function putSnap(t,price,change,pct,ep){ ctx.__s={ticker:t,price,change,changePct:pct,tsEpoch:ep}; run(`S.set('snap_${t}',__s)`); }
putSnap('WELL',246.18,1.04,0.42,FRESH);
putSnap('SBUX',106.44,-0.19,-0.18,FRESH);
putSnap('FLAT',50,0,0,FRESH);

test('hidden on other tabs and when no ticker is in effect',()=>{
  const d=dom(); setNow(NOW_SUN);
  for(const tab of ['dashboard','watchlist','income','vix','earnings','etf','market','guide']){
    ctxState(tab,'WELL'); call('_renderContextBar'); assert.strictEqual(d.bar.style.display,'none',tab);
  }
  ctxState('ticker','');        call('_renderContextBar'); assert.strictEqual(d.bar.style.display,'none');
  ctxState('options','');       call('_renderContextBar'); assert.strictEqual(d.bar.style.display,'none');
});
test('Ticker and Options tabs show the same symbol and price (one shared bar)',()=>{
  const d=dom(); setNow(NOW_SUN);
  ctxState('ticker','WELL'); call('_renderContextBar');
  const tickerHtml=d.price.innerHTML;
  assert.strictEqual(d.bar.style.display,'flex'); assert.strictEqual(d.sym.textContent,'WELL');
  assert.ok(tickerHtml.startsWith('$246.18 ')&&tickerHtml.includes('+1.04 (+0.42%)')&&tickerHtml.includes('var(--green)'));
  assert.ok(!tickerHtml.includes('var(--warn)'),'fresh price: no tag');
  ctxState('options','WELL'); call('_renderContextBar');
  assert.strictEqual(d.price.innerHTML,tickerHtml); assert.strictEqual(d.bar.style.display,'flex');
});
test('down day is red with a minus sign; flat day follows the existing convention (+0.00, green)',()=>{
  const d=dom(); setNow(NOW_SUN);
  ctxState('ticker','SBUX'); call('_renderContextBar');
  assert.ok(d.price.innerHTML.includes('-0.19 (-0.18%)')&&d.price.innerHTML.includes('var(--red)')&&!d.price.innerHTML.includes('+-'));
  ctxState('ticker','FLAT'); call('_renderContextBar');
  assert.ok(d.price.innerHTML.includes('+0.00 (+0.00%)')&&d.price.innerHTML.includes('var(--green)'));
});
test('session-stale price gets the amber tag with an explanatory title (Sunday, snapshot from 3pm Friday)',()=>{
  const d=dom(); setNow(NOW_SUN);
  putSnap('OLDT',10,0.5,5,utc(2026,11,13,19,0));
  ctxState('options','OLDT'); call('_renderContextBar');
  assert.ok(d.price.innerHTML.includes('var(--warn)')&&d.price.innerHTML.includes('2d ago')&&d.price.innerHTML.includes('predates the last market close'));
});
test('intraday tag while the market is open (40 minutes old)',()=>{
  const d=dom(); setNow(NOW_OPEN);
  putSnap('SLOW',10,0.5,5,NOW_OPEN-40*60000);
  ctxState('ticker','SLOW'); call('_renderContextBar');
  assert.ok(d.price.innerHTML.includes('40m ago')&&d.price.innerHTML.includes('over 30 minutes old'));
});
test('ticker with no snapshot: symbol only, bar still shown',()=>{
  const d=dom(); setNow(NOW_SUN);
  ctxState('options','ZZZ'); call('_renderContextBar');
  assert.strictEqual(d.sym.textContent,'ZZZ'); assert.strictEqual(d.price.innerHTML,''); assert.strictEqual(d.bar.style.display,'flex');
});
test('snapOverride wins only when it is for the ticker in effect',()=>{
  const d=dom(); setNow(NOW_SUN);
  ctxState('ticker','WELL');
  ctx.__o={ticker:'WELL',price:300,change:2,changePct:0.67,tsEpoch:FRESH}; call('_renderContextBar',ctx.__o);
  assert.ok(d.price.innerHTML.startsWith('$300.00'));
  ctx.__o={ticker:'OTHER',price:999,change:1,changePct:1,tsEpoch:FRESH}; call('_renderContextBar',ctx.__o);
  assert.ok(d.price.innerHTML.startsWith('$246.18'),'a mismatched override is ignored, cache used');
});
test('changing the ticker (from either tab) updates the symbol on the next render',()=>{
  const d=dom(); setNow(NOW_SUN);
  ctxState('options','WELL'); call('_renderContextBar'); assert.strictEqual(d.sym.textContent,'WELL');
  run("currentTicker='SBUX'"); call('_renderContextBar'); assert.strictEqual(d.sym.textContent,'SBUX');
  assert.ok(d.price.innerHTML.includes('$106.44'));
});
test('unchanged content is not rewritten (the 30-second refresh does not churn the DOM)',()=>{
  const d=dom(); setNow(NOW_SUN);
  ctxState('ticker','WELL'); call('_renderContextBar'); call('_renderContextBar'); call('_renderContextBar');
  assert.strictEqual(d.writes.n,1);
});
test('missing elements never throw',()=>{
  ctx.document.getElementById=()=>null; ctxState('ticker','WELL'); call('_renderContextBar');
  const d=dom(); ctx.document.getElementById=id=>id==='context-bar'?d.bar:null; call('_renderContextBar');
});

section('showTab renders the bar after the tab is active and BEFORE the scroll restore');
test('call order: tab set -> bar -> scroll',()=>{
  const order=[];
  const stubEl=()=>({classList:{add(){},remove(){}},value:''});
  ctx.document.getElementById=id=>stubEl();
  ctx.document.querySelectorAll=sel=>sel==='.nav-tab'?Array.from({length:10},stubEl):[];
  ctx.window.scrollTo=()=>order.push('scroll');
  ctx.refreshTsChipAges=()=>{}; ctx.restoreOIChartFromCache=()=>{}; ctx._syncOptionsFreshness=()=>{}; ctx.loadOptionsForTicker=()=>{};
  const orig=ctx._renderContextBar;
  ctx._renderContextBar=()=>order.push('bar:'+run('_activeTabName'));
  run("currentTicker='WELL'; lastOptionsTickerLoaded='WELL';");
  try{ call('showTab','options'); }finally{ ctx._renderContextBar=orig; }
  assert.deepStrictEqual(order,['bar:options','scroll']);
});

// ============================================================================
section('_updateNavTop: the Income account bar offset must NOT include the context bar');

function navTopRun(chromeH,barH){
  let styleText=null;
  const styleEl={id:'_nav-top-style',set textContent(v){styleText=v;},get textContent(){return styleText;}};
  ctx.dbgLog=()=>{};
  ctx.document.getElementById=id=>id==='sticky-chrome'?{offsetHeight:chromeH}:id==='context-bar'?{offsetHeight:barH}:id==='_nav-top-style'?styleEl:null;
  ctx.document.createElement=()=>styleEl; ctx.document.head={appendChild(){}};
  run('window._cachedChromeH=0');
  call('_updateNavTop');
  return styleText;
}
test('chrome 170 with a 22px context bar showing -> Income bar top is 148 (same as with the bar hidden)',()=>{
  assert.strictEqual(navTopRun(170,22),'#income-acct-bar { top: 148px !important; }');
  assert.strictEqual(navTopRun(148,0),'#income-acct-bar { top: 148px !important; }');
});
test('missing context bar element is harmless; out-of-range heights are still ignored',()=>{
  const el={textContent:null};
  ctx.document.getElementById=id=>id==='sticky-chrome'?{offsetHeight:150}:id==='_nav-top-style'?el:null;
  ctx.document.createElement=()=>el; ctx.document.head={appendChild(){}}; run('window._cachedChromeH=0');
  call('_updateNavTop'); assert.strictEqual(el.textContent,'#income-acct-bar { top: 150px !important; }');
  assert.strictEqual(navTopRun(20,0),null);
});

// ============================================================================
section('Wiring and structure (guards against reintroducing the hardcoded offset)');

const INDEX=src('index.html'),UI=src('js/ui.js'),TICKER=src('js/ticker.js'),OPTIONS=src('js/options.js'),PATTERNS=src('js/patterns.js');
test('the bar lives INSIDE #sticky-chrome, after the tabs and before the tab panels; old bar and its 130px offset are gone',()=>{
  assert.strictEqual(INDEX.split('id="context-bar"').length-1,1);
  const chrome=INDEX.indexOf('id="sticky-chrome"'),bar=INDEX.indexOf('id="context-bar"');
  const lastTab=INDEX.indexOf("showTab('guide')"),end=INDEX.indexOf('<!-- /sticky-chrome -->'),panel=INDEX.indexOf('class="tab-panel');
  assert.ok(chrome<lastTab&&lastTab<bar&&bar<end&&end<panel);
  assert.ok(!INDEX.includes('ticker-sticky')&&!TICKER.includes('ticker-sticky'));
  const stickies=(INDEX.match(/id="[\w-]+" style="[^"]*position:sticky;top:130px/g)||[]).map(x=>x.match(/id="([\w-]+)"/)[1]);
  assert.deepStrictEqual(stickies,['income-acct-bar'],'only the Income account bar keeps a 130px offset, and _updateNavTop overrides it by measurement');
});
test('the bar is slim (22px, 12px symbol, 11px price) and is not position:sticky itself',()=>{
  const m=INDEX.match(/<div id="context-bar"[^>]*>/)[0];
  assert.ok(m.includes('height:22px')&&!m.includes('sticky')&&!m.includes('fixed'));
  assert.ok(INDEX.includes('id="context-bar-symbol" style="font-size:12px')&&INDEX.includes('id="context-bar-price" style="font-size:11px'));
});
test('refresh timer, tab-switch hook, ticker-change hooks and the render hook are all in place',()=>{
  assert.ok(/setInterval\(\(\)=>\{try\{_renderContextBar\(\);\}catch\(e\)\{console\.warn\('Context bar:',e\.message\);\}\},30000\)/.test(INDEX));
  const a=UI.indexOf('_activeTabName = name;\n'),b=UI.indexOf('_renderContextBar();',a),c=UI.indexOf('window.scrollTo(0, _tabScrollPos[name]');
  assert.ok(a>0&&b>a&&c>b);
  assert.strictEqual((TICKER.match(/_renderContextBar\(snap\)/g)||[]).length,1);
  assert.ok(TICKER.includes("currentRPSpan='2y';_renderContextBar();}"));
  assert.ok(OPTIONS.includes("visit Ticker tab to reload</div>';_renderContextBar();}"));
});
test('scroll margins cover the taller header: Guide targets 170px (none left at 140px), Patterns card 200px',()=>{
  assert.ok(!INDEX.includes('scroll-margin-top:140px'));
  assert.ok(INDEX.split('scroll-margin-top:170px').length-1>=6);
  assert.ok(PATTERNS.includes('scroll-margin-top:200px')&&!PATTERNS.includes('scroll-margin-top:170px'));
});
test('Build 556 bookkeeping: sw build >= 556, Release Notes v4.4.8 above v4.4.7',()=>{
  const sw=src('sw.js'); assert.ok(Number(sw.match(/const APP_BUILD = (\d+)/)[1])>=556);
  assert.strictEqual(sw.match(/income-engine-v(\d+)/)[1],sw.match(/const APP_BUILD = (\d+)/)[1]);
  const i8=INDEX.indexOf('\nv4.4.8 -- 2026-11-'),i7=INDEX.indexOf('\nv4.4.7 -- 2026-11-');
  assert.ok(i8>0&&i8<i7); assert.ok(INDEX.indexOf('Service worker: v556')>0);
});

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
