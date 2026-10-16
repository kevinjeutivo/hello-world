#!/usr/bin/env node
'use strict';
// tests/earnings-card-state.test.js -- coverage for the build-527 earnings-
// card rework: _classifyEarningsCardState and _nextForwardEstimate in
// earnings.js, which replace a fetch-timestamp heuristic (_earningsFreshnessLabel,
// still used elsewhere and left alone) with verification against the actual
// earningsHistoryYahoo data for the Upcoming earnings card specifically.
//
// These are loaded verbatim from the real source files (helpers.js for
// _todayET/_todayReportBoundaryEpoch, earnings.js for the functions under
// test and their _computeBeatMissStreak dependency) via a shared vm context
// -- not reimplemented -- so these tests exercise the actual shipped logic.
//
// "Today" in every same-day test case is the real _todayET() wherever the
// suite happens to run, not a hardcoded date, so these tests can't go stale
// or flake based on the calendar date.
//
// Usage: node tests/earnings-card-state.test.js

const fs=require('fs');
const path=require('path');
const vm=require('vm');
const assert=require('assert');

const ROOT=path.join(__dirname,'..');
const ctx={console,window:{},S:{get:()=>null,set:()=>true}};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT,'js/helpers.js'),'utf8'),ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT,'js/earnings.js'),'utf8'),ctx);

const todayET=vm.runInContext('_todayET()',ctx);
const todayNoon=new Date(todayET+'T12:00:00Z');
// A period-end comfortably inside the 45-day "this is the event reporting
// today" window used by the real matching logic.
const periodEndStr=(daysBefore)=>{
  const d=new Date(todayNoon.getTime()-daysBefore*86400000);
  return d.toISOString().split('T')[0];
};
const THIS_PERIOD=periodEndStr(25);   // matches today's event
const PRIOR_PERIOD=periodEndStr(115); // clearly outside the window -- a genuine prior quarter
const EARLIER_PERIOD=periodEndStr(205);

function classify(eh,earningsDate,earningsHour,nowEpoch){
  ctx.__eh=eh;ctx.__ed=new Date(earningsDate+'T12:00:00Z');ctx.__earningsDate=earningsDate;ctx.__hour=earningsHour;ctx.__now=nowEpoch;
  return vm.runInContext('_classifyEarningsCardState(__eh,__ed,__earningsDate,__hour,__now)',ctx);
}
function nextForward(trend,after){
  ctx.__trend=trend;ctx.__after=after;
  return vm.runInContext('_nextForwardEstimate(__trend,__after)',ctx);
}
function boundaryEpoch(hour){
  ctx.__hour2=hour;
  return vm.runInContext('_todayReportBoundaryEpoch(__hour2)',ctx);
}

let pass=0,fail=0;
function test(name,fn){
  try{fn();pass++;console.log('  ok -- '+name);}
  catch(e){fail++;console.error('  FAIL -- '+name+'\n    '+e.stack.split('\n').slice(0,2).join('\n    '));}
}

// ── State 1: before ─────────────────────────────────────────────────────────

test("a future announcement date is always 'before', regardless of any history data present",()=>{
  const future=periodEndStr(-40); // 40 days from now
  const r=classify([{date:PRIOR_PERIOD,epsActual:1,epsEstimate:0.9,surprisePercent:11.1,surpriseDollar:0.1}],future,'bmo');
  assert.strictEqual(r.state,'before');
});

test("same-day bmo report, current time still before the 9:30am ET boundary, no matching entry -- 'before'",()=>{
  const boundary=boundaryEpoch('bmo');
  const r=classify([],todayET,'bmo',boundary-60000); // 1 minute before open
  assert.strictEqual(r.state,'before');
});

test("same-day amc report, current time still before the 4pm ET boundary -- 'before'",()=>{
  const boundary=boundaryEpoch('amc');
  const r=classify([],todayET,'amc',boundary-60000);
  assert.strictEqual(r.state,'before');
});

// ── State 2: unconfirmed ────────────────────────────────────────────────────

test("same-day bmo, past the boundary, no matching entry at all yet -- 'unconfirmed', not 'before'",()=>{
  const boundary=boundaryEpoch('bmo');
  const r=classify([],todayET,'bmo',boundary+60000);
  assert.strictEqual(r.state,'unconfirmed');
});

test("delayed Yahoo update: past boundary, a matching-period entry exists but epsActual is still null -- 'unconfirmed'",()=>{
  const boundary=boundaryEpoch('bmo');
  const eh=[{date:THIS_PERIOD,epsActual:null,epsEstimate:1.10,surprisePercent:null,surpriseDollar:null}];
  const r=classify(eh,todayET,'bmo',boundary+60000);
  assert.strictEqual(r.state,'unconfirmed');
  assert.strictEqual(r.todayActual,null,"an unconfirmed state must not surface a today's-actual value");
});

test("mismatched fiscal period: actual posted but no matching estimate on that entry -- 'unconfirmed', matching cannot be established",()=>{
  const boundary=boundaryEpoch('bmo');
  const eh=[{date:THIS_PERIOD,epsActual:1.21,epsEstimate:null,surprisePercent:null,surpriseDollar:null}];
  const r=classify(eh,todayET,'bmo',boundary+60000);
  assert.strictEqual(r.state,'unconfirmed');
  assert.strictEqual(r.todayActual,null);
  assert.strictEqual(r.todaySurprisePct,null);
  assert.strictEqual(r.todaySurpriseDollar,null);
});

test("same-day, earnings hour unknown (timing unconfirmed), no matching entry -- 'unconfirmed', never silently treated as 'before'",()=>{
  const r=classify([],todayET,null);
  assert.strictEqual(r.state,'unconfirmed');
});

test("'unconfirmed' still surfaces the previous (unrelated, older) quarter's actual/surprise untouched",()=>{
  const boundary=boundaryEpoch('bmo');
  const eh=[
    {date:THIS_PERIOD,epsActual:null,epsEstimate:1.10,surprisePercent:null,surpriseDollar:null},
    {date:PRIOR_PERIOD,epsActual:1.21,epsEstimate:1.19,surprisePercent:1.68,surpriseDollar:0.02},
  ];
  const r=classify(eh,todayET,'bmo',boundary+60000);
  assert.strictEqual(r.state,'unconfirmed');
  assert.strictEqual(r.prevActual,1.21);
  assert.strictEqual(r.prevSurprisePct,1.68);
});

// ── State 3: confirmed ──────────────────────────────────────────────────────

test("matching-period entry has both actual and estimate -- 'confirmed', regardless of whether the boundary has technically passed",()=>{
  const eh=[{date:THIS_PERIOD,epsActual:1.14,epsEstimate:1.05,surprisePercent:8.6,surpriseDollar:0.09}];
  const r=classify(eh,todayET,'bmo'); // nowEpoch omitted -- data alone decides
  assert.strictEqual(r.state,'confirmed');
  assert.strictEqual(r.todayActual,1.14);
  assert.strictEqual(r.todayEstimate,1.05);
  assert.strictEqual(r.todaySurprisePct,8.6);
});

test("'confirmed' never combines today's actual with a different period's estimate -- both come from the same matched entry",()=>{
  const eh=[
    {date:THIS_PERIOD,epsActual:1.14,epsEstimate:1.05,surprisePercent:8.6,surpriseDollar:0.09},
    {date:PRIOR_PERIOD,epsActual:1.21,epsEstimate:1.19,surprisePercent:1.68,surpriseDollar:0.02},
  ];
  const r=classify(eh,todayET,'bmo');
  assert.strictEqual(r.state,'confirmed');
  assert.strictEqual(r.todayEstimate,1.05,"today's estimate must be the one paired with today's own actual, not the prior quarter's");
  assert.strictEqual(r.prevActual,1.21,"the prior-quarter figure must remain the genuinely older entry, not today's");
});

test('beat streak recomputed to include today extends a streak that was already running',()=>{
  const eh=[
    {date:THIS_PERIOD,epsActual:1.14,epsEstimate:1.05,surprisePercent:8.6,surpriseDollar:0.09}, // beat
    {date:PRIOR_PERIOD,epsActual:1.21,epsEstimate:1.19,surprisePercent:1.68,surpriseDollar:0.02}, // beat
    {date:EARLIER_PERIOD,epsActual:1.30,epsEstimate:1.10,surprisePercent:18.2,surpriseDollar:0.20}, // beat
  ];
  const r=classify(eh,todayET,'bmo');
  assert.strictEqual(r.state,'confirmed');
  assert.strictEqual(r.prevBeatStreak,2,"the 'through previous report' streak must exclude today's own entry");
  assert.strictEqual(r.todayBeatStreak,3,"the streak including today must count all three consecutive beats");
});

test('a miss today breaks what had been a beat streak, in the today-inclusive count only',()=>{
  const eh=[
    {date:THIS_PERIOD,epsActual:0.95,epsEstimate:1.05,surprisePercent:-9.5,surpriseDollar:-0.1}, // miss
    {date:PRIOR_PERIOD,epsActual:1.21,epsEstimate:1.19,surprisePercent:1.68,surpriseDollar:0.02}, // beat
    {date:EARLIER_PERIOD,epsActual:1.30,epsEstimate:1.10,surprisePercent:18.2,surpriseDollar:0.20}, // beat
  ];
  const r=classify(eh,todayET,'bmo');
  assert.strictEqual(r.prevBeatStreak,2,"the prior-report-only streak is unaffected by today's result");
  assert.strictEqual(r.todayMissStreak,1,"today's miss starts a fresh miss streak of 1 once included");
  assert.strictEqual(r.todayBeatStreak,0);
});

// ── _nextForwardEstimate ─────────────────────────────────────────────────────

test('forward estimate is returned as-is (with its period end) when no after-date filter applies',()=>{
  const trend=[{period:'0q',epsMean:1.30,endDate:periodEndStr(-60)}];
  const r=nextForward(trend,null);
  assert.strictEqual(r.epsEst,1.30);
  assert.strictEqual(r.epsEstEndDate,periodEndStr(-60));
});

test("a stale forward estimate that hasn't rolled past today's just-confirmed period is withheld, not mislabeled 'next quarter'",()=>{
  // Trend still describes the same period that just reported (hasn't
  // caught up with History yet) -- its endDate is NOT later than the
  // confirmed period's own end date.
  const trend=[{period:'0q',epsMean:1.14,endDate:THIS_PERIOD}];
  const r=nextForward(trend,THIS_PERIOD);
  assert.strictEqual(r.epsEst,null,"a same-period forward estimate must not be surfaced as the next quarter's");
});

test('a forward estimate that has genuinely rolled forward past the confirmed period is kept',()=>{
  const genuinelyNext=periodEndStr(-70); // 70 days from now -- after THIS_PERIOD
  const trend=[{period:'0q',epsMean:1.22,endDate:genuinelyNext}];
  const r=nextForward(trend,THIS_PERIOD);
  assert.strictEqual(r.epsEst,1.22);
  assert.strictEqual(r.epsEstEndDate,genuinelyNext);
});

test('no earningsTrend data at all yields a clean null, not a throw',()=>{
  // Cross-realm result objects (from vm.runInContext) need spreading into a
  // plain-realm object before deepStrictEqual, or the comparison fails on
  // constructor identity alone despite identical own-property values.
  assert.deepStrictEqual({...nextForward(null,null)},{epsEst:null,epsEstEndDate:null});
  assert.deepStrictEqual({...nextForward([],null)},{epsEst:null,epsEstEndDate:null});
});

// ── Edge cases ───────────────────────────────────────────────────────────────

test('empty earnings history never throws and lands on a sane state',()=>{
  assert.doesNotThrow(()=>classify([],todayET,'bmo'));
  assert.doesNotThrow(()=>classify([],periodEndStr(-10),'amc'));
});

test('an entry outside the 45-day window on the near side (e.g. 44 days before) still counts as matching; 45+ does not',()=>{
  const almostOut=periodEndStr(44);
  const justOut=periodEndStr(45);
  const r1=classify([{date:almostOut,epsActual:1,epsEstimate:0.9,surprisePercent:11.1,surpriseDollar:0.1}],todayET,'bmo');
  // r2 has no matching entry (by design -- that's what's under test), so
  // unlike r1 its state falls through to the before/unconfirmed boundary
  // check, which depends on nowEpoch -- pin it reliably past the boundary
  // so this doesn't flake depending on what time of day the suite runs.
  const boundary=boundaryEpoch('bmo');
  const r2=classify([{date:justOut,epsActual:1,epsEstimate:0.9,surprisePercent:11.1,surpriseDollar:0.1}],todayET,'bmo',boundary+60000);
  assert.strictEqual(r1.state,'confirmed',"44 days before should still match today's event");
  assert.strictEqual(r2.state,'unconfirmed',"45 days before should be treated as a genuinely separate (prior) quarter, not today's");
});

// ── Render wiring sanity checks ──────────────────────────────────────────────
// Confirms renderEarningsCards actually consults the new classification
// (not just that the pure function above is correct in isolation -- a
// correct function that never gets called would pass every test above and
// still ship the original bug).
const earningsSrc=fs.readFileSync(path.join(ROOT,'js/earnings.js'),'utf8');

test('the old ambiguous "Updated post-earnings" status text is gone from the earnings card',()=>{
  assert(!earningsSrc.includes('Updated post-earnings'),
    'the ambiguous freshness text should have been replaced by precise per-state labels');
});

test('renderEarningsCards calls the new classification and forward-estimate functions',()=>{
  const renderFn=earningsSrc.slice(earningsSrc.indexOf('function renderEarningsCards'));
  assert(renderFn.includes('_classifyEarningsCardState('),'renderEarningsCards must call _classifyEarningsCardState');
  assert(renderFn.includes('_nextForwardEstimate('),'renderEarningsCards must call _nextForwardEstimate');
  assert(renderFn.includes("S.get('snap_'+e.ticker)"),
    'renderEarningsCards must read the freshest snap at render time, not only the one embedded in cached earningsAllData');
});

test('all three state labels (before/unconfirmed/confirmed EPS framing) are present in the template',()=>{
  assert(earningsSrc.includes('PRIOR ACTUAL'),"the pre-report label ('before' state) should be unchanged");
  assert(earningsSrc.includes("EPS ACTUAL (THROUGH PREVIOUS REPORT)"),"the 'unconfirmed' state must label the old actual precisely");
  assert(earningsSrc.includes('NEXT QUARTER ESTIMATE'),"the forward estimate must be relabeled 'next quarter estimate'");
  assert(earningsSrc.includes("Today's EPS comparison unavailable"),"the 'unconfirmed' state must show the unavailable placeholder, per spec");
  assert(earningsSrc.includes('EPS ACTUAL (TODAY)')&&earningsSrc.includes('EPS ESTIMATE (TODAY)'),
    "the 'confirmed' state must show today's actual and estimate prominently and distinctly");
});

console.log(pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
