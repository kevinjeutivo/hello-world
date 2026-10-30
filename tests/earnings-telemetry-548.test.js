const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const src=fs.readFileSync('js/earnings.js','utf8');
const mem=new Map(),clock={now:Date.parse('2026-10-28T12:00:00Z')};
const ctx={Date:class extends Date{constructor(...a){super(...(a.length?a:[clock.now]));}static now(){return clock.now;}},Intl,JSON,Number,Math,Array,console,S:{get:k=>mem.get(k)||null,set:(k,v)=>(mem.set(k,v),true)},_todayET:()=> '2026-10-28',_todayReportBoundaryEpoch:()=>clock.now};
vm.createContext(ctx);vm.runInContext(src,ctx);
const hist=[{date:'2026-09-30',epsActual:null,epsEstimate:.4}];
ctx._earningsTelemetryCapture('INTC',hist,'Yahoo quoteSummary',{earningsDate:'2026-10-29',earningsHour:'amc'});
let ev=mem.get('earnings_diag_INTC').events;assert.equal(ev.length,1);assert.equal(ev[0].rows[0].actual,null);
ctx._earningsTelemetryCapture('INTC',hist,'Yahoo quoteSummary',{earningsDate:'2026-10-29',earningsHour:'amc'});assert.equal(ev.length,1);
clock.now+=86400000;ctx._earningsTelemetryCapture('INTC',[{date:'2026-09-30',epsActual:.52,epsEstimate:.4}],'Yahoo quoteSummary',{earningsDate:null});
ev=mem.get('earnings_diag_INTC').events;assert.equal(ev.length,2);assert.equal(ev[1].rows[0].actual,.52);assert.equal(ev[1].upcoming,null);
// Same quarter's actual/estimate is primary evidence, regardless of observation baseline.
assert.equal(ctx._recentEarningsEPSState([{date:'2026-09-30',epsActual:.52,epsEstimate:.4}],'2026-10-29').verified,true);
// Telemetry has no effect on earnings classification.
assert.equal(ctx._recentEarningsEPSState([{date:'2026-09-30',epsActual:null,epsEstimate:.4}],'2026-10-29').verified,false);
console.log('PASS earnings telemetry and period-first classification');
