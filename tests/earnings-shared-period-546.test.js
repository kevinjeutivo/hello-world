const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync('js/earnings.js','utf8');
function extract(name){const start=src.indexOf('function '+name+'(');assert(start>=0,name);let depth=0,end=-1;for(let i=src.indexOf('{',start);i<src.length;i++){if(src[i]==='{')depth++;else if(src[i]==='}'&&!--depth){end=i+1;break;}}assert(end>start);return src.slice(start,end);}
const ctx={Date,Number,_todayET:()=> '2026-10-29',_todayReportBoundaryEpoch:()=>Date.parse('2026-10-29T20:00:00Z'),_computeBeatMissStreak:(a)=>({beatStreak:a.length,missStreak:0})};vm.createContext(ctx);
for(const n of ['_earningsPeriodMatch','_classifyEarningsCardState','_recentEarningsEPSState'])vm.runInContext(extract(n),ctx);
const prev={date:'2026-06-30',epsActual:.52,epsEstimate:.40};
const current={date:'2026-09-30',epsActual:.60,epsEstimate:.55};
function verify(history,expected){const upcoming=ctx._classifyEarningsCardState(history,new Date('2026-10-29T12:00:00Z'),'2026-10-29','amc',Date.parse('2026-10-30T00:00:00Z'));const recent=ctx._recentEarningsEPSState(history,'2026-10-29');assert.strictEqual(upcoming.state==='confirmed',expected);assert.strictEqual(recent.verified,expected);}
verify([prev],false);verify([prev,current],true);verify([prev,{...current,epsActual:null}],false);verify([prev,{...current,epsEstimate:null}],false);
assert(!ctx._recentEarningsEPSState([prev],'2026-10-22').verified);
assert(src.includes('e.daysAgo<=2?')&& !src.includes('provider data may be delayed.'));
console.log('PASS shared upcoming/recent fiscal matching and provenance labels');
