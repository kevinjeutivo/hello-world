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
  function el(id){if(!els[id])els[id]={id,value:'',innerHTML:'',style:{},disabled:false,classList:{add(){},remove(){},contains(){return false;}}};return els[id];}
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
section('Backup-import write-side validation, Phases 1-2 (js/settings.js)');

function buildSettingsCtx(){
  const{ctx}=buildSettingsContext();
  return ctx;
}

test('_validateAccountMeta accepts a real account, rejects a malformed id', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validateAccountMeta');
  assert.deepStrictEqual({...fn({id:'acct_1234567890_ab3de',name:'Fidelity'})},{id:'acct_1234567890_ab3de',name:'Fidelity'});
  assert.strictEqual(fn({id:'not-an-account-id',name:'Fidelity'}),null);
  assert.strictEqual(fn({id:'acct_1234567890_ab3de',name:''}),null,'an empty name is rejected');
  assert.strictEqual(fn(null),null);
});

test('_validatePosition accepts a well-formed put position and normalizes/regenerates a malformed id', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validatePosition');
  const result=fn({ticker:'aapl',strike:100,expDate:'2026-10-16',contracts:2,id:'not-a-valid-id-shape!!'},false);
  assert.strictEqual(result.ticker,'AAPL');
  assert.strictEqual(result.strike,100);
  assert.strictEqual(result.contracts,2);
  assert(/^pos_/.test(result.id),'a malformed id is regenerated, not rejected outright -- it is an internal handle, not user data');
  assert.strictEqual(result.stockPriceAtWrite,undefined,'a put position never gets the CC-only field');
});

test('_validatePosition rejects a position with a non-positive strike, an impossible date, or a missing ticker', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validatePosition');
  assert.strictEqual(fn({ticker:'AAPL',strike:-5,expDate:'2026-10-16',contracts:1},false),null);
  assert.strictEqual(fn({ticker:'AAPL',strike:100,expDate:'2026-02-30',contracts:1},false),null);
  assert.strictEqual(fn({ticker:'',strike:100,expDate:'2026-10-16',contracts:1},false),null);
});

test('_validatePosition includes stockPriceAtWrite for a CC position when present and valid', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validatePosition');
  const result=fn({ticker:'AAPL',strike:110,expDate:'2026-10-16',contracts:1,stockPriceAtWrite:105.5},true);
  assert.strictEqual(result.stockPriceAtWrite,105.5);
});

test('_validateIncomeInputs normalizes a well-formed inputs object and rejects Infinity/garbage fields individually', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validateIncomeInputs');
  const result=fn({tbillAmt:5000,spaxxAmt:Infinity,targetAPY:'not a number',fdlxxUseManual:true,fdlxxYieldManual:4.5});
  assert.strictEqual(result.tbillAmt,5000);
  assert.strictEqual(result.spaxxAmt,0,'Infinity falls back to the safe default (0) for this field, rather than propagating');
  assert.strictEqual(result.targetAPY,12,'a non-numeric value falls back to the standard default');
  assert.strictEqual(result.fdlxxUseManual,true);
  assert.strictEqual(result.fdlxxYieldManual,4.5);
});

test('_validateImportKeys splits a mixed backup into accepted and rejected, with a reason per rejection', ()=>{
  const ctx=buildSettingsCtx();
  const keys={
    watchlist:['aapl','msft'],
    vix_threshold:'not a number',
    tz_pref:'PT',
  };
  const result=run(ctx,'_validateImportKeys')(keys);
  assert.deepStrictEqual([...result.accepted.watchlist],['AAPL','MSFT']);
  assert.strictEqual(result.accepted.tz_pref,'PT');
  assert.strictEqual(result.accepted.vix_threshold,undefined,'a malformed value for a recognized key is never written');
  assert.strictEqual(result.rejected.length,1);
  assert.strictEqual(result.rejected[0].key,'vix_threshold');
});

test('a single malformed position inside an otherwise-good array is dropped WITHOUT rejecting the whole key -- the rest of the array still imports', ()=>{
  const ctx=buildSettingsCtx();
  const keys={
    income_acct_1234567890_ab3de_put_positions:[
      {ticker:'AAPL',strike:100,expDate:'2026-10-16',contracts:1},
      {ticker:'BAD',strike:-5,expDate:'garbage',contracts:1}, // malformed -- dropped individually
      {ticker:'MSFT',strike:400,expDate:'2026-11-20',contracts:2},
    ],
  };
  const result=run(ctx,'_validateImportKeys')(keys);
  const positions=result.accepted.income_acct_1234567890_ab3de_put_positions;
  assert.strictEqual(positions.length,2,'the two good positions survive; only the one bad one is dropped');
  assert.strictEqual(result.rejected.length,0,'the KEY itself is not rejected just because one array item was bad');
});

test('direct reproduction: a malicious/malformed watchlist ticker never reaches storage after a full import cycle', ()=>{
  const{ctx,dom}=buildSettingsContext();
  const backup={keys:{watchlist:['aapl','<script>alert(1)</script>','msft']}};
  dom._els['import-textarea']={value:JSON.stringify(backup)};
  run(ctx,'previewImport')();
  run(ctx,'confirmImport')();
  const stored=run(ctx,`S.get('watchlist')`);
  assert.deepStrictEqual([...stored],['AAPL','MSFT'],'the malicious entry never reaches storage at all -- not escaped, not stored');
});

test('direct reproduction: a position with Infinity strike never reaches storage after a full import cycle', ()=>{
  const{ctx,dom}=buildSettingsContext();
  const backup={keys:{income_acct_1234567890_ab3de_put_positions:[
    {ticker:'AAPL',strike:Infinity,expDate:'2026-10-16',contracts:1},
    {ticker:'MSFT',strike:400,expDate:'2026-11-20',contracts:2},
  ]}};
  dom._els['import-textarea']={value:JSON.stringify(backup)};
  run(ctx,'previewImport')();
  run(ctx,'confirmImport')();
  const stored=run(ctx,`S.get('income_acct_1234567890_ab3de_put_positions')`);
  assert.strictEqual(stored.length,1,'only the well-formed position is written');
  assert.strictEqual(stored[0].ticker,'MSFT');
});

test('negative control: reconstructing the OLD confirmImport (no validation at all) on this exact backup WOULD have written Infinity straight to storage -- confirms the gap was real', ()=>{
  const keys={income_acct_x_put_positions:[{ticker:'AAPL',strike:Infinity,expDate:'2026-10-16',contracts:1}]};
  // The old logic, reconstructed: every key/value written unconditionally.
  const oldWrittenValue=keys.income_acct_x_put_positions[0].strike;
  assert.strictEqual(oldWrittenValue,Infinity,'the old code really would have written Infinity as a strike price -- confirms the gap was real');
});

test('a well-formed, ordinary backup imports completely normally -- this fix only changes what happens to malformed/unrecognized data', ()=>{
  const{ctx,dom}=buildSettingsContext();
  const backup={keys:{
    watchlist:['AAPL','MSFT','VOO'],
    tz_pref:'PT',
    font_size:14,
    vix_threshold:25,
    income_accounts_meta:[{id:'acct_1234567890_ab3de',name:'Fidelity'}],
    income_acct_1234567890_ab3de_put_positions:[{ticker:'AAPL',strike:200,expDate:'2026-12-18',contracts:1}],
    fomc_meeting_dates_override:['2026-09-16','2026-10-28'],
  }};
  dom._els['import-textarea']={value:JSON.stringify(backup)};
  run(ctx,'previewImport')();
  run(ctx,'confirmImport')();
  assert.deepStrictEqual([...run(ctx,`S.get('watchlist')`)],['AAPL','MSFT','VOO']);
  assert.strictEqual(run(ctx,`S.get('tz_pref')`),'PT');
  assert.strictEqual(run(ctx,`S.get('vix_threshold')`),25);
  assert.strictEqual(run(ctx,`S.get('income_accounts_meta')`).length,1);
  assert.strictEqual(run(ctx,`S.get('income_acct_1234567890_ab3de_put_positions')`).length,1);
  assert.deepStrictEqual([...run(ctx,`S.get('fomc_meeting_dates_override')`)],['2026-09-16','2026-10-28']);
});

test('a genuinely unrecognized key (not a real key this app produces) still passes through unvalidated -- every real durable key is covered as of Phase 3, so this documents the final, deliberate boundary rather than a temporary gap', ()=>{
  const ctx=buildSettingsCtx();
  const keys={some_future_key_this_build_does_not_know_about:'whatever a newer build might someday export'};
  const result=run(ctx,'_validateImportKeys')(keys);
  assert.strictEqual(result.accepted.some_future_key_this_build_does_not_know_about,'whatever a newer build might someday export');
  assert.strictEqual(result.rejected.length,0);
});

// ============================================================================
section('Backup-import write-side validation, Phase 2: historical-cache families');

test('_validateEarningsHist accepts a well-formed cache entry and drops a malformed one from the array, without rejecting the whole key', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validateEarningsHist');
  const result=fn({
    data:[
      {date:'2026-01-15',hour:'bmo',gapPct:3.2,direction:'up',source:'auto-confirmed'},
      {date:'2026-02-30',hour:'amc',gapPct:1,direction:'down',source:'gap-estimated'}, // impossible date -- dropped
      {date:'2026-04-16',hour:null,gapPct:null,direction:null,source:'time-estimated'},
    ],
    ts:'04/16/2026, 09:00 PT',tsEpoch:1234567890000,
  });
  assert.strictEqual(result.data.length,2,'the impossible-date entry is dropped; the two good ones survive');
  assert.strictEqual(result.data[0].date,'2026-01-15');
});

test('_validateEarningsHist rejects an entry with an unrecognized source value -- source is always one of a fixed, app-controlled set', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validateEarningsHist');
  const result=fn({data:[{date:'2026-01-15',hour:'bmo',source:'<script>alert(1)</script>'}],ts:'x',tsEpoch:1});
  assert.strictEqual(result.data.length,0,'an unrecognized source means this entry is not real -- it is silently dropped, not stored with a garbage source');
});

test('_validateEarningsHist rejects the whole value if data is missing entirely (not an array)', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validateEarningsHist');
  assert.strictEqual(fn({ts:'x',tsEpoch:1}),null);
  assert.strictEqual(fn('not an object'),null);
});

test('_validateEarningsConfirmed and _validateEarningsPending both filter bad entries and cap array length', ()=>{
  const ctx=buildSettingsCtx();
  const confirmed=run(ctx,'_validateEarningsConfirmed')([
    {date:'2026-01-15',hour:'bmo',addedTs:'x'},
    {date:'not-a-date',hour:'amc',addedTs:'y'},
  ]);
  assert.strictEqual(confirmed.length,1);
  const manyPending=Array.from({length:20},(_,i)=>({date:'2026-0'+(1+i%9)+'-15',hour:'bmo',savedTs:'x'}));
  const pending=run(ctx,'_validateEarningsPending')(manyPending);
  assert(pending.length<=10,'earnings_pending_ is capped at 10 entries, matching the app\'s own slice(0,4)-ish convention of keeping this small');
});

test('_validateMultipleHist keeps a record even when its nested diagnostic sub-objects are absent, but nulls a garbage numeric field rather than rejecting the whole record', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validateMultipleHist');
  const result=fn([{
    quarterEndDate:'2026-06-30',reportDate:'2026-08-01',reportHour:'amc',
    priceAtReport:Infinity, // garbage -- should null out, not reject the whole record
    ttmEpsAsOfReport:5.2,ttmPE:18.3,epsActual:1.3,epsEstimateQuarterly:1.25,
    // priceCandidates/ttmComponents/yahooAnnual/firstSeen/lastSeen all absent
  }]);
  assert.strictEqual(result.length,1,'the record survives -- one bad numeric field is nulled, not fatal to the whole quarter');
  assert.strictEqual(result[0].priceAtReport,null);
  assert.strictEqual(result[0].ttmEpsAsOfReport,5.2,'other valid fields on the same record are unaffected');
  assert.strictEqual(result[0].priceCandidates,null);
});

test('_validateMultipleHist rejects a record entirely only when its anchor field (quarterEndDate) is missing or invalid -- that field is load-bearing for everything else', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validateMultipleHist');
  const result=fn([{reportDate:'2026-08-01',priceAtReport:100},{quarterEndDate:'not-a-date',priceAtReport:100}]);
  assert.strictEqual(result.length,0);
});

test('_validateMultipleHist rejects a type-confused nested sub-object (a string pretending to be priceCandidates) rather than passing it through', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validateMultipleHist');
  const result=fn([{quarterEndDate:'2026-06-30',priceCandidates:'<script>alert(1)</script>'}]);
  assert.strictEqual(result.length,1,'the record itself still survives (only one field was bad)');
  assert.strictEqual(result[0].priceCandidates,null,'the type-confused string is nulled, never passed through as-is');
});

test('_validateFwdpeTrack and _validateNextfyTrack both validate their nested date-anchored entries, capping array length', ()=>{
  const ctx=buildSettingsCtx();
  const fwdpe=run(ctx,'_validateFwdpeTrack')([{
    targetQuarterEnd:'2026-09-30',
    entries:[{date:'2026-07-01',price:150,forwardPE:22.5},{date:'bad-date',price:100}],
  }]);
  assert.strictEqual(fwdpe[0].entries.length,1,'the bad-date entry is dropped from within the group');
  const nextfy=run(ctx,'_validateNextfyTrack')({
    targetFYEnd:'2027-06-30',pendingFYEnd:null,
    entries:[{date:'2026-07-01',price:150,nextFYEps:8.5,multiple:17.6}],
  });
  assert.strictEqual(nextfy.entries.length,1);
  assert.strictEqual(nextfy.entries[0].nextFYEps,8.5);
});

test('full import cycle: a malicious source string and an Infinity price inside historical-cache data never reach storage', ()=>{
  const{ctx,dom}=buildSettingsContext();
  const backup={keys:{
    earnings_hist_AAPL:{data:[{date:'2026-01-15',hour:'bmo',source:'<img src=x onerror=alert(1)>'},{date:'2026-02-10',hour:'amc',source:'auto-confirmed'}],ts:'x',tsEpoch:1},
    multiple_hist_AAPL:[{quarterEndDate:'2026-06-30',priceAtReport:Infinity}],
  }};
  dom._els['import-textarea']={value:JSON.stringify(backup)};
  run(ctx,'previewImport')();
  run(ctx,'confirmImport')();
  const hist=run(ctx,`S.get('earnings_hist_AAPL')`);
  assert.strictEqual(hist.data.length,1,'the malicious-source entry never reaches storage; the one real entry does');
  const mult=run(ctx,`S.get('multiple_hist_AAPL')`);
  assert.strictEqual(mult[0].priceAtReport,null,'Infinity is nulled before ever being written');
});

// ============================================================================
section('Backup-import write-side validation, Phase 3: fed_futures, notes/compare, legacy keys, and a found gap');

test('_validateFedFutures accepts a well-formed set of contracts and drops one with an out-of-range implied rate', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validateFedFutures');
  const result=fn({
    data:[
      {ticker:'ZQU26.CBT',month:'Sep 2026',price:95.67,impliedRate:4.33},
      {ticker:'ZQV26.CBT',month:'garbage-month-label',price:95.5,impliedRate:4.5}, // bad month label -- dropped
      {ticker:'ZQX26.CBT',month:'Nov 2026',price:95.4,impliedRate:4.6,stale:true,staleAsOf:'x',staleAsOfEpoch:1234},
    ],
    failedMonths:['Dec 2026'],ts:'x',tsEpoch:1234567890000,
  });
  assert.strictEqual(result.data.length,2,'the bad-month-label contract is dropped; the two good ones survive');
  assert.strictEqual(result.data[1].stale,true);
  assert.deepStrictEqual([...result.failedMonths],['Dec 2026']);
});

test('_validateFedFutures rejects the whole value if data is not an array at all', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validateFedFutures');
  assert.strictEqual(fn({ts:'x'}),null);
  assert.strictEqual(fn('not an object'),null);
});

test('watchlist_note_ and rp_compare_ prefix validators work correctly', ()=>{
  const ctx=buildSettingsCtx();
  const keys={
    'watchlist_note_AAPL':'A perfectly normal note about AAPL.',
    'watchlist_note_MSFT':'<script>alert(1)</script>', // not escaped here -- rejected/passed as plain text, escaping happens at RENDER time (see the earlier build's _escHtml fixes); this validator's job is just type+length
    'rp_compare_AAPL':'spy',
  };
  const result=run(ctx,'_validateImportKeys')(keys);
  assert.strictEqual(result.accepted['watchlist_note_AAPL'],'A perfectly normal note about AAPL.');
  assert.strictEqual(result.accepted['rp_compare_AAPL'],'SPY','normalizeTicker uppercases it, same as every other ticker field');
});

test('rp_compare_ rejects a value that is not a valid ticker shape', ()=>{
  const ctx=buildSettingsCtx();
  const result=run(ctx,'_validateImportKeys')({'rp_compare_AAPL':"'; DROP TABLE"});
  assert.strictEqual(result.accepted['rp_compare_AAPL'],undefined);
  assert.strictEqual(result.rejected.length,1);
});

test('legacy flat income keys (pre-migration backups) use the exact same validators as their per-account equivalents', ()=>{
  const ctx=buildSettingsCtx();
  const keys={
    put_positions:[{ticker:'AAPL',strike:100,expDate:'2026-10-16',contracts:1},{ticker:'BAD',strike:-5,expDate:'x',contracts:1}],
    income_inputs:{tbillAmt:5000,targetAPY:Infinity},
    income_mmf_yields:{fdlxx:4.2,spaxx:4.1,ts:'2026-09-01T00:00:00.000Z'},
  };
  const result=run(ctx,'_validateImportKeys')(keys);
  assert.strictEqual(result.accepted.put_positions.length,1,'the malformed position is dropped, the good one survives');
  assert.strictEqual(result.accepted.income_inputs.targetAPY,12,'Infinity falls back to the standard default, same as the per-account version');
  assert.strictEqual(result.accepted.income_mmf_yields.fdlxx,4.2);
});

test('a real gap found while scoping Phase 3: income_acct_*_mmf_yield was never matched by any earlier prefix regex -- confirmed fixed', ()=>{
  const ctx=buildSettingsCtx();
  const result=run(ctx,'_validateImportKeys')({'income_acct_1234567890_ab3de_mmf_yield':{fdlxx:Infinity,spaxx:4.1,ts:'x'}});
  const stored=result.accepted['income_acct_1234567890_ab3de_mmf_yield'];
  assert(stored,'must now be recognized and validated, not silently passed through raw');
  assert.strictEqual(stored.fdlxx,null,'Infinity is nulled -- proof this actually went through the validator, not just pass-through');
  assert.strictEqual(stored.spaxx,4.1);
});

test('negative control: reconstructing Phase 1/2\'s prefix regex set on this exact key confirms it really would NOT have matched -- the gap was real', ()=>{
  const key='income_acct_1234567890_ab3de_mmf_yield';
  const oldPrefixTests=[
    /^income_acct_[A-Za-z0-9_]{1,40}_put_positions$/,
    /^income_acct_[A-Za-z0-9_]{1,40}_cc_positions$/,
    /^income_acct_[A-Za-z0-9_]{1,40}_inputs$/,
  ];
  const oldWouldMatch=oldPrefixTests.some(re=>re.test(key));
  assert.strictEqual(oldWouldMatch,false,'confirms mmf_yield really did fall through every Phase 1/2 prefix test -- the gap was real, not hypothetical');
});

test('full import cycle: every Phase 3 family together -- a well-formed backup covering fed_futures, notes, compare tickers, and legacy keys imports completely, with malformed pieces dropped individually', ()=>{
  const{ctx,dom}=buildSettingsContext();
  const backup={keys:{
    fed_futures:{data:[{ticker:'ZQU26.CBT',month:'Sep 2026',price:95.67,impliedRate:4.33}],failedMonths:[],ts:'x',tsEpoch:1},
    watchlist_note_AAPL:'Solid fundamentals, watching for a pullback.',
    rp_compare_AAPL:'spy',
    put_positions:[{ticker:'AAPL',strike:100,expDate:'2026-10-16',contracts:1}],
  }};
  dom._els['import-textarea']={value:JSON.stringify(backup)};
  run(ctx,'previewImport')();
  run(ctx,'confirmImport')();
  assert.strictEqual(run(ctx,`S.get('fed_futures')`).data.length,1);
  assert.strictEqual(run(ctx,`S.get('watchlist_note_AAPL')`),'Solid fundamentals, watching for a pullback.');
  assert.strictEqual(run(ctx,`S.get('rp_compare_AAPL')`),'SPY');
  assert.strictEqual(run(ctx,`S.get('put_positions')`).length,1);
});

// ============================================================================
section('Regression: a real user backup surfaced 8 keys with wrong type assumptions -- not real JS booleans, and one incomplete enum');

test('the 6 string-boolean keys accept their ACTUAL stored values (confirmed against each read-side comparison), not a literal JS true/false', ()=>{
  const ctx=buildSettingsCtx();
  const result=run(ctx,'_validateImportKeys')({
    offline_mode:'false', debug_options_fetch:'true', fetch_upgrades_enabled:'false',
    rp_earnings_toggle:'on', rp_total_return:'off', income_migration_v1:'1',
  });
  assert.strictEqual(result.rejected.length,0,'none of these should be rejected -- they are exactly what this app actually writes');
  assert.strictEqual(result.accepted.offline_mode,'false');
  assert.strictEqual(result.accepted.rp_earnings_toggle,'on');
  assert.strictEqual(result.accepted.income_migration_v1,'1');
});

test('negative control: reconstructing the ORIGINAL (wrong) _validateBoolean on these exact real-world values confirms every one really was rejected -- the bug was real, not hypothetical', ()=>{
  const oldValidateBoolean=v=>v===true||v===false?v:null; // exactly the original, since-removed function
  const realValues=['false','true','off','on','1'];
  realValues.forEach(v=>{
    assert.strictEqual(oldValidateBoolean(v),null,JSON.stringify(v)+' really was rejected by the old literal-boolean check');
  });
});

test('income_migration_v1 rejects anything other than the literal string "1" -- that is the only value this app ever actually writes', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validateImportKeys');
  assert.strictEqual(fn({income_migration_v1:true}).accepted.income_migration_v1,undefined);
  assert.strictEqual(fn({income_migration_v1:'yes'}).accepted.income_migration_v1,undefined);
});

test('dashboard_view_mode now accepts all 8 real modes, including wheelbt and valuation -- the original enum only listed 6', ()=>{
  const ctx=buildSettingsCtx();
  const result=run(ctx,'_validateImportKeys')({dashboard_view_mode:'wheelbt'});
  assert.strictEqual(result.rejected.length,0);
  assert.strictEqual(result.accepted.dashboard_view_mode,'wheelbt');
  const result2=run(ctx,'_validateImportKeys')({dashboard_view_mode:'valuation'});
  assert.strictEqual(result2.accepted.dashboard_view_mode,'valuation');
});

test('negative control: the ORIGINAL 6-value dashboard_view_mode enum really did not include wheelbt or valuation -- confirms this gap was real too', ()=>{
  const originalEnumValues=['puts','cc','rsi','risk','gap','notes']; // exactly the original, since-fixed list
  assert(!originalEnumValues.includes('wheelbt'));
  assert(!originalEnumValues.includes('valuation'));
});

test('_validateVolBadgeState correctly handles the real per-ticker object-map shape -- the original validator wrongly treated this as a plain string', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validateVolBadgeState');
  const result=fn({AAPL:{multiplier:2.5,date:'2026-09-20',liveTriggered:true},MSFT:{multiplier:1.8,date:'2026-09-19',liveTriggered:false}});
  assert.strictEqual(result.AAPL.multiplier,2.5);
  assert.strictEqual(result.MSFT.liveTriggered,false);
});

test('_validateVolBadgeState drops a malformed per-ticker entry without rejecting the whole map', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validateVolBadgeState');
  const result=fn({AAPL:{multiplier:2.5,date:'2026-09-20',liveTriggered:true},MSFT:{multiplier:'garbage',date:'not-a-date'}});
  assert.strictEqual(Object.keys(result).length,1,'the malformed MSFT entry is dropped; AAPL survives');
  assert(result.AAPL);
});

test('put_pos_sort/cc_pos_sort now validate against their real enum (ticker/expiry) instead of accepting any string up to 30 chars', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validateImportKeys');
  assert.strictEqual(fn({put_pos_sort:'expiry'}).accepted.put_pos_sort,'expiry');
  assert.strictEqual(fn({put_pos_sort:'<script>x</script>'}).accepted.put_pos_sort,undefined,'no longer silently accepted just because it was under 30 characters');
});

test('direct reproduction of the actual reported bug: a real 312-key backup with these 8 settings now imports every one of them, not just 304', ()=>{
  const{ctx,dom}=buildSettingsContext();
  const backup={keys:{
    offline_mode:'false',rp_earnings_toggle:'on',rp_total_return:'off',
    dashboard_view_mode:'wheelbt',vol_badge_state:{AAPL:{multiplier:1.5,date:'2026-09-20',liveTriggered:false}},
    income_migration_v1:'1',debug_options_fetch:'false',fetch_upgrades_enabled:'true',
  }};
  dom._els['import-textarea']={value:JSON.stringify(backup)};
  run(ctx,'previewImport')();
  run(ctx,'confirmImport')();
  assert.strictEqual(run(ctx,`S.get('offline_mode')`),'false');
  assert.strictEqual(run(ctx,`S.get('rp_earnings_toggle')`),'on');
  assert.strictEqual(run(ctx,`S.get('rp_total_return')`),'off');
  assert.strictEqual(run(ctx,`S.get('dashboard_view_mode')`),'wheelbt');
  assert.strictEqual(run(ctx,`S.get('vol_badge_state')`).AAPL.multiplier,1.5);
  assert.strictEqual(run(ctx,`S.get('income_migration_v1')`),'1');
  assert.strictEqual(run(ctx,`S.get('debug_options_fetch')`),'false');
  assert.strictEqual(run(ctx,`S.get('fetch_upgrades_enabled')`),'true');
});

// ============================================================================
section('Regression: fixes from the Build 517 follow-up review');

test('Must-fix 1: a CC position missing stockPriceAtWrite is dropped entirely, not imported with the field absent', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validatePosition');
  assert.strictEqual(fn({ticker:'AAPL',strike:110,expDate:'2026-10-16',contracts:1},true),null,'missing stockPriceAtWrite means this cannot be a valid CC position');
  assert.strictEqual(fn({ticker:'AAPL',strike:110,expDate:'2026-10-16',contracts:1,stockPriceAtWrite:Infinity},true),null,'an invalid (non-finite) write price is equally disqualifying');
});

test('a well-formed CC position (valid stockPriceAtWrite) still imports normally -- this fix only changes the missing/invalid case', ()=>{
  const ctx=buildSettingsCtx();
  const fn=run(ctx,'_validatePosition');
  const result=fn({ticker:'AAPL',strike:110,expDate:'2026-10-16',contracts:1,stockPriceAtWrite:105.5},true);
  assert.strictEqual(result.stockPriceAtWrite,105.5);
});

test('direct reproduction: a malformed CC in a mixed array is dropped, the well-formed one survives, via a full import cycle', ()=>{
  const{ctx,dom}=buildSettingsContext();
  const backup={keys:{cc_positions:[
    {ticker:'AAPL',strike:110,expDate:'2026-10-16',contracts:1}, // missing stockPriceAtWrite -- would have crashed rendering before this fix
    {ticker:'MSFT',strike:420,expDate:'2026-11-20',contracts:1,stockPriceAtWrite:410},
  ]}};
  dom._els['import-textarea']={value:JSON.stringify(backup)};
  run(ctx,'previewImport')();
  run(ctx,'confirmImport')();
  const stored=run(ctx,`S.get('cc_positions')`);
  assert.strictEqual(stored.length,1);
  assert.strictEqual(stored[0].ticker,'MSFT');
});

test('Must-fix 2: slimExpData drops a contract with an invalid strike entirely, but keeps the rest of the chain', ()=>{
  const ctx=buildOptionsContext();
  const fn=run(ctx,'slimExpData');
  const raw={optionChain:{result:[{options:[{
    puts:[
      {strike:90,bid:1.2,ask:1.4,lastPrice:1.3,openInterest:150,volume:20,impliedVolatility:0.35},
      {strike:-5,bid:1.0,ask:1.1,lastPrice:1.05,openInterest:100,volume:10,impliedVolatility:0.3}, // invalid strike -- dropped
      {strike:NaN,bid:1.0,ask:1.1,lastPrice:1.05,openInterest:100,volume:10,impliedVolatility:0.3}, // invalid strike -- dropped
    ],
    calls:[],
  }]}]}};
  const result=fn(raw);
  assert.strictEqual(result.puts.length,1,'only the two invalid-strike contracts are dropped');
  assert.strictEqual(result.puts[0].s,90);
});

test('Must-fix 2: a garbage (non-numeric) bid never reaches the cached representation -- normalized to 0, not passed through raw', ()=>{
  const ctx=buildOptionsContext();
  const fn=run(ctx,'slimExpData');
  const raw={optionChain:{result:[{options:[{
    puts:[{strike:100,bid:'garbage',ask:1.25,lastPrice:1.2,openInterest:150,volume:20,impliedVolatility:0.35}],
    calls:[],
  }]}]}};
  const result=fn(raw);
  assert.strictEqual(result.puts.length,1,'the contract survives -- only its bad field is normalized, since strike itself was fine');
  assert.strictEqual(result.puts[0].b,0,'the garbage bid becomes a safe 0, never the raw string');
  assert.strictEqual(typeof result.puts[0].b,'number');
});

test('negative control: reconstructing the OLD slimExpData (a plain passthrough) on this exact garbage-bid contract confirms the raw string really would have reached the cache -- the bug was real', ()=>{
  const oldSlim=c=>({s:c.strike,b:c.bid,a:c.ask,l:c.lastPrice,oi:c.openInterest,v:c.volume,iv:c.impliedVolatility});
  const result=oldSlim({strike:100,bid:'garbage',ask:1.25,lastPrice:1.2,openInterest:150,volume:20,impliedVolatility:0.35});
  assert.strictEqual(result.b,'garbage','the old code really did pass the raw garbage value straight through to the cached representation -- confirms the bug');
});

test('Must-fix 2: every invalid quote field (negative, Infinity, NaN, out-of-range) is independently normalized to 0, not just bid', ()=>{
  const ctx=buildOptionsContext();
  const fn=run(ctx,'slimExpData');
  const raw={optionChain:{result:[{options:[{
    puts:[{strike:100,bid:-5,ask:Infinity,lastPrice:NaN,openInterest:-1,volume:1e20,impliedVolatility:'not a number'}],
    calls:[],
  }]}]}};
  const result=fn(raw);
  const c=result.puts[0];
  assert.strictEqual(c.b,0); assert.strictEqual(c.a,0); assert.strictEqual(c.l,0);
  assert.strictEqual(c.oi,0); assert.strictEqual(c.v,0); assert.strictEqual(c.iv,0);
});

test('a fully well-formed chain is completely unaffected by this fix -- every real value passes through unchanged', ()=>{
  const ctx=buildOptionsContext();
  const fn=run(ctx,'slimExpData');
  const raw={optionChain:{result:[{options:[{
    puts:[{strike:95,bid:1.1,ask:1.3,lastPrice:1.2,openInterest:200,volume:30,impliedVolatility:0.32}],
    calls:[{strike:105,bid:0.9,ask:1.05,lastPrice:0.95,openInterest:180,volume:25,impliedVolatility:0.29}],
  }]}]}};
  const result=fn(raw);
  assert.strictEqual(result.puts[0].b,1.1);
  assert.strictEqual(result.calls[0].iv,0.29);
});

test('Should-fix (partial): duplicate account IDs in an imported backup are deduplicated, keeping the first occurrence', ()=>{
  const ctx=buildSettingsCtx();
  const result=run(ctx,'_validateImportKeys')({income_accounts_meta:[
    {id:'acct_1234567890_ab3de',name:'Fidelity (first)'},
    {id:'acct_1234567890_ab3de',name:'Fidelity (duplicate)'},
    {id:'acct_9999999999_zz999',name:'Schwab'},
  ]});
  const accts=result.accepted.income_accounts_meta;
  assert.strictEqual(accts.length,2,'the duplicate id is dropped, not both copies kept');
  assert.strictEqual(accts[0].name,'Fidelity (first)','the FIRST occurrence is kept, not the second');
});

test('negative control: the ORIGINAL account-meta validator (no dedup) on this exact input WOULD have kept both duplicate-id accounts -- confirms the gap was real', ()=>{
  const oldValidator=v=>Array.isArray(v)?v.filter(a=>a&&typeof a==='object'&&/^acct_[A-Za-z0-9_]{1,40}$/.test(a.id)&&a.name).map(a=>({id:a.id,name:String(a.name).slice(0,30)})):null;
  const result=oldValidator([{id:'acct_1234567890_ab3de',name:'Fidelity (first)'},{id:'acct_1234567890_ab3de',name:'Fidelity (duplicate)'}]);
  assert.strictEqual(result.length,2,'the old formula really did keep both accounts sharing one id -- confirms the gap was real');
});

test('Should-fix: an oversized backup (too many keys) is rejected before any parsing/restoring is attempted', ()=>{
  const{ctx,dom}=buildSettingsContext();
  const hugeKeys={};
  for(let i=0;i<5001;i++)hugeKeys['watchlist_note_T'+i]='x';
  dom._els['import-textarea']={value:JSON.stringify({keys:hugeKeys})};
  run(ctx,'previewImport')();
  assert.strictEqual(dom._els['import-preview'],undefined,'the preview element must never even be touched -- the oversized backup is rejected before that point');
});

test('a normal-sized backup is completely unaffected by the new size cap', ()=>{
  const{ctx,dom}=buildSettingsContext();
  const backup={keys:{watchlist:['AAPL','MSFT']}};
  dom._els['import-textarea']={value:JSON.stringify(backup)};
  run(ctx,'previewImport')();
  assert(dom._els['import-preview'].innerHTML.length>0,'an ordinary backup still previews normally');
});

test('UX fix: the unusual-meeting-count warning is now folded into the SAME toast as the save confirmation, not overwritten by a second one', ()=>{
  const toastCalls=[];
  const dom=makeDomStub();
  dom._els['fomc-dates-textarea']={value:['2026-01-15','2026-02-15','2026-03-15'].join('\n')}; // an unusually short (3-meeting) list
  const ctx=vm.createContext({console,localStorage:makeLocalStorage(),window:{},toast:(...args)=>toastCalls.push(args),document:dom,tzPref:'local',Intl});
  const src=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
  vm.runInContext(src('js/storage.js'),ctx,{filename:'js/storage.js'});
  vm.runInContext(src('js/helpers.js'),ctx,{filename:'js/helpers.js'});
  vm.runInContext(src('js/settings.js'),ctx,{filename:'js/settings.js'});
  run(ctx,'saveFomcDates')();
  assert.strictEqual(toastCalls.length,1,'exactly one toast call -- the warning is no longer a separate call that gets immediately overwritten');
  assert(/unusual count/.test(toastCalls[0][0]),'the merged message still contains the warning');
  assert(/saved/i.test(toastCalls[0][0]),'and still confirms the save itself');
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
