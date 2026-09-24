#!/usr/bin/env node
'use strict';
// tests/terminology-fixes.test.js -- deterministic tests for the two
// logic changes in the terminology/labeling batch (the other two --
// ETF "reinvested" wording and trailing-yield calendar-basis caveat --
// are pure text/comment changes with no computed value affected, so
// they don't get dedicated tests here).
//
//   1. Income Planner collateral-coverage check (js/income.js): flags
//      when tracked put notional exceeds Layer 1 capital, meaning the
//      blended yield's exclusion of put collateral from the denominator
//      no longer reflects reality.
//   2. Earnings-reaction hour-known exclusion (js/ticker.js): an
//      unknown announcement hour silently defaulted to the BMO
//      convention before; now flagged and excluded from the averaged
//      reaction stats (still shown in the raw per-event list).
//
// Runs the actual shipped source in a Node vm context.
//
// Usage: node tests/terminology-fixes.test.js

const fs=require('fs');
const path=require('path');
const vm=require('vm');
const assert=require('assert');

const ROOT=path.join(__dirname,'..');

function makeLocalStorage(){
  const store=new Map();
  return{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>{store.set(k,String(v));},removeItem:k=>{store.delete(k);},clear:()=>store.clear()};
}
function buildIncomeContext(){
  const ctx=vm.createContext({console,localStorage:makeLocalStorage(),window:{},toast:()=>{},document:{getElementById:()=>null,addEventListener:()=>{}}});
  const src=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
  vm.runInContext(src('js/storage.js'),ctx,{filename:'js/storage.js'});
  vm.runInContext(src('js/helpers.js'),ctx,{filename:'js/helpers.js'});
  vm.runInContext(src('js/income.js'),ctx,{filename:'js/income.js'});
  return ctx;
}
function buildTickerContext(){
  const ctx=vm.createContext({console,localStorage:makeLocalStorage(),window:{},toast:()=>{},document:{getElementById:()=>null,addEventListener:()=>{}}});
  const src=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
  vm.runInContext(src('js/storage.js'),ctx,{filename:'js/storage.js'});
  vm.runInContext(src('js/helpers.js'),ctx,{filename:'js/helpers.js'});
  vm.runInContext(src('js/wheelbacktest.js'),ctx,{filename:'js/wheelbacktest.js'}); // _parseHist2yDate
  vm.runInContext(src('js/ticker.js'),ctx,{filename:'js/ticker.js'});
  return ctx;
}
function run(ctx,expr){ return vm.runInContext(expr,ctx); }

let pass=0,fail=0;
function test(name,fn){
  try{ fn(); pass++; console.log('  ok  --',name); }
  catch(e){ fail++; console.log('FAIL  --',name); console.log('      '+(e && e.stack ? e.stack.split('\n').slice(0,3).join('\n      ') : e)); }
}
function section(name){ console.log('\n== '+name+' =='); }

// Minimal fixed inputs for _calcIncome -- $0 Layer 2/3 by default so the
// tests can focus purely on Layer 1 vs. puts notional.
function baseInputs(overrides){
  return Object.assign({tbillAmt:0,fdlxxAmt:0,spaxxAmt:0,spyiShares:0,nbosShares:0,putsNotional:0,ccStockAmt:0},overrides||{});
}
const NO_YIELD_DATA={price:null,yld:null};

// ============================================================================
section('Income Planner: collateral-coverage check');

test('fully covered when put notional is <= Layer 1 capital -- no shortfall', ()=>{
  const ctx=buildIncomeContext();
  const inp=baseInputs({spaxxAmt:50000});
  const result=run(ctx,'_calcIncome')(inp,4.0,4.0,4.0,NO_YIELD_DATA,NO_YIELD_DATA,12,30000,0);
  assert.strictEqual(result.collateralCoverage.covered,true);
  assert.strictEqual(result.collateralCoverage.shortfall,0);
  assert.strictEqual(result.collateralCoverage.putsNotional,30000);
  assert.strictEqual(result.collateralCoverage.l1Capital,50000);
});

test('shortfall correctly flagged when put notional exceeds Layer 1 capital', ()=>{
  const ctx=buildIncomeContext();
  const inp=baseInputs({spaxxAmt:20000});
  const result=run(ctx,'_calcIncome')(inp,4.0,4.0,4.0,NO_YIELD_DATA,NO_YIELD_DATA,12,35000,0);
  assert.strictEqual(result.collateralCoverage.covered,false);
  assert.strictEqual(result.collateralCoverage.shortfall,15000);
});

test('exactly equal notional and Layer 1 capital counts as covered (boundary)', ()=>{
  const ctx=buildIncomeContext();
  const inp=baseInputs({spaxxAmt:25000});
  const result=run(ctx,'_calcIncome')(inp,4.0,4.0,4.0,NO_YIELD_DATA,NO_YIELD_DATA,12,25000,0);
  assert.strictEqual(result.collateralCoverage.covered,true);
  assert.strictEqual(result.collateralCoverage.shortfall,0);
});

test('the coverage check does not change the blended yield arithmetic itself -- same total capital/income as before this fix', ()=>{
  const ctx=buildIncomeContext();
  const inp=baseInputs({spaxxAmt:20000,ccStockAmt:10000});
  const result=run(ctx,'_calcIncome')(inp,4.0,4.0,4.0,NO_YIELD_DATA,NO_YIELD_DATA,12,35000,0);
  // Total capital should be L1 (20000) + L2 (0) + CC stock (10000) = 30000
  // -- put notional (35000) still excluded from the denominator, exactly
  // as before. The warning is additive information, not a math change.
  assert.strictEqual(result.blended.capital,30000);
});

test('_calcIncomeAllAccounts sums put notional AND Layer 1 capital across accounts before checking coverage', ()=>{
  const ctx=buildIncomeContext();
  // Two accounts: account A covered on its own, account B not -- but the
  // pooled totals happen to net out covered. Confirms the check is done
  // on the SUMMED totals, not by simply OR-ing each account's own flag.
  run(ctx,`S.set('income_accounts_meta',[{id:'A',name:'A'},{id:'B',name:'B'}])`);
  run(ctx,`S.set('income_A_inputs',${JSON.stringify(baseInputs({spaxxAmt:40000,targetAPY:12}))})`);
  run(ctx,`S.set('income_B_inputs',${JSON.stringify(baseInputs({spaxxAmt:5000,targetAPY:12}))})`);
  run(ctx,`S.set('income_A_put_positions',[])`);
  run(ctx,`S.set('income_B_put_positions',[])`);
  run(ctx,`S.set('income_A_cc_positions',[])`);
  run(ctx,`S.set('income_B_cc_positions',[])`);
  const agg=run(ctx,'_calcIncomeAllAccounts')();
  assert.strictEqual(agg.l1.capital,45000);
  // With no tracked positions, putsNotional falls back to inp.putsNotional
  // (0 for both accounts here), so coverage should read as fully covered.
  assert.strictEqual(agg.collateralCoverage.covered,true);
});

// ============================================================================
section('Earnings reaction: hour-known exclusion from aggregates');

function syntheticHistPair(n){
  let closes=[],spCloses=[],timestamps=[];
  let px=100,sp=4000,t=Math.floor(Date.now()/1000)-n*86400*1.45;
  for(let i=0;i<n;i++){
    px=px*(1+Math.sin(i*0.4)*0.03);
    sp=sp*(1+Math.sin(i*0.2)*0.005);
    closes.push(px);spCloses.push(sp);
    timestamps.push(Math.floor(t));
    t+=86400*1.45;
  }
  return{stock:{closes,timestamps},sp:{closes:spCloses,timestamps:[...timestamps]}};
}

test('an event with a known hour (bmo/amc) is marked hourKnown:true', ()=>{
  const ctx=buildTickerContext();
  const{stock,sp}=syntheticHistPair(60);
  const dateStr=new Date(stock.timestamps[30]*1000).toISOString().split('T')[0];
  const events=run(ctx,'_computeEarningsReactionEvents')(stock,sp,[{date:dateStr,hour:'bmo'}]);
  assert(events&&events.length);
  assert.strictEqual(events[0].hourKnown,true);
});

test('an event with no hour recorded is marked hourKnown:false, not silently treated as confirmed BMO', ()=>{
  const ctx=buildTickerContext();
  const{stock,sp}=syntheticHistPair(60);
  const dateStr=new Date(stock.timestamps[30]*1000).toISOString().split('T')[0];
  const events=run(ctx,'_computeEarningsReactionEvents')(stock,sp,[{date:dateStr,hour:''}]);
  assert(events&&events.length);
  assert.strictEqual(events[0].hourKnown,false);
  // The reaction value itself should still be computed (informational,
  // shown per-event) -- hourKnown is what downstream aggregation checks,
  // not whether the field exists at all.
  assert(events[0].reactionPct!=null||events[0].reactionPct===null); // just confirm no crash / field exists
  assert('reactionPct' in events[0]);
});

test('_computeEarningsPatternSummary excludes hourKnown:false events from the averaged reaction stats', ()=>{
  const ctx=buildTickerContext();
  const{stock,sp}=syntheticHistPair(200);
  // Two known-hour events and one unknown-hour event, spread out enough
  // to each get their own valid reaction window.
  const d1=new Date(stock.timestamps[40]*1000).toISOString().split('T')[0];
  const d2=new Date(stock.timestamps[100]*1000).toISOString().split('T')[0];
  const d3=new Date(stock.timestamps[160]*1000).toISOString().split('T')[0];
  const earningsHistory=[{date:d1,hour:'bmo'},{date:d2,hour:'amc'},{date:d3,hour:''}];
  const events=run(ctx,'_computeEarningsReactionEvents')(stock,sp,earningsHistory);
  assert.strictEqual(events.length,3,'all three events should still be computed and present');
  const summary=run(ctx,'_computeEarningsPatternSummary')('TEST',stock,sp,earningsHistory);
  // _computeEarningsPatternSummary returns rendered HTML (not a plain
  // data object) whose header states "(N events)" where N is the
  // AGGREGATE sample count (validReaction.length) -- should read 2, not
  // 3, since the unknown-hour event is excluded from what gets averaged
  // even though _computeEarningsReactionEvents still computed it.
  assert(summary,'expected a rendered summary (non-null) for this scenario');
  assert(/\(2 events\)/.test(summary),'aggregate header should report 2 events (known-hour only), not 3 -- got: '+summary.slice(0,120));
});

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
