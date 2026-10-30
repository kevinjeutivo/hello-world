'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const root=path.join(__dirname,'..');
const ctx={console,S:{get:()=>null,set:()=>true},window:{}};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root,'js/helpers.js'),'utf8'),ctx);
vm.runInContext(fs.readFileSync(path.join(root,'js/earnings.js'),'utf8'),ctx);
function run(expression,vars={}){Object.assign(ctx,vars);return vm.runInContext(expression,ctx)}
function row(date,actual,estimate){return {date,epsActual:actual,epsEstimate:estimate}}
const intel=[row('2026-09-30',.52,.39855),row('2026-06-30',.42,.21584)];
const ma=[row('2026-09-30',5.31,5.16433),row('2026-06-30',5.04,4.77606)];
const shop=[row('2026-06-30',.42,.3998)];
const spcx=[row('2026-09-30',.35,.16471)];
for(const [ticker,date,hour,rows,expected] of [
 ['INTC','2026-10-29','amc',intel,.52],['MA','2026-10-29','amc',ma,5.31]
]){
 const result=run('_earningsEventStatus(ticker,date,hour,rows,now)',{ticker,date,hour,rows,now:Date.parse('2026-10-30T16:53:23Z')});
 assert.strictEqual(result.state,'observed',ticker+' should not require pre-report baseline');
 assert.strictEqual(result.match.current.epsActual,expected);
 assert.strictEqual(run('_recentEarningsEPSState(rows,date)',{rows,date}).verified,true);
}
assert.strictEqual(run('_recentEarningsEPSState(rows,date)',{rows:shop,date:'2026-11-03'}).verified,false,'SHOP prior quarter not current');
assert.strictEqual(run('_recentEarningsEPSState(rows,date)',{rows:shop,date:'2026-10-22'}).verified,false,'SHOP Oct 22 not current quarter');
assert.strictEqual(run('_earningsEventStatus(ticker,date,hour,rows,now)',{ticker:'SPCX',date:'2026-11-03',hour:null,rows:spcx,now:Date.parse('2026-10-30T16:53:23Z')}).state,'before');
assert.strictEqual(run('_earningsEventStatus(ticker,date,hour,rows,now)',{ticker:'INTC',date:'2026-10-29',hour:'amc',rows:[row('2026-06-30',.42,.21)],now:Date.parse('2026-10-30T16:53:23Z')}).state,'pending');
assert.strictEqual(run('_earningsPeriodMatch(rows,date)',{rows:[row('2026-09-30',.52,.40),row('2026-10-15',.54,.42)],date:'2026-10-29'}).verified,false,'ambiguous fiscal-period candidates');
assert.strictEqual(run('_earningsEventStatus(ticker,date,hour,rows,now)',{ticker:'INTC',date:'2026-10-29',hour:'amc',rows:intel,now:Date.parse('2026-10-29T18:00:00Z')}).state,'before');
console.log('Build 550 fiscal period and observation regressions passed');
