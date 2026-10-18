// Build 541: exercise the actual sync function, not a reimplementation.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../js/options.js'),'utf8');
const ui=fs.readFileSync(path.join(__dirname,'../js/ui.js'),'utf8');
const ticker=fs.readFileSync(path.join(__dirname,'../js/ticker.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function extract(name){
 const start=src.indexOf('function '+name+'(');assert(start>=0,name);
 let depth=0,quote='',escape=false,comment='';const open=src.indexOf('{',start);
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
 throw Error('Unclosed '+name);
}
const detail={open:true};let htmlOutput='',renderCalls=[];
const container={querySelector:()=>detail};
const dom={
 'options-ticker-select':{value:'NVDA'},
 'options-freshness-container':container
};
const ctx=vm.createContext({document:{getElementById:id=>dom[id]},lastOptionsTickerLoaded:'NVDA',currentExpirations:['2026-11-20','2026-12-18'],_optionsFreshnessFailures:['2026-12-18'],_renderOptionsFreshness:(t,ex,fail)=>{renderCalls.push([t,[...ex],[...fail]]);detail.open=false;}});
vm.runInContext(extract('_syncOptionsFreshness'),ctx);
ctx._syncOptionsFreshness();
assert.equal(renderCalls.length,1);assert.equal(renderCalls[0][0],'NVDA');assert.deepEqual(renderCalls[0][1],['2026-11-20','2026-12-18']);assert.deepEqual(renderCalls[0][2],['2026-12-18']);assert.equal(detail.open,true,'expanded state retained');
detail.open=false;ctx._syncOptionsFreshness();assert.equal(detail.open,false,'collapsed state retained');
dom['options-ticker-select'].value='AAPL';ctx._syncOptionsFreshness();assert.equal(renderCalls.length,2,'wrong ticker never rendered');
dom['options-ticker-select'].value='NVDA';ctx.lastOptionsTickerLoaded='AAPL';ctx._syncOptionsFreshness();assert.equal(renderCalls.length,2,'in-flight ticker change guarded');
ctx.lastOptionsTickerLoaded='NVDA';ctx.currentExpirations=[];ctx._syncOptionsFreshness();assert.equal(renderCalls.length,2,'no loaded expirations guarded');
assert.match(ui,/else\{restoreOIChartFromCache\(\);_syncOptionsFreshness\(\);\}/,'same-ticker tab navigation syncs cache');
assert.match(ticker,/if\(document\.getElementById\('options-ticker-select'\)\?\.value===t\)_syncOptionsFreshness\(\)/,'manual ticker refresh synchronizes visible options');
assert.match(html,/if\(_activeTabName==='options'\)_syncOptionsFreshness\(\)/,'relative ages refresh periodically');
assert.match(src,/_optionsFreshnessFailures=_failedExpirations/,'failure details preserved for age refresh');
console.log('Options freshness synchronization tests passed');
