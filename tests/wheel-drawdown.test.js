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
  vm.runInContext('let ddPeak=0,ddMax=0,eqFixedCap=null,eqPeak=0,eqDDMax=0,dailyCurve=null;',ctx);
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

test('a GENUINE equity decline (eq actually falls) registers correctly on BOTH metrics', ()=>{
  const ctx=buildDdPointHarness();
  const ddPoint=vm.runInContext('_ddPoint',ctx);
  // Fixed capital base throughout (no regime change) -- both metrics
  // should track a real decline identically, since the denominator never
  // moves in this scenario (see the no-regime-change invariant test below
  // for why that's mathematically guaranteed even in the real simulator).
  ddPoint(1,10,1000,10000);   // eq=$1000, peak
  ddPoint(2,5,500,10000);     // eq drops to $500 -- a real $500 decline
  ddPoint(3,7,700,10000);
  const ddMax=vm.runInContext('ddMax',ctx);
  const eqDDMax=vm.runInContext('eqDDMax',ctx);
  assert(Math.abs(ddMax-5)<1e-9,'peak 10% to trough 5% = 5pp drawdown on the capital-relative metric');
  assert(Math.abs(eqDDMax-5)<1e-9,'same 5pp drawdown on the equity-based metric -- fixed base, so they must agree exactly here');
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
