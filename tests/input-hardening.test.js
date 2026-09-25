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
function section(name){ console.log('\n== '+name+' =='); }

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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
