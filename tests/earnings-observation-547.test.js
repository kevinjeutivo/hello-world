const assert=require('node:assert/strict');
const fs=require('fs');const vm=require('vm');
const source=fs.readFileSync(__dirname+'/../js/earnings.js','utf8');
const data=new Map();let now=Date.parse('2026-10-28T15:00:00Z');
const ctx={Date:class extends Date {constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}},Intl,JSON,Number,Math,Array,console,
 S:{get:k=>data.get(k)||null,set:(k,v)=>(data.set(k,v),true)},_todayET:()=> '2026-10-28',_todayReportBoundaryEpoch:()=>Date.parse('2026-10-29T20:00:00Z')};
vm.createContext(ctx);vm.runInContext(source,ctx);
const event='2026-10-29';const prior=[{date:'2026-09-30',epsActual:0.52,epsEstimate:0.40}];
const snapshot={earningsDate:event,earningsHour:'amc',earningsHistoryYahoo:prior};
ctx._earningsObserveFreshSnapshot('INTC',snapshot);
assert.equal(ctx._earningsEventStatus('INTC',event,'amc',prior,now).state,'before');
now=Date.parse('2026-10-30T14:00:00Z');
assert.equal(ctx._earningsEventStatus('INTC',event,'amc',prior,now).state,'pending','unchanged pre-event EPS must not count');
const changed=[{date:'2026-09-30',epsActual:0.61,epsEstimate:0.40}];
assert.equal(ctx._earningsEventStatus('INTC',event,'amc',changed,now).state,'observed');
assert.equal(ctx._recentEarningsEPSState(prior,event,'INTC','amc').verified,false);
assert.equal(ctx._recentEarningsEPSState(changed,event,'INTC','amc').verified,true);
assert.equal(ctx._earningsEventStatus('UNKNOWN',event,'amc',changed,now).state,'unknown','no baseline means no verification');
console.log('earnings observation regression passed');
