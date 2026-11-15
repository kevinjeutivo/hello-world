#!/usr/bin/env node
'use strict';
// tests/total-return-isolation-554.test.js -- build 554.
//
// Bug fixed: the Ticker tab built ONE history object whose .closes were the
// dividend-adjusted series whenever the Relative Performance "Total Return"
// toggle was on, then handed it to everything on the page (52W tiles, IVR
// range, Gap Fill, RSI transition, multiple-history price lines). Mixing
// adjusted closes with raw opens/highs/lows made gap detection invent gaps.
//
// Contract now: hist2y.closes is ALWAYS the actual closes; the adjusted
// series rides along in hist2y.adjcloses; only the Relative Performance code
// applies the toggle, via _rpTickerSeries.
//
// Runs the ACTUAL shipped functions (extracted from js/ticker.js and run in a
// vm with the real storage.js/helpers.js). Usage: node tests/total-return-isolation-554.test.js

const fs=require('fs');
const path=require('path');
const vm=require('vm');
const assert=require('assert');

const ROOT=path.join(__dirname,'..');
const src=p=>fs.readFileSync(path.join(ROOT,p),'utf8');

function makeLocalStorage(){
  const store=new Map();
  return{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>{store.set(k,String(v));},removeItem:k=>{store.delete(k);},clear:()=>store.clear()};
}
const ctx=vm.createContext({console,localStorage:makeLocalStorage(),window:{},toast:()=>{},document:{getElementById:()=>null,addEventListener:()=>{}}});
vm.runInContext(src('js/storage.js'),ctx,{filename:'js/storage.js'});
vm.runInContext(src('js/helpers.js'),ctx,{filename:'js/helpers.js'});

function extractFn(code,name){
  const start=code.indexOf('function '+name+'(');
  if(start<0)throw new Error('cannot find '+name);
  let i=code.indexOf('{',start),depth=0;
  for(;i<code.length;i++){ if(code[i]==='{')depth++; else if(code[i]==='}'){depth--; if(depth===0){i++;break;}} }
  return code.slice(start,i);
}
const tickerSrc=src('js/ticker.js');
for(const fn of ['getRPTotalReturn','_buildTickerHist2y','_rpTickerSeries','_compute52W','_computeEarningsReactionEvents'])
  vm.runInContext(extractFn(tickerSrc,fn),ctx,{filename:'ticker.js:'+fn});

function call(fn,...args){ ctx.__args=args; const r=vm.runInContext(`JSON.stringify(${fn}(...__args))`,ctx); return r===undefined?undefined:JSON.parse(r); }
function raw(fn,...args){ ctx.__args=args; return vm.runInContext(`${fn}(...__args)`,ctx); }
function setTR(on){ vm.runInContext(`S.set('rp_total_return','${on?'on':'off'}')`,ctx); }
function putCache(ticker,obj){ ctx.__h=obj; vm.runInContext(`S.set('hist2y_${ticker}',__h)`,ctx); }

let pass=0,fail=0;
function test(name,fn){
  try{ fn(); pass++; console.log('  ok  --',name); }
  catch(e){ fail++; console.log('FAIL  --',name); console.log('      '+(e&&e.stack?e.stack.split('\n').slice(0,3).join('\n      '):e)); }
}
function section(name){ console.log('\n== '+name+' =='); }

// A dividend-paying stock with NO real gaps: every open equals the actual
// close, so any gap found is a phantom. adj scales older bars down by up to
// ~4% (a ~4%-yield stock over a year), recent bars ~unadjusted.
const N=500;
const rawCloses=[],opens=[],highs=[],lows=[],adj=[];
for(let i=0;i<N;i++){
  const c=Math.round((50+Math.sin(i/15))*100)/100;
  rawCloses.push(c);opens.push(c);highs.push(Math.round((c+0.2)*100)/100);lows.push(Math.round((c-0.2)*100)/100);
  adj.push(Math.round(c*(1-0.04*Math.max(0,(N-1-i)/252))*100)/100);
}
const timestamps=Array.from({length:N},(_,i)=>1735819200+i*86400);
const volumes=Array.from({length:N},(_,i)=>1000+i);
const CACHE={timestamps,closes:rawCloses,adjcloses:adj,volumes,opens,highs,lows};
putCache('DIV',CACHE);

// ============================================================================
section('_buildTickerHist2y: closes are always the actual closes');

test('with Total Return ON, .closes is still the actual closes and .adjcloses is carried',()=>{
  setTR(true);
  const h=raw('_buildTickerHist2y',CACHE);
  assert.deepStrictEqual(Array.from(h.closes),rawCloses);
  assert.deepStrictEqual(Array.from(h.adjcloses),adj);
  assert.strictEqual(Object.prototype.toString.call(h.timestamps[0]),'[object Date]');
  assert.strictEqual(h.timestamps[0].getTime(),timestamps[0]*1000);
  assert.deepStrictEqual(Array.from(h.volumes),volumes,'volumes included (the old live-fetch copy omitted them)');
  assert.ok(h.opens&&h.highs&&h.lows);
});
test('output is identical with the toggle on and off (the toggle is not an input)',()=>{
  setTR(true);  const on=call('_buildTickerHist2y',CACHE);
  setTR(false); const off=call('_buildTickerHist2y',CACHE);
  assert.deepStrictEqual(on,off);
});
test('no adjusted series: adjcloses is null, nothing breaks; bad input returns null',()=>{
  const h=raw('_buildTickerHist2y',{timestamps,closes:rawCloses});
  assert.strictEqual(h.adjcloses,null); assert.strictEqual(h.volumes,null); assert.strictEqual(h.opens,null);
  assert.strictEqual(raw('_buildTickerHist2y',null),null);
  assert.strictEqual(raw('_buildTickerHist2y',{closes:[1,2]}),null);
});

// ============================================================================
section('Consumers outside Relative Performance see identical results with the toggle on or off');

test('Gap detection: 0 phantom gaps with the toggle ON (negative control: adjusted closes invent hundreds)',()=>{
  setTR(true);
  const h=raw('_buildTickerHist2y',CACHE);
  ctx.__h=h;
  const onCount=vm.runInContext('(_computeGapEvents("DIV",__h)||[]).length',ctx);
  assert.strictEqual(onCount,0,'built object must not create gaps');
  // negative control: the pre-fix behavior (adjusted closes + raw opens/highs/lows)
  ctx.__bad={closes:adj,opens,highs,lows};
  const bad=vm.runInContext('(_computeGapEvents("DIV",__bad)||[]).length',ctx);
  assert.ok(bad>100,'negative control: the old swap must produce many phantom gaps, got '+bad);
});
test('52W tiles: high/low equal the actual closing high/low with the toggle ON (negative control: adjusted differs)',()=>{
  setTR(true);
  const h=raw('_buildTickerHist2y',CACHE);
  const last252=rawCloses.slice(-252);
  const tile=call('_compute52W','DIV',h);
  assert.strictEqual(tile.high,Math.max(...last252));
  assert.strictEqual(tile.low,Math.min(...last252));
  const adjTile=call('_compute52W','DIV',{timestamps:h.timestamps,closes:adj});
  assert.notStrictEqual(adjTile.low,tile.low,'negative control: adjusted closes give a different low');
});
test('toggle ON vs OFF give the same 52W tile and the same gap events',()=>{
  setTR(true);  const a=raw('_buildTickerHist2y',CACHE);
  const tileOn=call('_compute52W','DIV',a);
  setTR(false); const b=raw('_buildTickerHist2y',CACHE);
  const tileOff=call('_compute52W','DIV',b);
  assert.deepStrictEqual(tileOn,tileOff);
});

// ============================================================================
section('_rpTickerSeries: the ONE place the toggle is applied');

test('ON + adjusted series -> a view with adjusted closes; the source object is not mutated',()=>{
  setTR(true);
  const h=raw('_buildTickerHist2y',CACHE);
  ctx.__h=h;
  const view=vm.runInContext('_rpTickerSeries(__h)',ctx);
  assert.deepStrictEqual(Array.from(view.closes),adj);
  assert.deepStrictEqual(Array.from(h.closes),rawCloses,'original keeps actual closes');
  assert.notStrictEqual(view,h);
});
test('OFF, no adjusted series, or null input -> unchanged (same object / null)',()=>{
  const h=raw('_buildTickerHist2y',CACHE);
  ctx.__h=h;
  setTR(false); assert.strictEqual(vm.runInContext('_rpTickerSeries(__h)===__h',ctx),true);
  setTR(true);
  const noAdj=raw('_buildTickerHist2y',{timestamps,closes:rawCloses});
  ctx.__n=noAdj; assert.strictEqual(vm.runInContext('_rpTickerSeries(__n)===__n',ctx),true);
  assert.strictEqual(raw('_rpTickerSeries',null),null);
});

// ============================================================================
section('Relative Performance still gets total-return data (hand-computed)');

// 10 consecutive daily bars from 2026-01-05. Event 2026-01-11 (idx 6), after close.
//   actual closes: 100 x7 (idx 0-6), then 104, 104, 104
//   adjusted:       98 x7,           then 104, 104, 104   (older bars scaled down)
// AMC reaction = close[idx7]/close[idx6] - 1:
//   actual: 104/100 - 1 = +4.0%        adjusted: 104/98 - 1 = +6.12244897959...%
// S&P flat, so excess reaction equals the stock reaction.
const rpTs=Array.from({length:10},(_,i)=>Date.UTC(2026,0,5+i,14,30)/1000);
const rpRaw=[100,100,100,100,100,100,100,104,104,104];
const rpAdj=[98,98,98,98,98,98,98,104,104,104];
const RP_CACHE={timestamps:rpTs,closes:rpRaw,adjcloses:rpAdj};
const earn=[{date:'2026-01-11',hour:'amc',epsActual:1.0,epsEstimate:0.9}];
function reaction(useTR){
  setTR(useTR);
  ctx.__rp=raw('_buildTickerHist2y',RP_CACHE);
  // S&P built inside the vm so its Date objects share the context's realm
  ctx.__sp=vm.runInContext(`({timestamps:[${rpTs.map(t=>`new Date(${t*1000})`).join(',')}],closes:Array(10).fill(4000)})`,ctx);
  ctx.__earn=earn;
  const ev=vm.runInContext('_computeEarningsReactionEvents(_rpTickerSeries(__rp),__sp,__earn)',ctx);
  return ev&&ev[0];
}
test('toggle OFF: reaction uses actual closes (+4.0%)',()=>{
  const e=reaction(false);
  assert.ok(e,'an event is produced'); assert.ok(Math.abs(e.reactionPct-4)<1e-9,String(e.reactionPct));
  assert.ok(Math.abs(e.excessReaction-4)<1e-9);
});
test('toggle ON: Relative Performance reaction uses adjusted closes (+6.1224...%)',()=>{
  const e=reaction(true);
  assert.ok(e&&Math.abs(e.reactionPct-(104/98-1)*100)<1e-9,String(e&&e.reactionPct));
});

// ============================================================================
section('Wiring (source-level guards against reintroducing the swap)');

test('both Ticker-tab render paths build hist2y through the shared helper; the old inline swaps are gone',()=>{
  const calls=(tickerSrc.match(/_buildTickerHist2y\(/g)||[]).length;
  assert.strictEqual(calls,3,'1 definition + 2 call sites (live fetch and cache restore), got '+calls);
  assert.ok(!tickerSrc.includes('_tkCl')&&!tickerSrc.includes('_rTkCl'));
});
test('Relative Performance card and chart apply the toggle via _rpTickerSeries',()=>{
  assert.ok(tickerSrc.includes('_computeEarningsPatternSummary(ticker,_rpTickerSeries(hist2y),hist2ySP,effectiveHistory)'));
  assert.ok(tickerSrc.includes('renderRelPerfChart(ticker,_rpTickerSeries(hist2y),hist2ySP,earningsHistory,span||'));
});
test('non-RP consumers still receive the plain hist2y (no TR view)',()=>{
  assert.ok(tickerSrc.includes('_compute52W(snap.ticker,hist2y)'));
  assert.ok(tickerSrc.includes('_rsiTransitionCardHtml(snap.ticker,hist2y)'));
  assert.ok(tickerSrc.includes('_gapFillCardHtml(snap.ticker,hist2y)'));
  assert.ok(!/_(?:compute52W|rsiTransitionCardHtml|gapFillCardHtml)\([^)]*_rpTickerSeries/.test(tickerSrc));
});
test('only these functions may read the adjusted series: the builder, the RP selector, the RP chart paths and the two cache writers',()=>{
  const lines=tickerSrc.split('\n');
  const owners=new Set();
  lines.forEach((l,i)=>{
    if(!l.includes('adjcloses')||/^\s*\/\//.test(l))return;
    for(let j=i;j>=0;j--){const m=lines[j].match(/^(?:async )?function (\w+)/); if(m){owners.add(m[1]);break;}}
  });
  assert.deepStrictEqual([...owners].sort(),
    ['_buildTickerHist2y','_initRelPerfChart','_rpTickerSeries','_triggerRelPerfRedraw','loadTicker','refreshSingleTicker']);
});

// ============================================================================
section('Build bookkeeping');

test('sw.js CACHE_NAME and APP_BUILD are in sync and at least 554',()=>{
  const sw=src('sw.js');
  const name=sw.match(/const CACHE_NAME = 'income-engine-v(\d+)'/)[1];
  const build=sw.match(/const APP_BUILD = (\d+)/)[1];
  assert.strictEqual(name,build); assert.ok(Number(build)>=554);
});
test('Release Notes carry entries for builds 553 and 554 (newest first)',()=>{
  const html=src('index.html');
  const i554=html.indexOf('Service worker: v554'),i553=html.indexOf('Service worker: v553'),i520=html.indexOf('Service worker: v520');
  assert.ok(i554>0&&i553>i554&&i520>i553,'v554 entry, then v553, then the older v520 entry');
  assert.ok(/\nv4\.4\.6 -- 2026-11-15\n/.test(html)&&/\nv4\.4\.5 -- 2026-11-15\n/.test(html));
  assert.ok(html.indexOf('\nv4.4.6 --')<html.indexOf('\nv4.4.5 --')&&html.indexOf('\nv4.4.5 --')<html.indexOf('\nv4.4.4 --'));
});

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
