// Regression coverage for Builds 530-535. Execute: node tests/recent-builds-530-535.test.js
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=name=>fs.readFileSync(path.join(__dirname,'../js',name),'utf8');
function extract(src,name){
 const start=src.indexOf('function '+name+'(');assert(start>=0,`missing ${name}`);
 const open=src.indexOf('{',start);let depth=0,quote='',escape=false,comment='';
 for(let i=open;i<src.length;i++){
  const c=src[i],n=src[i+1];
  if(comment==='line'){if(c==='\n')comment='';continue;}
  if(comment==='block'){if(c==='*'&&n==='/'){comment='';i++;}continue;}
  if(quote){if(escape){escape=false;continue;}if(c==='\\'){escape=true;continue;}if(c===quote)quote='';continue;}
  if(c==='/'&&n==='/'){comment='line';i++;continue;}
  if(c==='/'&&n==='*'){comment='block';i++;continue;}
  if(c==='"'||c==="'"||c==='`'){quote=c;continue;}
  if(c==='{')depth++;if(c==='}'&&--depth===0)return src.slice(start,i+1);
 }
 throw Error('unclosed '+name);
}
let checks=0;function test(label,fn){fn();checks++;console.log('PASS',label);}
const storage={};const S={get:k=>storage[k],set:(k,v)=>(storage[k]=v,true)};
const today=new Date();const future=days=>{const d=new Date();d.setDate(d.getDate()+days);return d.toISOString().slice(0,10);};
// Build 530: exercise the actual ticker-position selector with rolled, expired and other-ticker entries.
{
 const src=read('watchlist.js'),ctx=vm.createContext({S,console,Date});
 vm.runInContext(extract(src,'_posExpiryStatusWL')+'\n'+extract(src,'_getIncomePositionsForTicker'),ctx);
 storage.income_accounts_meta=[{id:'a',name:'IRA'}];
 storage.income_a_put_positions=[{ticker:'ABC',expDate:future(20)},{ticker:'ABC',expDate:future(20),rolledAt:new Date().toISOString()},{ticker:'XYZ',expDate:future(20)},{ticker:'ABC',expDate:future(-9)}];
 storage.income_a_cc_positions=[{ticker:'ABC',expDate:future(20)},{ticker:'ABC',expDate:future(20),rolledAt:new Date().toISOString()}];
 test('530: ticker positions exclude rolled, expired and other tickers',()=>{const a=ctx._getIncomePositionsForTicker('ABC');assert.equal(a.length,1);assert.equal(a[0].puts.length,1);assert.equal(a[0].ccs.length,1);});
}
// Build 532: exercise actual OTM proximity function with stubbed pricing/status.
{
 const src=read('income.js');const ctx=vm.createContext({S,Date,_posExpiryStatus:p=>p.rolledAt?'expired-linger':'active',_getPosPricing:p=>({currentPrice:p.price})});
 vm.runInContext(extract(src,'_computeApproachingStrike'),ctx);
 storage.income_a_put_positions=[{ticker:'PUT',price:101,strike:100,expDate:future(5)},{ticker:'ITMP',price:99,strike:100,expDate:future(5)},{ticker:'FAR',price:110,strike:100,expDate:future(5)},{ticker:'ROLLED',price:101,strike:100,expDate:future(5),rolledAt:'2026-01-01'}];
 storage.income_a_cc_positions=[{ticker:'CALL',price:99,strike:100,expDate:future(2)},{ticker:'ITMC',price:101,strike:100,expDate:future(2)}];
 test('532: only active near-strike OTM positions; expiry-first order',()=>{const rows=ctx._computeApproachingStrike(2);assert.equal(rows.length,2);assert.equal(rows[0].ticker,'CALL');assert.equal(rows[1].ticker,'PUT');});
 test('532: threshold narrows results',()=>assert.equal(ctx._computeApproachingStrike(0.5).length,0));
 const dash=read('dashboard.js');test('532: dashboard wires proximity controls',()=>{assert.match(dash,/_computeApproachingStrike\(threshold\)/);assert.match(dash,/\[1,2,3,5\]/);assert.match(dash,/setRiskProximityThreshold/);});
}
// Builds 533-534: actual ranking row HTML, including both metrics.
{
 const src=read('wheelbacktest.js');const ctx=vm.createContext({_wheelBacktestRangeBarSvg:()=>'<svg></svg>'});vm.runInContext(extract(src,'_wheelBacktestRankingRowHtml'),ctx);
 const r={ticker:'ABC',median:12.34,worst:-8.12,best:21,sampleSize:25};
 test('533-534: median mode emphasizes median and shows worst',()=>{const h=ctx._wheelBacktestRankingRowHtml(r,1,10,new Set(),'median');assert.match(h,/Median<\/span>\+12\.3%/);assert.match(h,/Worst: -8\.1%/);});
 test('533-534: worst mode emphasizes worst and shows median',()=>{const h=ctx._wheelBacktestRankingRowHtml(r,1,10,new Set(),'worst');assert.match(h,/Worst<\/span>-8\.1%/);assert.match(h,/Median: \+12\.3%/);});
 test('533-534: ranking actually sorts by selected metric',()=>assert.match(src,/list\.sort\(\(a,b\)=>b\[_wheelbtRankingMode\]-a\[_wheelbtRankingMode\]/));
}
// Build 535: actual monthly date filter; weekend boundary and fallback.
{
 const src=read('helpers.js'),ctx=vm.createContext({});vm.runInContext(extract(src,'_futureMonthlyOptionPairs'),ctx);
 const ts=d=>Date.parse(d+'T12:00:00Z')/1000;const dates=['2026-10-16','2026-11-20','2026-12-18','2027-01-15'].map(ts);
 test('535: expiry date retained through Friday',()=>assert.deepEqual(Array.from(ctx._futureMonthlyOptionPairs(dates,'2026-10-16'),x=>x.date),['2026-10-16','2026-11-20','2026-12-18']));
 test('535: Saturday removes expired October; selects future months',()=>assert.deepEqual(Array.from(ctx._futureMonthlyOptionPairs(dates,'2026-10-17'),x=>x.date),['2026-11-20','2026-12-18','2027-01-15']));
 test('535: missing January metadata returns only two',()=>assert.equal(ctx._futureMonthlyOptionPairs(dates.slice(0,3),'2026-10-17').length,2));
 test('535: invalid/empty metadata yields no fabricated dates',()=>assert.equal(ctx._futureMonthlyOptionPairs([0,NaN],'2026-10-17').length,0));
}
// Build 531: source-wiring assertion for separate status counts (local closure in overview renderer).
test('531: independent expiring, ITM, intersection badges are wired',()=>{const src=read('income.js');assert.match(src,/const urgent = itm\.filter\(imminent\)/);assert.match(src,/ITM \+ expiring/);assert.match(src,/const putBadges = _overviewBadges\(activePuts, false\)/);assert.match(src,/const ccBadges = _overviewBadges\(activeCCs, true\)/);});
console.log(`${checks} recent-build regression checks passed`);
