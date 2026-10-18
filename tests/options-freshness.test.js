const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../js/options.js'),'utf8');
function extract(name){const start=src.indexOf('function '+name+'(');assert(start>=0,name);let pos=src.indexOf('{',start),depth=0;for(let i=pos;i<src.length;i++){if(src[i]==='{')depth++;else if(src[i]==='}'&&!--depth)return src.slice(start,i+1);}throw Error('unclosed '+name);}
const records={
 'options_exp_NVDA_2026-12-18':{ts:'Dec fetched',tsEpoch:1000},
 'options_exp_NVDA_2026-11-20':{ts:'Nov fetched',tsEpoch:2000},
 'options_NVDA':{ts:'Metadata fetched',tsEpoch:3000},
 'snap_NVDA':{ts:'Price fetched',tsEpoch:4000}
};
const ctx=vm.createContext({S:{get:k=>records[k]},_recEpoch:r=>r?.tsEpoch??null,relAge:(s,e)=>e===1000?'1d ago':'2h ago',_escHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;'),Date});
for(const name of ['_optionsFreshnessModel','_optionsFreshnessHtml'])vm.runInContext(extract(name),ctx);
const model=ctx._optionsFreshnessModel('NVDA',['2026-12-18','2026-11-20']);
assert.deepEqual(Array.from(model.rows,r=>r.date),['2026-11-20','2026-12-18']);
assert.equal(model.rows[0].age,'2h ago');assert.equal(model.rows[1].age,'1d ago');
const html=ctx._optionsFreshnessHtml(model);
assert.match(html,/Nov 20: 2h ago · Dec 18: 1d ago/);
assert(html.indexOf('Nov fetched')<html.indexOf('Dec fetched'));
assert.match(html,/Expiration metadata/);assert.match(html,/Underlying price/);assert.match(html,/not when Yahoo updated individual option quotes/);
records['options_exp_NVDA_2026-12-18']={};
const missing=ctx._optionsFreshnessModel('NVDA',['2026-12-18']);assert.equal(missing.rows[0].age,'--');assert.match(ctx._optionsFreshnessHtml(missing),/Dec 18: --/);
assert.match(src,/_renderOptionsFreshness\(t,monthly,_failedExpirations\)/);
const index=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');assert.match(index,/id="options-freshness-container"/);
assert.equal((index.match(/id="options-freshness-container"/g)||[]).length,1);
console.log('Options freshness tests passed');
