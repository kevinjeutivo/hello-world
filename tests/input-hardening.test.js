#!/usr/bin/env node
'use strict';
// tests/input-hardening.test.js -- deterministic tests for a focused
// input-boundary security/correctness review: several places accepted
// essentially any input (a ticker string, an account name/id
// interpolated into HTML, a FOMC meeting date, various numeric fields)
// without validating it, letting malformed or malicious input reach
// HTML rendering, inline onclick handlers, or downstream calculations
// unguarded.
//
// This file tests the three new shared helpers directly (js/helpers.js):
//   - normalizeTicker: central ticker validator, used at every point a
//     raw string can become a watchlist ticker.
//   - _isValidISODate: real-calendar-date check (not JS's lenient
//     Date parsing, which silently rolls e.g. 2026-02-30 into March).
//   - finiteNumber: rejects NaN/Infinity/out-of-range, unlike a bare
//     `parseFloat(...)||fallback`, which doesn't catch Infinity at all
//     (Infinity is truthy, so `Infinity||fallback` evaluates to Infinity).
//
// Runs the actual shipped source in a Node vm context.
//
// Usage: node tests/input-hardening.test.js

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
  return ctx;
}
function run(ctx,expr){ return vm.runInContext(expr,ctx); }

let pass=0,fail=0;
function test(name,fn){
  try{ fn(); pass++; console.log('  ok  --',name); }
  catch(e){ fail++; console.log('FAIL  --',name); console.log('      '+(e && e.stack ? e.stack.split('\n').slice(0,3).join('\n      ') : e)); }
}
const _asyncTests=[];
let _currentSection=null;
function asyncTest(name,fn){ _asyncTests.push({name,fn,section:_currentSection}); }
function section(name){ _currentSection=name; console.log('\n== '+name+' =='); }

// ============================================================================
section('normalizeTicker');

test('accepts an ordinary equity ticker, uppercasing it', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'normalizeTicker')('aapl'),'AAPL');
});

test('accepts a hyphenated ticker (BRK-B) and a dotted one (BF.B)', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'normalizeTicker')('brk-b'),'BRK-B');
  assert.strictEqual(run(ctx,'normalizeTicker')('bf.b'),'BF.B');
});

test('accepts a caret-prefixed index symbol (^GSPC)', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'normalizeTicker')('^gspc'),'^GSPC');
});

test('rejects a string containing HTML markup', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'normalizeTicker')('<script>alert(1)</script>'),null);
});

test("rejects a string containing a quote (breaks out of an attribute or onclick's JS string)", ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'normalizeTicker')("AAPL');alert(1);//"),null);
});

test('rejects an empty or whitespace-only string', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'normalizeTicker')(''),null);
  assert.strictEqual(run(ctx,'normalizeTicker')('   '),null);
});

test('rejects a string longer than 15 characters', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'normalizeTicker')('A'.repeat(16)),null);
  assert.strictEqual(run(ctx,'normalizeTicker')('A'.repeat(15)),'A'.repeat(15));
});

test('rejects null/undefined without throwing', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'normalizeTicker')(null),null);
  assert.strictEqual(run(ctx,'normalizeTicker')(undefined),null);
});

// ============================================================================
section('_isValidISODate');

test('accepts an ordinary real date', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'_isValidISODate')('2026-09-16'),true);
});

test('rejects February 30 -- confirms this does NOT silently roll forward like new Date(...) does', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'_isValidISODate')('2026-02-30'),false);
});

test('negative control: reconstructing the OLD check (!isNaN(new Date(...))) on this exact input DOES accept it -- confirms the bug was real', ()=>{
  const oldCheckPasses=!isNaN(new Date('2026-02-30'+'T12:00:00Z').getTime());
  assert.strictEqual(oldCheckPasses,true,'the old formula really did accept an impossible date by silently rolling it into March');
});

test('correctly handles a leap-year February 29', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'_isValidISODate')('2028-02-29'),true); // 2028 is a leap year
  assert.strictEqual(run(ctx,'_isValidISODate')('2026-02-29'),false); // 2026 is not
});

test('rejects a month outside 1-12', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'_isValidISODate')('2026-13-01'),false);
  assert.strictEqual(run(ctx,'_isValidISODate')('2026-00-01'),false);
});

test('rejects a malformed shape entirely', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'_isValidISODate')('not-a-date'),false);
  assert.strictEqual(run(ctx,'_isValidISODate')('2026-9-16'),false); // must be zero-padded
});

// ============================================================================
section('finiteNumber');

test('accepts an ordinary in-range value', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'finiteNumber')('42',{min:0,max:100,fallback:0}),42);
});

test('rejects Infinity -- confirms this catches what a bare `value||fallback` check does not', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'finiteNumber')('Infinity',{min:0,max:100,fallback:12}),12);
  assert.strictEqual(run(ctx,'finiteNumber')(Infinity,{min:0,max:100,fallback:12}),12);
});

test('negative control: a bare `parseFloat(...)||fallback` check does NOT catch Infinity -- confirms the bug was real', ()=>{
  const oldResult=parseFloat('Infinity')||12;
  assert.strictEqual(oldResult,Infinity,'the old pattern really did let Infinity through, since Infinity is truthy');
});

test('rejects a value above the max', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'finiteNumber')('99999999999',{min:0,max:1e9,fallback:0}),0);
});

test('rejects a negative value when min is 0', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'finiteNumber')('-5',{min:0,max:100,fallback:0}),0);
});

test('rejects NaN (a non-numeric string)', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'finiteNumber')('not a number',{min:0,max:100,fallback:7}),7);
});

test('defaults to null fallback and unbounded range when no options are given', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'finiteNumber')('42'),42);
  assert.strictEqual(run(ctx,'finiteNumber')('not a number'),null);
});

test('a value exactly at the boundary is accepted (inclusive range)', ()=>{
  const ctx=buildContext();
  assert.strictEqual(run(ctx,'finiteNumber')('100',{min:0,max:100,fallback:0}),100);
  assert.strictEqual(run(ctx,'finiteNumber')('0',{min:0,max:100,fallback:-1}),0);
});

// ============================================================================
section('Regression: backup-import preview must escape everything, even before the user confirms');

function makeDomStub(){
  const els={};
  function el(id){if(!els[id])els[id]={id,value:'',innerHTML:'',style:{},disabled:false};return els[id];}
  return{getElementById:id=>el(id),_els:els};
}
function buildSettingsContext(){
  const dom=makeDomStub();
  const ctx=vm.createContext({console,localStorage:makeLocalStorage(),window:{},toast:()=>{},document:dom,tzPref:'local',Intl});
  const src=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
  vm.runInContext(src('js/storage.js'),ctx,{filename:'js/storage.js'});
  vm.runInContext(src('js/helpers.js'),ctx,{filename:'js/helpers.js'});
  vm.runInContext(src('js/settings.js'),ctx,{filename:'js/settings.js'});
  return{ctx,dom};
}

test('direct reproduction: a malicious watchlist ticker in an imported backup is escaped in the preview, not rendered as live markup', ()=>{
  const{ctx,dom}=buildSettingsContext();
  const backup={keys:{watchlist:['<img src=x onerror=alert(1)>','AAPL']}};
  dom._els['import-textarea']={value:JSON.stringify(backup)};
  run(ctx,'previewImport')();
  const html=dom._els['import-preview'].innerHTML;
  assert(!html.includes('<img src=x'),'the raw payload must never appear as live markup in the preview');
  assert(html.includes('&lt;img src=x onerror=alert(1)&gt;'),'must appear as inert, escaped text instead');
});

test('a malicious account name in an imported backup is escaped in the per-account preview section', ()=>{
  const{ctx,dom}=buildSettingsContext();
  const backup={keys:{
    income_accounts_meta:[{id:'acct_1',name:'"><script>alert(1)</script>'}],
    'income_acct_1_put_positions':[],
    'income_acct_1_cc_positions':[],
    'income_acct_1_inputs':{},
  }};
  dom._els['import-textarea']={value:JSON.stringify(backup)};
  run(ctx,'previewImport')();
  const html=dom._els['import-preview'].innerHTML;
  assert(!html.includes('<script>alert(1)</script>'),'the raw payload must never appear as live markup');
  assert(html.includes('&lt;script&gt;'),'must appear as inert, escaped text instead');
});

test('a malicious ticker in an imported put position is escaped', ()=>{
  const{ctx,dom}=buildSettingsContext();
  const backup={keys:{put_positions:[{ticker:'"><img src=x onerror=alert(1)>',strike:100,expDate:'2026-10-16',contracts:1}]}};
  dom._els['import-textarea']={value:JSON.stringify(backup)};
  run(ctx,'previewImport')();
  const html=dom._els['import-preview'].innerHTML;
  assert(!html.includes('<img src=x'));
  assert(html.includes('&lt;img'));
});

test('a malicious watchlist-note ticker key and note text are both escaped', ()=>{
  const{ctx,dom}=buildSettingsContext();
  const backup={keys:{'watchlist_note_<script>x</script>':'also <b>bad</b> content'}};
  dom._els['import-textarea']={value:JSON.stringify(backup)};
  run(ctx,'previewImport')();
  const html=dom._els['import-preview'].innerHTML;
  assert(!html.includes('<script>x</script>'));
  assert(!html.includes('<b>bad</b>'));
  assert(html.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert(html.includes('&lt;b&gt;bad&lt;/b&gt;'));
});

test('ordinary, well-formed backup data still previews correctly and readably -- this fix only changes how unsafe content is handled', ()=>{
  const{ctx,dom}=buildSettingsContext();
  const backup={keys:{watchlist:['AAPL','MSFT','VOO']}};
  dom._els['import-textarea']={value:JSON.stringify(backup)};
  run(ctx,'previewImport')();
  const html=dom._els['import-preview'].innerHTML;
  assert(html.includes('AAPL, MSFT, VOO'));
  assert(html.includes('WATCHLIST (3 tickers)'));
});

// ============================================================================
section('Regression: yahooHistory must validate array existence and normalize unequal lengths');

function buildApiContext(fetchImpl){
  const ctx=vm.createContext({
    console,
    fetch:fetchImpl,
    WORKER_URL:'https://worker.example',
    offlineMode:false,
    window:{},
  });
  const src=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
  vm.runInContext(src('js/api.js'),ctx,{filename:'js/api.js'});
  return ctx;
}
function jsonResponse(body){
  return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(body)});
}

asyncTest('a response missing the quote array throws a clear, specific error instead of an unrelated TypeError several lines later', async()=>{
  const ctx=buildApiContext(()=>jsonResponse({chart:{result:[{timestamp:[1,2,3],indicators:{}}]}}));
  await assert.rejects(
    run(ctx,'yahooHistory')('TEST'),
    /Malformed history response/,
    'must fail with a clear, catchable error naming the actual problem'
  );
});

asyncTest('a response missing the timestamp array entirely also throws the clear error', async()=>{
  const ctx=buildApiContext(()=>jsonResponse({chart:{result:[{indicators:{quote:[{close:[1,2,3]}]}}]}}));
  await assert.rejects(run(ctx,'yahooHistory')('TEST'),/Malformed history response/);
});

asyncTest('mismatched array lengths are normalized to the shorter length, rather than left misaligned', async()=>{
  const ctx=buildApiContext(()=>jsonResponse({chart:{result:[{
    timestamp:[100,200,300,400,500], // 5 entries
    indicators:{quote:[{close:[10,11,12],open:[9,10,11],high:[10.5,11.5,12.5],low:[9.5,10.5,11.5],volume:[1000,1100,1200]}]}, // only 3 entries
  }]}}));
  const result=await run(ctx,'yahooHistory')('TEST');
  assert.strictEqual(result.timestamps.length,3,'must truncate to the SHORTER array, not leave a 5-vs-3 mismatch');
  assert.strictEqual(result.closes.length,3);
  assert.deepStrictEqual([...result.closes],[10,11,12]);
});

asyncTest('a well-formed, already-aligned response is completely unaffected by this fix', async()=>{
  const ctx=buildApiContext(()=>jsonResponse({chart:{result:[{
    timestamp:[100,200,300],
    indicators:{quote:[{close:[10,11,12],open:[9,10,11],high:[10.5,11.5,12.5],low:[9.5,10.5,11.5],volume:[1000,1100,1200]}],adjclose:[{adjclose:[10,11,12]}]},
  }]}}));
  const result=await run(ctx,'yahooHistory')('TEST');
  assert.strictEqual(result.timestamps.length,3);
  assert.deepStrictEqual([...result.closes],[10,11,12]);
  assert.deepStrictEqual([...result.adjcloses],[10,11,12]);
});

// ============================================================================
section('Regression: _validateOptionsData must catch basic per-field garbage, not just synthetic PATTERNS');

function buildOptionsContext(){
  const ctx=vm.createContext({console});
  vm.runInContext(fs.readFileSync(path.join(ROOT,'js/options.js'),'utf8'),ctx,{filename:'js/options.js'});
  return ctx;
}
function normalContract(strike,overrides){
  return Object.assign({strike,bid:1.2,ask:1.4,impliedVolatility:0.35,openInterest:150},overrides||{});
}
function chainWith(contracts){
  return{optionChain:{result:[{options:[{puts:contracts,calls:[]}]}]}};
}

test('a normal, well-formed chain is valid', ()=>{
  const ctx=buildOptionsContext();
  const contracts=[normalContract(90),normalContract(95),normalContract(100),normalContract(105),normalContract(110)];
  const result=run(ctx,'_validateOptionsData')(chainWith(contracts));
  assert.strictEqual(result.valid,true);
});

test('a chain where most strikes are non-positive or non-finite is rejected', ()=>{
  const ctx=buildOptionsContext();
  const contracts=[normalContract(0),normalContract(-5),normalContract(NaN),normalContract(100),normalContract(105)];
  const result=run(ctx,'_validateOptionsData')(chainWith(contracts));
  assert.strictEqual(result.valid,false);
  assert(/strike/.test(result.reason));
});

test('a FEW bad strikes within an otherwise-normal chain do NOT trip the check -- matches the ratio-based tolerance of the existing synthetic-pattern checks', ()=>{
  const ctx=buildOptionsContext();
  const contracts=[normalContract(0),normalContract(90),normalContract(95),normalContract(100),normalContract(105),normalContract(110),normalContract(115),normalContract(120)];
  const result=run(ctx,'_validateOptionsData')(chainWith(contracts));
  assert.strictEqual(result.valid,true,'one bad strike out of eight (12.5%) is below the 20% threshold');
});

test('a chain where most contracts have non-finite bid/ask/IV is rejected', ()=>{
  const ctx=buildOptionsContext();
  const contracts=[
    normalContract(90,{bid:NaN}),normalContract(95,{ask:Infinity}),normalContract(100,{impliedVolatility:NaN}),
    normalContract(105),normalContract(110),
  ];
  const result=run(ctx,'_validateOptionsData')(chainWith(contracts));
  assert.strictEqual(result.valid,false);
  assert(/non-finite/.test(result.reason));
});

test('a chain where most contracts show implausibly extreme IV is rejected', ()=>{
  const ctx=buildOptionsContext();
  const contracts=[
    normalContract(90,{impliedVolatility:50}),normalContract(95,{impliedVolatility:99}),normalContract(100,{impliedVolatility:1000}),
    normalContract(105),normalContract(110),
  ];
  const result=run(ctx,'_validateOptionsData')(chainWith(contracts));
  assert.strictEqual(result.valid,false);
  assert(/extreme IV/.test(result.reason));
});

test('genuinely high but real-world-plausible IV (e.g. a volatile small-cap around 150%) does not trip the extreme-IV check', ()=>{
  const ctx=buildOptionsContext();
  const contracts=[normalContract(90,{impliedVolatility:1.5}),normalContract(95,{impliedVolatility:1.8}),normalContract(100,{impliedVolatility:1.6}),normalContract(105),normalContract(110)];
  const result=run(ctx,'_validateOptionsData')(chainWith(contracts));
  assert.strictEqual(result.valid,true);
});

test('the existing synthetic-IV-pattern check still works exactly as before -- this is a pure addition, not a replacement', ()=>{
  const ctx=buildOptionsContext();
  const contracts=[
    normalContract(90,{impliedVolatility:0.5}),normalContract(95,{impliedVolatility:0.25}),normalContract(100,{impliedVolatility:0.125}),
    normalContract(105,{impliedVolatility:0.0625}),normalContract(110,{impliedVolatility:0.03125}),
  ];
  const result=run(ctx,'_validateOptionsData')(chainWith(contracts));
  assert.strictEqual(result.valid,false);
  assert(/synthetic data/.test(result.reason));
});

// ============================================================================
section('Regression: Worker parameter allowlisting (ticker/range/interval/modules, Finnhub path)');

// Strips the `export default { fetch(...) {...} };` ES-module wrapper so
// the plain function declarations after it can run in a vm context --
// same approach as tests/fedwatch.test.js's own worker harness.
function buildWorkerContext(fetchImpl){
  const raw=fs.readFileSync(path.join(ROOT,'cloudflare-proxy/worker.js'),'utf8');
  const stripped=raw.replace(/^export default \{[\s\S]*?\n\};\n/m,'');
  if(stripped===raw)throw new Error('failed to strip the export-default wrapper -- worker.js structure may have changed');
  const ctx=vm.createContext({console,fetch:fetchImpl,Response});
  vm.runInContext(stripped,ctx,{filename:'cloudflare-proxy/worker.js (export wrapper stripped for testing)'});
  return ctx;
}

test('_validateYahooRequestParams accepts a normal, well-formed request', ()=>{
  const ctx=buildWorkerContext();
  assert.strictEqual(run(ctx,'_validateYahooRequestParams')('history','AAPL','1y','1d','financialData'),null);
});

test('rejects a ticker containing HTML/quote characters', ()=>{
  const ctx=buildWorkerContext();
  assert(run(ctx,'_validateYahooRequestParams')('history',"AAPL');alert(1);//",'1y','1d','financialData'));
});

test('rejects an unrecognized range value', ()=>{
  const ctx=buildWorkerContext();
  assert(run(ctx,'_validateYahooRequestParams')('history','AAPL','malicious','1d','financialData'));
});

test('rejects an unrecognized interval value', ()=>{
  const ctx=buildWorkerContext();
  assert(run(ctx,'_validateYahooRequestParams')('history','AAPL','1y','malicious','financialData'));
});

test('rejects an unrecognized quoteSummary module', ()=>{
  const ctx=buildWorkerContext();
  assert(run(ctx,'_validateYahooRequestParams')('summary','AAPL','1y','1d','someRandomModule'));
});

test('accepts every module combination this app actually sends', ()=>{
  const ctx=buildWorkerContext();
  const fn=run(ctx,'_validateYahooRequestParams');
  assert.strictEqual(fn('summary','AAPL','1y','1d','financialData,defaultKeyStatistics,earningsTrend,recommendationTrend,earningsHistory,assetProfile'),null);
  assert.strictEqual(fn('summary','AAPL','1y','1d','topHoldings'),null);
  assert.strictEqual(fn('summary','AAPL','1y','1d','quoteType'),null);
  assert.strictEqual(fn('summary','AAPL','1y','1d','summaryDetail'),null);
});

test('modules is not checked at all for non-summary request types', ()=>{
  const ctx=buildWorkerContext();
  assert.strictEqual(run(ctx,'_validateYahooRequestParams')('history','AAPL','1y','1d','whatever-junk'),null);
});

test('accepts every ticker shape this app actually sends, including indices and hyphenated/dotted tickers', ()=>{
  const ctx=buildWorkerContext();
  const fn=run(ctx,'_validateYahooRequestParams');
  ['AAPL','^GSPC','^VIX','BRK-B','BF.B','SPY'].forEach(t=>{
    assert.strictEqual(fn('history',t,'1y','1d','financialData'),null,t+' should be accepted');
  });
});

asyncTest('handleFinnhubProxy accepts every path prefix this app actually calls', async()=>{
  const ctx=buildWorkerContext(()=>Promise.resolve({ok:true,json:()=>Promise.resolve({})}));
  const paths=[
    '/calendar/earnings?symbol=AAPL&from=2026-01-01&to=2026-02-01',
    '/stock/upgrade-downgrade?symbol=AAPL&from=2026-01-01',
    '/news?category=general',
    '/company-news?symbol=AAPL&from=2026-01-01&to=2026-02-01',
  ];
  for(const p of paths){
    const url=new URL('https://worker.example/?type=finnhub&path='+encodeURIComponent(p));
    const resp=await run(ctx,'handleFinnhubProxy')(url,{FINNHUB_KEY:'test-key'});
    assert.strictEqual(resp.status,200,p+' should be allowed');
  }
});

asyncTest('handleFinnhubProxy rejects a path outside the allowlist', async()=>{
  const ctx=buildWorkerContext(()=>Promise.resolve({ok:true,json:()=>Promise.resolve({})}));
  const url=new URL('https://worker.example/?type=finnhub&path='+encodeURIComponent('/stock/insider-transactions?symbol=AAPL'));
  const resp=await run(ctx,'handleFinnhubProxy')(url,{FINNHUB_KEY:'test-key'});
  assert.strictEqual(resp.status,400);
  const body=await resp.json();
  assert.strictEqual(body.error,'path not allowed');
});

test('negative control: reconstructing the OLD handleFinnhubProxy (no allowlist check) on this exact path WOULD have forwarded it -- confirms the bug was real', ()=>{
  // Reconstructed independently: the pre-fix logic only checked that
  // `path` was present at all, with no allowlist.
  const path='/stock/insider-transactions?symbol=AAPL';
  const oldWouldForward=!!path; // the entire old validation
  assert.strictEqual(oldWouldForward,true,'the old code really would have forwarded any non-empty path -- confirms the gap was real');
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
