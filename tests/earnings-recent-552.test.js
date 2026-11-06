const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const code=fs.readFileSync(require('node:path').join(__dirname,'../js/earnings.js'),'utf8');
const store={};
const ctx=vm.createContext({S:{get:k=>store[k],set:(k,v)=>store[k]=v},console});
vm.runInContext(code,ctx);
const hist=[{date:'2026-09-30',epsActual:0.35,epsEstimate:0.16471},{date:'2026-06-30',epsActual:-0.09,epsEstimate:-0.28931}];
const manual={date:'2026-10-20',hour:'amc',addedTs:'test'};
store.earnings_hist_SPCX={data:[{date:'2026-10-20',hour:'amc',override:manual}]};
const confirmed=[{date:'2026-10-20',hour:'amc'},{date:'2026-11-05',hour:null}];
let dates=ctx._recentDatesWithManualPrecedence('SPCX',confirmed,hist);
assert.deepEqual(Array.from(dates,e=>e.date),['2026-10-20']);
assert.equal(confirmed.length,2,'confirmed storage must not be mutated');
assert.equal(store.earnings_hist_SPCX.data[0].override,manual);
assert.equal(ctx._earningsPeriodMatch(hist,dates[0].date).current.date,'2026-09-30');
// An unrelated future quarter is never displaced by the October override.
const futureHist=[...hist,{date:'2026-12-31',epsActual:0.38,epsEstimate:0.35}];
dates=ctx._recentDatesWithManualPrecedence('SPCX',[...confirmed,{date:'2027-01-20'}],futureHist);
assert(dates.some(e=>e.date==='2027-01-20'));
assert(!dates.some(e=>e.date==='2026-11-05'));
// No override: no silent deletion or rewriting of historical cache.
store.earnings_hist_SHOP={data:[]};
dates=ctx._recentDatesWithManualPrecedence('SHOP',confirmed,hist);
assert.equal(dates.length,2);
// A missing fiscal-period match cannot justify suppression.
store.earnings_hist_UNKNOWN={data:[{date:'2026-10-20',override:manual}]};
dates=ctx._recentDatesWithManualPrecedence('UNKNOWN',confirmed,[]);
assert.equal(dates.length,2);
console.log('Build 552 earnings Recent manual-precedence regression tests passed');
