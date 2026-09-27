#!/usr/bin/env node
'use strict';
// tests/options-write-protection.test.js -- coverage for the options-cache
// write decision that survived the build-522/523 cleanup (removal of the
// now-inert _isOptionsLiveWindow/_hasGoodSameDayCache write-branch checks
// and the fully-dead _shouldSkipOptionsFetch()).
//
// Before this cleanup, this exact decision (write fresh / write synthetic
// placeholder / preserve existing cache) had ZERO test coverage anywhere in
// the suite, at any of its 5 call sites across options.js, prefetch.js, and
// ticker.js -- it was only ever verified by inspection. Since it's the real
// mechanism protecting good cached options data from being overwritten by
// bad/empty/programmatic fetch responses, it's worth locking in now that
// the surrounding dead branches are gone.
//
// Scope: this test drives the real _validateOptionsData() (loaded verbatim
// from options.js) and the real slimOptionsData() (loaded verbatim from
// api.js) against the ACTUAL main-chain write-decision block in
// loadOptionsForTicker -- extracted by exact line range, not reimplemented,
// per this project's verification-discipline practice (see
// income-engine-working-practices.md: "extract and test the actual shipped
// code... never a hand-reimplemented stand-in"). The full function itself
// requires a real DOM (options-content, exp-chips, OI chart, etc.) that has
// nothing to do with the write decision, so only the validate/write/preserve
// block is extracted -- the same three-branch shape that's now identical at
// all 5 call sites (options.js x2, prefetch.js x2, ticker.js x1). The other
// 4 call sites are not separately re-tested here since build 522's cleanup
// left every one of them structurally identical to this one, and the sole
// per-call-site difference (log wording / status-flag bookkeeping) is
// outside the scope of this fix.
//
// Usage: node tests/options-write-protection.test.js

const fs=require('fs');
const path=require('path');
const assert=require('assert');

const ROOT=path.join(__dirname,'..');
const optionsSrc=fs.readFileSync(path.join(ROOT,'js/options.js'),'utf8');
const apiSrc=fs.readFileSync(path.join(ROOT,'js/api.js'),'utf8');

// ── Extract _validateOptionsData() verbatim from options.js ────────────────
function extractFunction(src,name){
  const startMatch=src.match(new RegExp('function '+name+'\\('));
  if(!startMatch)throw new Error(name+' not found in source');
  const start=startMatch.index;
  let depth=0,i=start,bodyStart=-1;
  for(;i<src.length;i++){
    if(src[i]==='{'){if(depth===0)bodyStart=i;depth++;}
    else if(src[i]==='}'){depth--;if(depth===0)break;}
  }
  if(depth!==0||bodyStart===-1)throw new Error('could not brace-match '+name);
  return src.slice(start,i+1);
}

const validateFnSrc=extractFunction(optionsSrc,'_validateOptionsData');
const slimFnSrc=extractFunction(apiSrc,'slimOptionsData');

// ── Extract the actual main-chain write-decision block verbatim ────────────
// Bounded by the try{ that opens the live fetch and the matching }catch(e){
// that closes it -- see options.js, loadOptionsForTicker.
const blockStart=optionsSrc.indexOf("try{data=await yahooOptionsViaProxy(t);");
if(blockStart===-1)throw new Error('write-decision block start marker not found -- has loadOptionsForTicker changed shape?');
const blockEnd=optionsSrc.indexOf("}catch(e){const cached=S.get('options_'+t);",blockStart);
if(blockEnd===-1)throw new Error('write-decision block end marker not found -- has loadOptionsForTicker changed shape?');
// Slice from just after "try{data=await yahooOptionsViaProxy(t);" (the
// network call itself is replaced by the test's injected `data`) through
// just before the matching "}catch(e){...}".
const rawBlock=optionsSrc.slice(blockStart,blockEnd);
const innerBlock=rawBlock.slice(rawBlock.indexOf('\n')+1); // drop the try{ line itself

// Sanity check: confirm the three branches this test relies on are actually
// present in what got extracted, so a future edit that changes this block's
// shape fails loudly here rather than silently testing nothing.
assert(/if\(_optVal\.valid\)/.test(innerBlock),'expected branch not found: validation-passed write');
assert(/else if\(!S\.get\('options_'\+t\)\)/.test(innerBlock),'expected branch not found: no-prior-cache synthetic write');
assert(/else\{/.test(innerBlock),'expected branch not found: preserve-existing-cache fallback');
assert(!/_isOptionsLiveWindow|_hasGoodSameDayCache/.test(innerBlock),'the extracted block still references removed window/same-day checks -- cleanup incomplete or this test is stale');

// ── Build a runnable harness around the extracted block ────────────────────
function makeS(){
  const store=new Map();
  return{
    get:k=>store.has(k)?JSON.parse(JSON.stringify(store.get(k))):null,
    set:(k,v)=>{store.set(k,v);return true;},
  };
}

function runWriteDecision({t,data,existingCache,S}){
  if(existingCache!==undefined)S.set('options_'+t,existingCache);
  const fetchTs='2026-09-27 10:00:00',fetchTsEpoch=1234567890000;
  let isLive=false,_fetchedLive=false,_debugPath='';
  const fn=new Function('t','data','S','fetchTs','fetchTsEpoch','_validateOptionsData','slimOptionsData',
    'let isLive=false,_fetchedLive=false,_debugPath="";\n'+innerBlock+'\nreturn{isLive,_fetchedLive,_debugPath,data};'
  );
  const validateFn=new Function('return '+validateFnSrc)();
  const slimFn=new Function('return '+slimFnSrc)();
  return fn(t,data,S,fetchTs,fetchTsEpoch,validateFn,slimFn);
}

// ── Fixtures ─────────────────────────────────────────────────────────────
function validChainFor(strike){
  const contracts=Array.from({length:6},(_,i)=>({strike:strike+i,bid:1.2,ask:1.4,impliedVolatility:0.35,openInterest:200}));
  return{optionChain:{result:[{underlyingSymbol:'TEST',expirationDates:[1234567890],
    options:[{puts:contracts.slice(0,3),calls:contracts.slice(3)}]}],error:null}};
}
const EMPTY_CHAIN={optionChain:{result:[{underlyingSymbol:'TEST',expirationDates:[],options:[]}],error:null}};

let pass=0,fail=0;
function test(name,fn){
  try{fn();pass++;console.log('  ok -- '+name);}
  catch(e){fail++;console.error('  FAIL -- '+name+'\n    '+e.message);}
}

test('valid fetch always writes fresh, even when a good cache already exists',()=>{
  const S=makeS();
  const oldCache={data:{stale:true},ts:'old',tsEpoch:1,synthetic:false};
  const r=runWriteDecision({t:'AAPL',data:validChainFor(150),existingCache:oldCache,S});
  const written=S.get('options_AAPL');
  assert(written&&!written.synthetic,'expected a fresh, non-synthetic write');
  assert.notStrictEqual(written.data,oldCache.data,'expected the old cached data to be replaced, not kept');
  assert(r.isLive,'isLive should be true when the write actually succeeded');
});

test('invalid fetch with no prior cache writes a synthetic-flagged placeholder',()=>{
  const S=makeS();
  const r=runWriteDecision({t:'ZZZZ',data:EMPTY_CHAIN,S}); // no existingCache set at all
  const written=S.get('options_ZZZZ');
  assert(written&&written.synthetic===true,'expected a synthetic-flagged entry to be written');
  assert(!r.isLive,'isLive must stay false for a synthetic placeholder, not read as live data');
});

test('invalid fetch with a good existing cache preserves it and discards the bad fetch',()=>{
  const S=makeS();
  const goodCache={data:{real:'yesterday-data'},ts:'yesterday',tsEpoch:1,synthetic:false};
  const r=runWriteDecision({t:'MSFT',data:EMPTY_CHAIN,existingCache:goodCache,S});
  const stored=S.get('options_MSFT');
  assert.deepStrictEqual(stored,goodCache,'the existing good cache must be left completely untouched');
  assert.deepStrictEqual(r.data,goodCache.data,'the function should return the preserved cached data, not the bad fetch');
});

test('invalid fetch with an existing SYNTHETIC cache still preserves it rather than looping fresh synthetic writes',()=>{
  const S=makeS();
  const oldSynthetic={data:{placeholder:true},ts:'3 days ago',tsEpoch:1,synthetic:true};
  const r=runWriteDecision({t:'GME',data:EMPTY_CHAIN,existingCache:oldSynthetic,S});
  const stored=S.get('options_GME');
  // Documents current (pre-existing, out of scope for this fix) behavior:
  // a synthetic cache counts as "cache exists" for this specific branch's
  // purposes, so its timestamp is not refreshed on a repeated failure.
  assert.deepStrictEqual(stored,oldSynthetic,'a stale synthetic entry is left untouched, not replaced with a freshly-timestamped one');
});

console.log(pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
