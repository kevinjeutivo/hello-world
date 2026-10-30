const fs=require('fs'),vm=require('vm'),assert=require('assert');
const src=fs.readFileSync('js/earnings.js','utf8');
const name='function _recentEarningsEPSState(';
const start=src.indexOf(name);assert(start>=0);
let depth=0,end=-1;for(let i=src.indexOf('{',start);i<src.length;i++){if(src[i]==='{')depth++;else if(src[i]==='}'&&!--depth){end=i+1;break;}}
const helperStart=src.indexOf('function _earningsPeriodMatch(');assert(helperStart>=0);
let hd=0,helperEnd=-1;for(let i=src.indexOf('{',helperStart);i<src.length;i++){if(src[i]==='{')hd++;else if(src[i]==='}'&&!--hd){helperEnd=i+1;break;}}
const ctx={Date,Number};vm.createContext(ctx);vm.runInContext(src.slice(helperStart,helperEnd)+'\n'+src.slice(start,end),ctx);
const classify=ctx._recentEarningsEPSState;
const old=[{date:'2026-06-30',epsActual:0.52,epsEstimate:0.40,surprisePercent:30.5}];
let r=classify(old,'2026-10-29');assert(!r.verified);assert.strictEqual(r.prior.epsActual,0.52);assert.strictEqual(r.current,null);
r=classify([...old,{date:'2026-09-30',epsActual:0.60,epsEstimate:0.55,surprisePercent:9.1}],'2026-10-29');
assert(r.verified);assert.strictEqual(r.current.epsActual,0.60);assert.strictEqual(r.periodEnd,'2026-09-30');
r=classify([...old,{date:'2026-09-30',epsActual:null,epsEstimate:0.55}],'2026-10-29');assert(!r.verified);
r=classify([...old,{date:'2026-09-30',epsActual:0.60,epsEstimate:null}],'2026-10-29');assert(!r.verified);
r=classify(old,'2026-10-22');assert(!r.verified);
assert(src.includes('if(_earningsConflictsWithUpcoming(t,c.date))return false;'));
assert(src.includes('${provenance}'));
console.log('PASS recent EPS provenance (stale, updated, partial, prior-only, render)');
