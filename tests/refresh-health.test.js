#!/usr/bin/env node
'use strict';
// tests/refresh-health.test.js -- deterministic test for a real bug: the
// "Last Refresh Health" modal's per-ticker row badge and the top-line
// summary count used two DIFFERENT definitions of "OK".
//
//   Summary (prefetch.js, _coreOk):  snap && hist && finnhub && options===true
//   Row badge (settings.js, before): snap && hist && finnhub   <- options omitted entirely
//
// A ticker whose options data failed (metadata unavailable, or some
// expiration fetches came back with nothing usable) was correctly
// counted as the failure behind a "46/47 tickers fully refreshed"
// summary, while its OWN row still showed a green "OK" badge -- and its
// explanatory detail line (which mentions the options failure) only
// renders when the row ISN'T "OK", so it was suppressed too. The ticker
// that broke was invisible in the one place meant to show which one it was.
//
// Fix: the row badge now uses the exact same check as the summary.
//
// This test drives the ACTUAL shipped openRefreshHealthModal() function
// end-to-end with a minimal DOM stub (not a re-derivation of its logic),
// and inspects the real rendered HTML.
//
// Usage: node tests/refresh-health.test.js

const fs=require('fs');
const path=require('path');
const vm=require('vm');
const assert=require('assert');

const ROOT=path.join(__dirname,'..');

function makeLocalStorage(){
  const store=new Map();
  return{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>{store.set(k,String(v));},removeItem:k=>{store.delete(k);},clear:()=>store.clear()};
}

// Minimal DOM stub -- just enough for openRefreshHealthModal's own usage
// (getElementById, createElement, body.appendChild, classList, innerHTML,
// addEventListener). Elements become findable via getElementById once
// actually appended to body, matching real DOM behavior.
function makeDomStub(){
  const createdElements=[];
  const body={appendChild(el){createdElements.push(el);}};
  function makeClassList(){
    const set=new Set();
    return{add:c=>set.add(c),remove:c=>set.delete(c),contains:c=>set.has(c)};
  }
  return{
    getElementById(id){ return createdElements.find(e=>e.id===id)||null; },
    createElement(){
      return{tagName:'div',className:'',id:'',innerHTML:'',classList:makeClassList(),addEventListener(){}};
    },
    body,
  };
}

function buildContext(){
  const dom=makeDomStub();
  let toastFn=null; // some toast() calls happen; not relevant to this test
  const ctx=vm.createContext({
    console,
    localStorage:makeLocalStorage(),
    window:{},
    toast:(...a)=>{if(toastFn)toastFn(...a);},
    document:dom,
    navigator:{onLine:true},
  });
  const src=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
  vm.runInContext(src('js/storage.js'),ctx,{filename:'js/storage.js'});
  vm.runInContext(src('js/helpers.js'),ctx,{filename:'js/helpers.js'});
  vm.runInContext(src('js/settings.js'),ctx,{filename:'js/settings.js'});
  return ctx;
}
function run(ctx,expr){ return vm.runInContext(expr,ctx); }

let pass=0,fail=0;
function test(name,fn){
  try{ fn(); pass++; console.log('  ok  --',name); }
  catch(e){ fail++; console.log('FAIL  --',name); console.log('      '+(e && e.stack ? e.stack.split('\n').slice(0,3).join('\n      ') : e)); }
}
function section(name){ console.log('\n== '+name+' =='); }

function healthyTicker(){ return{snap:true,hist:true,finnhub:true,options:true}; }

// ============================================================================
section('Regression: row badge must match the summary\'s definition of OK');

test('direct reproduction: a ticker with options:false (metadata unavailable) is counted as the failure in the summary -- and its OWN row must now also show the warning, not a false OK', ()=>{
  const ctx=buildContext();
  const tickers={
    AAPL:healthyTicker(),
    MSFT:healthyTicker(),
    NVDA:{snap:true,hist:true,finnhub:true,options:false}, // the one that actually failed
  };
  run(ctx,`S.set('last_refresh_health',{
    completedTs:'test',elapsedLabel:'1s',
    summary:{total:3,ok:2,failed:['NVDA'],degraded:[]},
    tickers:${JSON.stringify(tickers)}
  })`);
  run(ctx,'openRefreshHealthModal')();
  const html=run(ctx,`document.getElementById('refresh-health-modal').innerHTML`);

  assert(/46\/47|2\/3 tickers fully refreshed/.test(html)||/2\/3/.test(html),'sanity: summary line present with the 2/3 figure');

  // Extract just NVDA's own row block (from "NVDA" to the next ticker
  // name or end) to check ITS badge specifically, not the whole page.
  const nvdaIdx=html.indexOf('>NVDA ');
  assert(nvdaIdx>=0,'NVDA row should be present');
  const nvdaBlock=html.slice(nvdaIdx,nvdaIdx+400);
  assert(!nvdaBlock.includes('&#x2714; OK'),'NVDA must NOT show a green OK checkmark -- its options data failed');
  assert(nvdaBlock.includes('&#x26A0;'),'NVDA must show the warning icon instead');
  assert(/options failed|exp chains/.test(nvdaBlock),'NVDA\'s detail line must actually explain the options failure, not be suppressed');

  const aaplIdx=html.indexOf('>AAPL ');
  const aaplBlock=html.slice(aaplIdx,aaplIdx+400);
  assert(aaplBlock.includes('&#x2714; OK'),'a genuinely fully-healthy ticker should still show OK');
});

test('negative control: reconstructing the OLD row-badge formula (options omitted) on this exact data WOULD have shown NVDA as OK -- confirms the bug was real', ()=>{
  const v={snap:true,hist:true,finnhub:true,options:false};
  const oldCoreOk=v.snap&&v.hist&&v.finnhub; // the pre-fix formula, reconstructed independently
  assert.strictEqual(oldCoreOk,true,'the old formula really did read this ticker as OK, which is exactly the bug');
  const newCoreOk=v.snap&&v.hist&&v.finnhub&&v.options===true; // the fixed formula
  assert.strictEqual(newCoreOk,false,'the fixed formula correctly reads it as not-OK');
});

test('a ticker with a partial exp-chain failure (options:false via fresh+preserved !== total) also shows the warning, with the specific fresh/total counts in its detail line', ()=>{
  const ctx=buildContext();
  const tickers={
    AAPL:healthyTicker(),
    TSLA:{snap:true,hist:true,finnhub:true,options:false,optionsExpDetail:{fresh:1,preserved:0,total:3}},
  };
  run(ctx,`S.set('last_refresh_health',{
    completedTs:'test',elapsedLabel:'1s',
    summary:{total:2,ok:1,failed:['TSLA'],degraded:[]},
    tickers:${JSON.stringify(tickers)}
  })`);
  run(ctx,'openRefreshHealthModal')();
  const html=run(ctx,`document.getElementById('refresh-health-modal').innerHTML`);
  const tslaIdx=html.indexOf('>TSLA ');
  const tslaBlock=html.slice(tslaIdx,tslaIdx+400);
  assert(!tslaBlock.includes('&#x2714; OK'));
  assert(tslaBlock.includes('1/3 exp chains'),'the detail line should surface the specific fresh/total count, not just a generic failure message');
});

test('a ticker whose options metadata was simply never attempted (options undefined -- e.g. main fetch itself was unavailable) also correctly shows as not-OK, not a crash', ()=>{
  const ctx=buildContext();
  const tickers={
    AAPL:healthyTicker(),
    GME:{snap:true,hist:true,finnhub:true}, // options key entirely absent
  };
  run(ctx,`S.set('last_refresh_health',{
    completedTs:'test',elapsedLabel:'1s',
    summary:{total:2,ok:1,failed:['GME'],degraded:[]},
    tickers:${JSON.stringify(tickers)}
  })`);
  assert.doesNotThrow(()=>{ run(ctx,'openRefreshHealthModal')(); });
  const html=run(ctx,`document.getElementById('refresh-health-modal').innerHTML`);
  const gmeIdx=html.indexOf('>GME ');
  const gmeBlock=html.slice(gmeIdx,gmeIdx+400);
  assert(!gmeBlock.includes('&#x2714; OK'));
});

test('a fully healthy set of tickers (all snap/hist/finnhub/options true) shows every row as OK, matching an allOk summary', ()=>{
  const ctx=buildContext();
  const tickers={AAPL:healthyTicker(),MSFT:healthyTicker(),GOOGL:healthyTicker()};
  run(ctx,`S.set('last_refresh_health',{
    completedTs:'test',elapsedLabel:'1s',
    summary:{total:3,ok:3,failed:[],degraded:[]},
    tickers:${JSON.stringify(tickers)}
  })`);
  run(ctx,'openRefreshHealthModal')();
  const html=run(ctx,`document.getElementById('refresh-health-modal').innerHTML`);
  ['AAPL','MSFT','GOOGL'].forEach(t=>{
    const idx=html.indexOf('>'+t+' ');
    const block=html.slice(idx,idx+400);
    assert(block.includes('&#x2714; OK'),t+' should show OK');
  });
  assert(!html.includes('id="retry-failed-btn"'),'no retry button when everything is fully healthy');
});

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
