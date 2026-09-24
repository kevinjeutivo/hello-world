#!/usr/bin/env node
'use strict';
// tests/gap-fill.test.js -- deterministic tests for the gap-fill
// fixed-horizon fix (js/helpers.js, js/dashboard.js).
//
// Confirmed bug: the old fillRate/avgDaysToFill statistics suffered from
// right-censoring in two directions at once:
//   - fillRate pooled EVERY gap regardless of age -- a gap from
//     yesterday (no fair chance to fill yet) counted as a "failure"
//     exactly like a gap from 18 months ago that genuinely never filled.
//     This drags the reported rate down whenever there happen to be
//     several recent unresolved gaps.
//   - avgDaysToFill averaged only over FILLED gaps, silently excluding
//     every still-open gap -- including the longest-running ones -- which
//     drags the average the OTHER direction (looks faster than reality).
//
// The fix: report fixed-horizon outcomes (same day / 5d / 20d / 60d /
// still open past 60d), each computed only over gaps old enough
// (daysSince >= horizon) to have actually been fully observable at that
// horizon. No averaging, no pooling across different-aged observations.
//
// Runs the actual shipped js/helpers.js source in a Node vm context.
//
// Usage: node tests/gap-fill.test.js

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

// ── Synthetic OHLC generator ────────────────────────────────────────────
// Builds n flat trading days, then plants gap-up events at chosen
// indices. Each planted gap's new price level PROPAGATES FORWARD to
// every subsequent day (until the next plant), so no unintended second
// gap appears on the following day from reverting to a stale baseline.
function buildSyntheticHist(n,plants){
  let opens=[],highs=[],lows=[],closes=[];
  let px=100;
  for(let i=0;i<n;i++){opens.push(px);highs.push(px+0.05);lows.push(px-0.05);closes.push(px);}
  plants.forEach(({dayIdx,fillAfterDays,pct})=>{
    const prevClose=closes[dayIdx-1];
    const gapOpen=prevClose*(1+pct/100);
    for(let j=dayIdx;j<n;j++){opens[j]=gapOpen;highs[j]=gapOpen+0.05;lows[j]=gapOpen-0.05;closes[j]=gapOpen;}
    if(fillAfterDays===0){
      lows[dayIdx]=prevClose-0.1;
    }else if(fillAfterDays!=null){
      const fillDay=dayIdx+fillAfterDays;
      lows[fillDay]=Math.min(lows[fillDay],prevClose-0.1);
    }
  });
  return{opens,highs,lows,closes};
}

// The controlled scenario used throughout this file -- 200 trading days,
// with:
//   - 3 OLD, fully-resolved gaps: same-day fill, 3-day fill, 10-day fill
//     (all >=119 trading days old as of the end of the series -- long
//     since eligible for every horizon)
//   - 1 OLD gap that NEVER filled (also >=119 days old -- eligible for
//     every horizon, correctly counts as "still open" everywhere)
//   - 2 VERY RECENT unfilled gaps (1 and 0 days old) -- too young to be
//     judged against any horizon beyond same-day
// Hand-verified event list (see PR discussion): exactly 6 gap-up events,
// daysToFill/daysSince as commented below.
function scenarioHist(){
  return buildSyntheticHist(200,[
    {dayIdx:20,fillAfterDays:0,pct:5},   // daysSince=179, filled day 0
    {dayIdx:40,fillAfterDays:3,pct:5},   // daysSince=159, filled day 3
    {dayIdx:60,fillAfterDays:10,pct:5},  // daysSince=139, filled day 10
    {dayIdx:80,fillAfterDays:null,pct:5},// daysSince=119, NEVER filled
    {dayIdx:198,fillAfterDays:null,pct:5}, // daysSince=1, unfilled (too young)
    {dayIdx:199,fillAfterDays:null,pct:5}, // daysSince=0, unfilled (too young)
  ]);
}

// ============================================================================
section('Scenario sanity');

test('the constructed scenario produces exactly the 6 gap-up events expected, with no stray secondary gaps', ()=>{
  const ctx=buildContext();
  const events=run(ctx,'_computeGapEvents')('TEST',scenarioHist());
  assert.strictEqual(events.length,6);
  assert(events.every(e=>e.direction==='up'));
  const byDaysSince=[...events.map(e=>e.daysSince)].sort((a,b)=>b-a);
  assert.deepStrictEqual(byDaysSince,[179,159,139,119,1,0]);
});

// ============================================================================
section('Fixed-horizon stats (right-censoring fix)');

test('sameDay horizon: eligible=ALL 6 gaps (any gap can be judged same-day immediately), only 1 actually filled same-day', ()=>{
  const ctx=buildContext();
  const stat=run(ctx,'_gapHorizonStat')(run(ctx,'_computeGapEvents')('TEST',scenarioHist()),0);
  assert.strictEqual(stat.eligible,6);
  assert.strictEqual(stat.filledCount,1);
  assert(Math.abs(stat.filledPct-(1/6*100))<1e-9);
});

test('within5 horizon: the two very-recent gaps are correctly EXCLUDED (too young), eligible=4, filled=2', ()=>{
  const ctx=buildContext();
  const stat=run(ctx,'_gapHorizonStat')(run(ctx,'_computeGapEvents')('TEST',scenarioHist()),5);
  assert.strictEqual(stat.eligible,4,'the two 0-1 day old gaps must not count toward this horizon at all');
  assert.strictEqual(stat.filledCount,2,'only the same-day and 3-day fills clear a 5-day horizon; the 10-day fill does not');
  assert(Math.abs(stat.filledPct-50)<1e-9);
});

test('within20 horizon: eligible=4 (same as within5 -- no gap is between 5 and 20 days old here), filled=3', ()=>{
  const ctx=buildContext();
  const stat=run(ctx,'_gapHorizonStat')(run(ctx,'_computeGapEvents')('TEST',scenarioHist()),20);
  assert.strictEqual(stat.eligible,4);
  assert.strictEqual(stat.filledCount,3,'the 10-day fill now clears a 20-day horizon too');
  assert(Math.abs(stat.filledPct-75)<1e-9);
});

test('within60 horizon: eligible=4, filled=3, and the never-filled OLD gap correctly shows as "still open" (25%) -- not silently dropped', ()=>{
  const ctx=buildContext();
  const stat=run(ctx,'_gapHorizonStat')(run(ctx,'_computeGapEvents')('TEST',scenarioHist()),60);
  assert.strictEqual(stat.eligible,4);
  assert.strictEqual(stat.filledCount,3);
  assert.strictEqual(stat.openCount,1);
  assert(Math.abs(stat.openPct-25)<1e-9);
});

test('a horizon with zero eligible gaps returns nulls, not a divide-by-zero or a misleading 0%', ()=>{
  const ctx=buildContext();
  // Every gap in this tiny scenario is brand new -- none old enough for
  // a 60-day horizon.
  const hist=buildSyntheticHist(3,[{dayIdx:2,fillAfterDays:null,pct:5}]);
  const stat=run(ctx,'_gapHorizonStat')(run(ctx,'_computeGapEvents')('TEST',hist),60);
  assert.strictEqual(stat.eligible,0);
  assert.strictEqual(stat.filledPct,null);
});

// ============================================================================
section('Negative control: the naive pooled fillRate is genuinely biased on this exact scenario');

test('reconstructing the OLD naive formula on this exact scenario gives a DIFFERENT, misleadingly low number compared to the honest within-20 reading', ()=>{
  const ctx=buildContext();
  const events=run(ctx,'_computeGapEvents')('TEST',scenarioHist());
  // Old formula: filled/total across EVERY gap regardless of age.
  const naiveFillRate=events.filter(e=>e.filled).length/events.length*100;
  assert(Math.abs(naiveFillRate-50)<1e-9,'sanity: reconstructed naive formula matches the hand-computed 50%');
  const within20=run(ctx,'_gapHorizonStat')(events,20);
  assert(Math.abs(within20.filledPct-75)<1e-9);
  assert(naiveFillRate<within20.filledPct-20,'the naive pooled number must read meaningfully LOWER than the fair within-20 reading -- confirms the two recent too-young gaps were dragging it down');
});

test('adding MORE very-recent unfilled gaps keeps dragging the naive rate down further, while the within-20 reading stays exactly the same (the two recent gaps are still correctly excluded from its eligible set either way)', ()=>{
  const ctx=buildContext();
  const hist=buildSyntheticHist(210,[
    {dayIdx:20,fillAfterDays:0,pct:5},
    {dayIdx:40,fillAfterDays:3,pct:5},
    {dayIdx:60,fillAfterDays:10,pct:5},
    {dayIdx:80,fillAfterDays:null,pct:5},
    // 5 more brand-new unfilled gaps piled on at the very end, each 2
    // trading days apart so they register as distinct gap events.
    {dayIdx:200,fillAfterDays:null,pct:5},
    {dayIdx:202,fillAfterDays:null,pct:5},
    {dayIdx:204,fillAfterDays:null,pct:5},
    {dayIdx:206,fillAfterDays:null,pct:5},
    {dayIdx:208,fillAfterDays:null,pct:5},
  ]);
  const events=run(ctx,'_computeGapEvents')('TEST',hist);
  const naiveFillRate=events.filter(e=>e.filled).length/events.length*100;
  assert(Math.abs(naiveFillRate-(3/9*100))<1e-9,'sanity: 3 filled of 9 total events');
  const within20=run(ctx,'_gapHorizonStat')(events,20);
  assert(naiveFillRate<50,'piling on more recent unfilled gaps should keep pulling the naive rate down further than the earlier 6-gap scenario\'s 50%');
  assert(Math.abs(within20.filledPct-75)<1e-9,'the within-20 reading must be UNCHANGED -- none of the new gaps are old enough to be in its eligible set, so they correctly have zero effect on it');
});

// ============================================================================
section('End-to-end: _computeGapSummaryForTicker and _computeGapAggregate expose the fixed structure');

test('_computeGapSummaryForTicker returns the horizons structure with the hand-verified numbers for the "up" direction', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('hist2y_TEST',${JSON.stringify(scenarioHist())})`);
  const result=run(ctx,'_computeGapSummaryForTicker')('TEST');
  assert(result);
  assert.strictEqual(result.up.count,6);
  assert.strictEqual(result.up.filledCount,3);
  assert(Math.abs(result.up.horizons.within20.filledPct-75)<1e-9);
  assert.strictEqual(result.up.horizons.within60.openCount,1);
  assert(!('fillRate' in result.up),'the old biased field must be gone, not left dangling alongside the fix');
  assert(!('avgDaysToFill' in result.up));
});

test('_computeGapAggregate pools across tickers and exposes the same structure', ()=>{
  const ctx=buildContext();
  run(ctx,`S.set('hist2y_A',${JSON.stringify(scenarioHist())})`);
  run(ctx,`S.set('hist2y_B',${JSON.stringify(scenarioHist())})`);
  const agg=run(ctx,'_computeGapAggregate')(['A','B']);
  assert.strictEqual(agg.tickersWithData,2);
  assert.strictEqual(agg.up.count,12,'2 tickers x 6 events each');
  assert(Math.abs(agg.up.horizons.within20.filledPct-75)<1e-9,'pooling two identical tickers should not change the percentage, only the sample size');
  assert.strictEqual(agg.up.horizons.within20.eligible,8,'2 tickers x 4 eligible each');
});

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
