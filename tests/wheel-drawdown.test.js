#!/usr/bin/env node
'use strict';
// tests/wheel-drawdown.test.js -- deterministic test for the wheel
// backtest's "max drawdown" fix.
//
// Confirmed bug: the daily drawdown metric was computed as cumulative $
// P&L divided by the RUNNING TIME-WEIGHTED AVERAGE capital deployed so
// far -- and that average denominator moves as the cash/shares regime
// mix changes over a window (e.g. an assignment moving into a
// higher-priced share regime raises the average). That can make the
// ratio fall even when actual dollar equity hasn't moved, which then
// gets counted as "drawdown" even though nothing was actually lost.
//
// The fix adds a second series (maxDrawdownEquityPct) that normalizes
// the exact same dollar P&L by a FIXED capital base instead -- a
// standard Drawdown_t=(Peak-Equity_t)/Peak reading that can't have that
// artifact, because its denominator never moves.
//
// This test extracts the actual `_ddPoint` closure VERBATIM from the
// shipped js/wheelbacktest.js source (via brace-matched text extraction,
// not a hand-retyped reimplementation -- see
// income-engine-working-practices.md Sec.1) and drives it directly with
// a constructed sequence that reproduces the reviewer's exact scenario:
// a capital-base jump with no actual equity loss.
//
// A full end-to-end test driving _simulateWheelWindow's real strike-
// selection/options-pricing engine into a specific assignment scenario
// is a separate, larger undertaking (the review's own "no wheel
// regression-test file" finding covers that -- see the priority list;
// this test validates the drawdown FORMULA fix specifically, not the
// whole simulator).
//
// Usage: node tests/wheel-drawdown.test.js

const fs=require('fs');
const path=require('path');
const vm=require('vm');
const assert=require('assert');

const ROOT=path.join(__dirname,'..');

// Extracts the `_ddPoint` arrow function's exact source text from the
// shipped file, via brace matching starting at its `const _ddPoint=`
// declaration through the closing `};` of its body.
function extractDdPointSource(){
  const src=fs.readFileSync(path.join(ROOT,'js/wheelbacktest.js'),'utf8');
  const startMarker='const _ddPoint=(idx,pct,dollarPnL,capBase)=>{';
  const start=src.indexOf(startMarker);
  if(start<0)throw new Error('could not locate _ddPoint in js/wheelbacktest.js -- source structure may have changed');
  let depth=0,i=start;
  for(;i<src.length;i++){
    if(src[i]==='{')depth++;
    else if(src[i]==='}'){depth--;if(depth===0){i++;break;}}
  }
  // Consume the trailing `;` after the closing brace, if present.
  if(src[i]===';')i++;
  return src.slice(start,i);
}

function buildDdPointHarness(){
  const ctx=vm.createContext({console});
  // The extracted closure reads/writes these as free variables from its
  // enclosing scope in the real file -- declare them here the same way.
  vm.runInContext('let ddPeak=0,ddMax=0,eqFixedCap=null,peakEquity=null,eqDDMax=0,dailyCurve=null;',ctx);
  vm.runInContext(extractDdPointSource(),ctx);
  return ctx;
}

let pass=0,fail=0;
function test(name,fn){
  try{ fn(); pass++; console.log('  ok  --',name); }
  catch(e){ fail++; console.log('FAIL  --',name); console.log('      '+(e && e.stack ? e.stack.split('\n').slice(0,3).join('\n      ') : e)); }
}
function section(name){ console.log('\n== '+name+' =='); }

// ============================================================================
section('Extraction sanity');

test('the _ddPoint source was actually found and is non-trivial (guards against a silent no-op if the file structure changes)', ()=>{
  const src=extractDdPointSource();
  assert(src.length>200);
  assert(src.includes('eqFixedCap'));
  assert(src.includes('ddMax'));
});

// ============================================================================
section('Reviewer\'s exact scenario: a capital-base jump with NO actual equity loss');

test('a rising capital base alone (eq flat or rising) must NOT register as equity drawdown, even though it DOES register on the old capital-relative metric', ()=>{
  const ctx=buildDdPointHarness();
  const ddPoint=vm.runInContext('_ddPoint',ctx);
  // Day 1-10: cash regime, capital base = $10,000 (e.g. a $100 strike,
  // 100 shares). $ P&L climbs steadily from premium collected.
  for(let day=1;day<=10;day++){
    ddPoint(day,(day*50)/10000*100,day*50,10000);
  }
  // Day 11: assignment -- regime switches to shares at a MUCH higher
  // price point. The running TIME-WEIGHTED AVERAGE capital base jumps
  // hard (this is the exact mechanism the review flagged), even though
  // dollar equity is UNCHANGED from day 10 (no loss actually occurred).
  const eqAtDay10=10*50; // $500, matches the loop above
  ddPoint(11,eqAtDay10/40000*100,eqAtDay10,40000); // same $500, but now read against a $40,000 base
  // Days 12-15: equity continues climbing from there (shares gaining value).
  for(let day=12;day<=15;day++){
    const eq=eqAtDay10+(day-11)*200;
    ddPoint(day,eq/40000*100,eq,40000);
  }
  const ddMax=vm.runInContext('ddMax',ctx);
  const eqDDMax=vm.runInContext('eqDDMax',ctx);
  assert(ddMax>0,'sanity: the OLD capital-relative metric SHOULD show a drawdown here -- that is exactly the bug being fixed, confirm it still reproduces');
  assert.strictEqual(eqDDMax,0,'the NEW equity-based metric must show ZERO drawdown -- dollar equity never fell on any day in this sequence');
});

test('a GENUINE equity decline (eq actually falls, no prior gain) registers identically on both metrics', ()=>{
  const ctx=buildDdPointHarness();
  const ddPoint=vm.runInContext('_ddPoint',ctx);
  // No gain before the decline -- peak equity never rises above the
  // fixed starting capital, so the two metrics necessarily agree here
  // (this is the one case where they SHOULD match; see the dedicated
  // peak-equity test below for the case where they must NOT).
  ddPoint(1,0,0,10000);      // equity=10000=starting capital, no move yet
  ddPoint(2,-5,-500,10000);  // equity drops to 9500 -- a real $500 loss
  ddPoint(3,-3,-300,10000);  // partial recovery to 9700
  const ddMax=vm.runInContext('ddMax',ctx);
  const eqDDMax=vm.runInContext('eqDDMax',ctx);
  assert(Math.abs(ddMax-5)<1e-9,'peak 0% to trough -5% = 5pp drawdown on the capital-relative metric');
  assert(Math.abs(eqDDMax-5)<1e-9,'(10000-9500)/10000 = 5% on the equity-based metric -- same here since peak equity never exceeded starting capital');
});

test("reviewer's exact worked example: equity $100 -> $200 -> $150 is a 25% drawdown from PEAK equity, not 50% of starting capital", ()=>{
  const ctx=buildDdPointHarness();
  const ddPoint=vm.runInContext('_ddPoint',ctx);
  // Expressed as dollarPnL relative to a $100 starting capital: $100 of
  // starting capital => equity path 100 -> 200 -> 150 means
  // dollarPnL path 0 -> 100 -> 50.
  ddPoint(1,0,0,100);
  ddPoint(2,100,100,100);  // equity=200, new peak
  ddPoint(3,50,50,100);    // equity=150 -- decline from the $200 peak, not from the $100 starting point
  const eqDDMax=vm.runInContext('eqDDMax',ctx);
  assert(Math.abs(eqDDMax-25)<1e-9,'(200-150)/200 = 25%, the standard maximum-drawdown reading for this path');
});

test('negative control: the earlier (build 504) formula -- normalizing by fixed STARTING capital instead of running peak equity -- gives the wrong 50% on this exact example, confirming the bug was real', ()=>{
  // Reconstructed independently, exactly as the earlier build computed
  // it: eqPct=dollarPnL/eqFixedCap*100, tracked with its own peak/max
  // over that PERCENTAGE series (equivalent to normalizing the decline
  // by the fixed starting capital rather than by peak equity).
  const eqFixedCap=100;
  let eqPeakPct=0,eqDDMaxOld=0;
  [0,100,50].forEach(dollarPnL=>{
    const eqPct=dollarPnL/eqFixedCap*100;
    if(eqPct>eqPeakPct)eqPeakPct=eqPct;
    if(eqPeakPct-eqPct>eqDDMaxOld)eqDDMaxOld=eqPeakPct-eqPct;
  });
  assert(Math.abs(eqDDMaxOld-50)<1e-9,'the old formula really did read this exact path as a 50% drawdown -- confirms the review\'s finding was accurate');
});

test('the fixed capital base is captured from the FIRST call, not recomputed or revised on later calls even as capBase itself keeps changing', ()=>{
  const ctx=buildDdPointHarness();
  const ddPoint=vm.runInContext('_ddPoint',ctx);
  ddPoint(1,10,1000,10000);  // first call establishes eqFixedCap=10000
  ddPoint(2,5,500,99999);    // capBase argument changes wildly -- must be ignored for the fixed base
  const eqFixedCap=vm.runInContext('eqFixedCap',ctx);
  assert.strictEqual(eqFixedCap,10000);
});

// ============================================================================
section('Peak-tracking correctness (both metrics)');

test('drawdown is measured from the running PEAK, not from the starting value -- a decline after a new high is what matters', ()=>{
  const ctx=buildDdPointHarness();
  const ddPoint=vm.runInContext('_ddPoint',ctx);
  ddPoint(1,5,500,10000);
  ddPoint(2,20,2000,10000);  // new peak
  ddPoint(3,12,1200,10000);  // decline from the NEW peak (20->12 = 8pp), not from the start (5->12, which would be a gain)
  const ddMax=vm.runInContext('ddMax',ctx);
  assert(Math.abs(ddMax-8)<1e-9);
});

test('a null or non-finite pct is ignored entirely -- does not reset the peak or register a drawdown', ()=>{
  const ctx=buildDdPointHarness();
  const ddPoint=vm.runInContext('_ddPoint',ctx);
  ddPoint(1,15,1500,10000);
  ddPoint(2,null,null,null);
  ddPoint(3,10,1000,10000);
  const ddMax=vm.runInContext('ddMax',ctx);
  assert(Math.abs(ddMax-5)<1e-9,'the null point must not itself count as a 15-to-0 drawdown');
});

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
