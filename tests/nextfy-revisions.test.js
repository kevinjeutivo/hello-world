const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../js/ticker.js'),'utf8');
function extract(name){const start=src.indexOf('function '+name+'(');assert(start>=0);let pos=src.indexOf('{',start),depth=0;for(let i=pos;i<src.length;i++){if(src[i]==='{')depth++;else if(src[i]==='}'&&!--depth)return src.slice(start,i+1);}throw Error('unclosed '+name);}
const ctx=vm.createContext({_escHtml:s=>s});
for(const name of ['_nextFYRevisionRows','_nextFYRevisionTable','_nextFYRevisionSection'])vm.runInContext(extract(name),ctx);
const entries=[{date:'2026-01-01',nextFYEps:10,multiple:20},{date:'2026-02-01',nextFYEps:11,multiple:21},{date:'2026-03-01',nextFYEps:10.999,multiple:null},{date:'2026-04-01',nextFYEps:9,multiple:19}];
const rows=ctx._nextFYRevisionRows(entries);assert.equal(rows.length,4);assert.equal(rows[0].date,'2026-04-01');assert.equal(rows[0].delta,-1.9990000000000006);assert.equal(rows[2].delta,1);assert.equal(rows[2].deltaPct,10);assert.equal(rows[3].isFirst,true);assert.equal(rows[1].multiple,null);
assert.match(ctx._nextFYRevisionTable(entries),/--/);assert.match(ctx._nextFYRevisionTable(entries),/first observed/);
assert.match(ctx._nextFYRevisionTable(entries.slice(0,1)),/No revisions noticed yet/);
const zero=ctx._nextFYRevisionRows([{nextFYEps:0},{nextFYEps:2}]);assert.equal(zero[0].deltaPct,null);
const missing=ctx._nextFYRevisionRows([{nextFYEps:null},{nextFYEps:2}]);assert.equal(missing[0].delta,null);
const html=ctx._nextFYRevisionSection({entries},[{fyEndDate:'2025-12-31',entries}]);assert.match(html,/FY end 2025-12-31/);assert.match(html,/sampled record/);assert.match(html,/EPS estimate revisions noticed/);
assert.match(src,/\+_nextFYRevisionSection\(track,hist\)/);
assert(src.indexOf('+_nextFYRevisionSection(track,hist)')<src.indexOf("+'<div id=\"nextfy-slider-container\""));
// Date order can disagree with observation order when the cached trading date lags.
const unordered=[
  {date:'2026-09-08',nextFYEps:15.52,multiple:14.5},
  {date:'2026-09-11',nextFYEps:15.57,multiple:14.2},
  {date:'2026-09-11',nextFYEps:15.52,multiple:14.2},
  {date:'2026-09-10',nextFYEps:15.57,multiple:14.0},
  {date:'2026-09-15',nextFYEps:15.61,multiple:13.6}
];
const snapshot=JSON.stringify(unordered);
const sorted=ctx._nextFYRevisionRows(unordered);
assert.deepEqual(Array.from(sorted,r=>r.date),['2026-09-15','2026-09-11','2026-09-11','2026-09-10','2026-09-08']);
assert.equal(sorted[1].eps,15.52); // later of the two Sep 11 observations first
assert.equal(sorted[2].eps,15.57);
assert(Math.abs(sorted[1].delta+0.05)<1e-10);
assert(Math.abs(sorted[2].delta-0.05)<1e-10);
assert(Math.abs(sorted[3].delta-0.05)<1e-10); // delta follows recording order, not display order
assert.equal(JSON.stringify(unordered),snapshot); // never mutate stored history
const rendered=ctx._nextFYRevisionTable(unordered);
assert(rendered.indexOf('2026-09-10')>rendered.lastIndexOf('2026-09-11'));
console.log('Next-FY revision tests passed');
