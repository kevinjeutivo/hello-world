// Build 539: tests the actual dashboard badge computation and DOM wiring.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const src=fs.readFileSync(path.join(__dirname,'../js/dashboard.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function extract(name){
  const start=src.indexOf('function '+name+'(');assert(start>=0,name);
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
  throw Error('Unclosed '+name);
}
const data={income_accounts_meta:[{id:'ira'},{id:'tax'}]};
const badge={style:{},setAttribute(k,v){this[k]=v;}};
const context=vm.createContext({
  S:{get:k=>data[k]},
  _posExpiryStatus:p=>p.status,
  _getPosPricing:p=>({currentPrice:p.price,itm:p.itm}),
  document:{getElementById:id=>id==='dash-risk-expiry-alert'?badge:null}
});
vm.runInContext(extract('_dashboardITMExpiryAlert')+'\n'+extract('_renderDashboardITMExpiryAlert'),context);
const put=(status,itm=true,price=100)=>({status,itm,price});
function check(label,fn){fn();console.log('PASS',label);}
check('no positions: hidden',()=>{context._renderDashboardITMExpiryAlert();assert.equal(badge.style.display,'none');});
check('3-7 days ITM across accounts: amber count',()=>{
  data.income_ira_put_positions=[put('expiring-soon'),put('active'),put('expired-linger'),put('expiring-soon',false)];
  data.income_tax_cc_positions=[put('expiring-soon')];
  context._renderDashboardITMExpiryAlert();assert.equal(badge.textContent,'2');assert.equal(badge.style.background,'var(--warn)');
});
check('within 2 days: red takes precedence and counts all qualifying positions',()=>{
  data.income_tax_cc_positions.push(put('expiring-imminent'));
  context._renderDashboardITMExpiryAlert();assert.equal(badge.textContent,'3');assert.equal(badge.style.background,'var(--red)');assert.match(badge.title,/1 within 2 days/);
});
check('missing and invalid prices do not count',()=>{
  data.income_tax_cc_positions.push(put('expiring-imminent',true,null),put('expiring-imminent',true,NaN));
  context._renderDashboardITMExpiryAlert();assert.equal(badge.textContent,'3');
});
check('rolled/expired statuses do not count',()=>{
  data.income_ira_put_positions=[put('expired-linger'),put('remove')];data.income_tax_cc_positions=[];
  context._renderDashboardITMExpiryAlert();assert.equal(badge.style.display,'none');
});
check('button and UI refresh wiring exist',()=>{
  assert.match(html,/id="dash-risk-expiry-alert"/);
  assert.match(extract('_syncDashboardViewModeUI'),/_renderDashboardITMExpiryAlert\(\)/);
  assert.match(fs.readFileSync(path.join(__dirname,'../js/ui.js'),'utf8'),/if\(name==='dashboard'\)\{_syncDashboardViewModeUI\(\);\}/);
});
