#!/usr/bin/env node
'use strict';
// tests/bb-span-sync.test.js -- regression coverage for the build-526 fix:
// the Ticker tab's Bollinger Band span buttons (1M/3M/6M/1Y/2Y) used to be
// hardcoded in renderTickerContent's HTML template -- "6M" was always drawn
// as the active button regardless of what span the chart was actually using.
// Separately, currentBBSpan's cold-boot default (index.html) was '2y', while
// every place in the app that *resets* it (loadTicker's ticker-switch branch,
// watchlist.js's ticker-switch branch) resets it to '6m'. On a cold app start
// that lands on the Dashboard and then navigates straight to the Ticker tab
// for the last-viewed ticker, neither reset branch runs (currentTicker is
// already set from last_ticker before loadTicker ever sees a "different"
// ticker), so the chart silently rendered 2 years of data under a button row
// that still showed "6M" as selected.
//
// This is a lightweight sanity check, not a full render test -- fully
// exercising renderTickerContent requires a complete snap/history/earnings
// payload and a DOM, which is disproportionate to what this specific
// regression needs. Instead this confirms, directly against the real source
// text: (1) the old hardcoded-opacity pattern is gone, (2) all 5 buttons now
// read the same currentBBSpan comparison toggleBBSpan itself uses, and
// (3) every place that sets or defaults currentBBSpan agrees on '6m'.
//
// Usage: node tests/bb-span-sync.test.js

const fs=require('fs');
const path=require('path');
const assert=require('assert');

const ROOT=path.join(__dirname,'..');
const tickerSrc=fs.readFileSync(path.join(ROOT,'js/ticker.js'),'utf8');
const watchlistSrc=fs.readFileSync(path.join(ROOT,'js/watchlist.js'),'utf8');
const indexSrc=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');

let pass=0,fail=0;
function test(name,fn){
  try{fn();pass++;console.log('  ok -- '+name);}
  catch(e){fail++;console.error('  FAIL -- '+name+'\n    '+e.message);}
}

test('the BB-span button row no longer contains the old hardcoded opacity literals',()=>{
  // Pre-fix: four buttons sat at a bare opacity:0.4 with no ${...} around
  // it, and the 6M button had no opacity override at all. Confirm both
  // dead patterns are gone.
  assert(!/opacity:0\.4"\s*id="bb-btn-/.test(tickerSrc),
    'at least one bb-btn- button still has a bare, non-dynamic opacity:0.4 literal');
  assert(!/padding:2px 8px"\s*id="bb-btn-6m"/.test(tickerSrc),
    'bb-btn-6m still has no opacity style at all -- looks hardcoded to always-active');
});

test('all 5 BB-span buttons use the same currentBBSpan comparison toggleBBSpan itself relies on',()=>{
  for(const span of['1m','3m','6m','1y','2y']){
    const needle=`opacity:\${(currentBBSpan||'6m')==='${span}'?'1':'0.4'}" id="bb-btn-${span}"`;
    assert(tickerSrc.includes(needle),
      `bb-btn-${span} is not using the expected dynamic (currentBBSpan||'6m')==='${span}' opacity expression`);
  }
});

test("every place that sets or defaults currentBBSpan to a literal agrees on '6m'",()=>{
  // Collect every `currentBBSpan='...'` literal assignment (not the
  // parameter-driven `currentBBSpan=span;` inside toggleBBSpan itself,
  // which legitimately varies by design and has no quotes to match here)
  // across every file that touches it, and confirm they all agree -- this
  // is exactly what the earlier '2y' vs '6m' drift looked like.
  const assignRe=/currentBBSpan\s*=\s*'([^']+)'/g;
  const found=new Set();
  for(const src of[tickerSrc,watchlistSrc,indexSrc]){
    let m;
    while((m=assignRe.exec(src))) found.add(m[1]);
  }
  assert.deepStrictEqual([...found].sort(),['6m'],
    'currentBBSpan is assigned more than one distinct literal value across ticker.js/watchlist.js/index.html: '+[...found].join(', '));
});

console.log(pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
