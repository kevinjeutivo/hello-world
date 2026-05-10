// PutSeller Pro -- income.js
// Income Engine tab: three-layer blended yield calculator.
// Layer 1: T-Bills + FDLXX (state-TEY) + SPAXX
// Layer 2: SPYI + NBOS (TTM yield from ETF cache)
// Layer 3: Written puts (target APY on notional) + CC stock (target APY on value)
// Globals used: WORKER_URL, S, offlineMode
// Dependencies: helpers.js, storage.js

const INCOME_STORAGE_KEY   = 'income_inputs';
const INCOME_MMF_CACHE_KEY = 'income_mmf_yields';
const INCOME_MMF_TTL_HRS   = 24;
const CA_STATE_TAX_RATE    = 0.093; // CA MFJ $200-300K bracket

// ── Colour tokens matching Market tab Income Engine Summary ───────────────────
const L1_BG     = 'rgba(33,150,243,0.1)';
const L1_BORDER = 'rgba(33,150,243,0.3)';
const L1_TEXT   = '#64b5f6';
const L2_BG     = 'rgba(255,107,53,0.1)';
const L2_BORDER = 'rgba(255,107,53,0.3)';
const L2_TEXT   = '#ff6b35';
const L3_BG     = 'rgba(0,212,170,0.1)';
const L3_BORDER = 'rgba(0,212,170,0.3)';
const L3_TEXT   = '#00d4aa';

// ── Input persistence ─────────────────────────────────────────────────────────

function _defaultIncomeInputs(){
  return{
    tbillAmt:0,fdlxxAmt:0,spaxxAmt:0,
    spyiShares:0,nbosShares:0,
    putsNotional:0,ccStockAmt:0,
    fdlxxYieldManual:null,
    spaxxYieldManual:null,
  };
}

function _loadIncomeInputs(){
  return{..._defaultIncomeInputs(),...(S.get(INCOME_STORAGE_KEY)||{})};
}

function _saveIncomeInputs(){
  const existing=S.get(INCOME_STORAGE_KEY)||{};
  const inp={
    tbillAmt:    _numVal('inc-tbill-amt'),
    fdlxxAmt:    _numVal('inc-fdlxx-amt'),
    spaxxAmt:    _numVal('inc-spaxx-amt'),
    spyiShares:  _numVal('inc-spyi-shares'),
    nbosShares:  _numVal('inc-nbos-shares'),
    putsNotional:_numVal('inc-puts-notional'),
    ccStockAmt:  _numVal('inc-cc-stock-amt'),
    // Preserve manual yield overrides
    fdlxxYieldManual:existing.fdlxxYieldManual??null,
    spaxxYieldManual:existing.spaxxYieldManual??null,
  };
  S.set(INCOME_STORAGE_KEY,inp);
  return inp;
}

function _saveManualYields(){
  // Called when user edits the manual yield fields in the rendered output
  const existing=S.get(INCOME_STORAGE_KEY)||{};
  const fdlxxEl=document.getElementById('inc-fdlxx-yield-manual');
  const spaxxEl=document.getElementById('inc-spaxx-yield-manual');
  if(fdlxxEl){const v=parseFloat(fdlxxEl.value);existing.fdlxxYieldManual=isNaN(v)||v<=0?null:v;}
  if(spaxxEl){const v=parseFloat(spaxxEl.value);existing.spaxxYieldManual=isNaN(v)||v<=0?null:v;}
  S.set(INCOME_STORAGE_KEY,existing);
  recalcIncome();
}

function _numVal(id){
  const el=document.getElementById(id);
  return el?Math.max(0,parseFloat(el.value.replace(/,/g,''))||0):0;
}

function _fillInputs(inp){
  const set=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v||0;};
  set('inc-tbill-amt',    inp.tbillAmt);
  set('inc-fdlxx-amt',    inp.fdlxxAmt);
  set('inc-spaxx-amt',    inp.spaxxAmt);
  set('inc-spyi-shares',  inp.spyiShares);
  set('inc-nbos-shares',  inp.nbosShares);
  set('inc-puts-notional',inp.putsNotional);
  set('inc-cc-stock-amt', inp.ccStockAmt);
}

// ── Money-market yield fetch ──────────────────────────────────────────────────
// Three attempts in order:
//   1. Yahoo summaryDetail module (yield field)
//   2. Yahoo dividends history -- TTM distributions / current NAV
//   3. Manual entry fallback

async function _fetchMMFYieldSummary(ticker){
  const r=await fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(ticker)}&type=summary&modules=summaryDetail`);
  if(!r.ok)throw new Error(`Worker ${r.status}`);
  const d=await r.json();
  const raw=d?.quoteSummary?.result?.[0]?.summaryDetail?.yield?.raw;
  if(raw==null||raw===0)throw new Error('No yield in summaryDetail');
  return raw*100;
}

async function _fetchMMFYieldFromDividends(ticker){
  const[divResp,quoteResp]=await Promise.all([
    fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(ticker)}&type=dividends&range=1y`),
    fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(ticker)}&type=quote`)
  ]);
  if(!divResp.ok||!quoteResp.ok)throw new Error('Fetch failed');
  const[divData,quoteData]=await Promise.all([divResp.json(),quoteResp.json()]);
  const events=divData?.chart?.result?.[0]?.events?.dividends;
  const price=quoteData?.quoteResponse?.result?.[0]?.regularMarketPrice;
  if(!events||!price)throw new Error('Missing div or price data');
  const oneYearAgo=Date.now()/1000-365*86400;
  const total=Object.values(events)
    .filter(d=>d.date>=oneYearAgo)
    .reduce((s,d)=>s+(d.amount||0),0);
  if(total<=0)throw new Error('No distributions in trailing 12 months');
  return(total/price*100);
}

async function _fetchMMFYieldLive(ticker){
  try{return await _fetchMMFYieldSummary(ticker);}
  catch(e1){
    console.warn(ticker+' summaryDetail failed:',e1.message);
    try{return await _fetchMMFYieldFromDividends(ticker);}
    catch(e2){
      console.warn(ticker+' dividends failed:',e2.message);
      throw new Error('All auto-fetch methods failed for '+ticker);
    }
  }
}

async function _getMMFYields(manualFdlxx,manualSpaxx){
  // Returns {fdlxx, spaxx, ts, fromCache, fdlxxManual, spaxxManual}
  const cached=S.get(INCOME_MMF_CACHE_KEY);
  if(cached?.fdlxx!=null&&cached?.spaxx!=null){
    const ageHrs=(Date.now()-new Date(cached.ts).getTime())/3600000;
    if(ageHrs<INCOME_MMF_TTL_HRS)
      return{...cached,fromCache:true,fdlxxManual:false,spaxxManual:false};
  }

  if(!navigator.onLine||offlineMode){
    if(cached)return{...cached,fromCache:true,fdlxxManual:false,spaxxManual:false};
    return{
      fdlxx:manualFdlxx,spaxx:manualSpaxx,ts:null,fromCache:false,
      fdlxxManual:manualFdlxx!=null,spaxxManual:manualSpaxx!=null
    };
  }

  let fdlxx=null,spaxx=null,fdlxxManual=false,spaxxManual=false;

  try{fdlxx=await _fetchMMFYieldLive('FDLXX');}
  catch{
    fdlxx=manualFdlxx!=null?manualFdlxx:(cached?.fdlxx??null);
    fdlxxManual=manualFdlxx!=null;
  }

  try{spaxx=await _fetchMMFYieldLive('SPAXX');}
  catch{
    spaxx=manualSpaxx!=null?manualSpaxx:(cached?.spaxx??null);
    spaxxManual=manualSpaxx!=null;
  }

  // Cache only auto-fetched values
  if(!fdlxxManual||!spaxxManual){
    const rec={
      fdlxx:fdlxxManual?(cached?.fdlxx??null):fdlxx,
      spaxx:spaxxManual?(cached?.spaxx??null):spaxx,
      ts:new Date().toISOString()
    };
    if(rec.fdlxx!=null||rec.spaxx!=null)S.set(INCOME_MMF_CACHE_KEY,rec);
  }

  return{fdlxx,spaxx,ts:new Date().toISOString(),fromCache:false,fdlxxManual,spaxxManual};
}

// ── T-bill yield ──────────────────────────────────────────────────────────────

function _getTBillYield(){
  const cd=S.get('tbills_cache');
  if(!cd?.tbill3m?.length)return null;
  return cd.tbill3m[cd.tbill3m.length-1].value;
}

// ── ETF yield helpers ─────────────────────────────────────────────────────────

function _getETFYield(ticker){
  const snap=S.get('snap_etf_'+ticker);
  const div=S.get('div_etf_'+ticker);
  if(!snap?.price||!div?.distributions)return{price:null,yld:null};
  const tot=div.distributions.slice(0,12).reduce((s,d)=>s+(d.amount||0),0);
  return{price:snap.price,yld:tot/snap.price*100};
}

// ── Target APY ────────────────────────────────────────────────────────────────

function _getTargetAPY(){
  const el=document.getElementById('target-apy');
  return parseFloat(el?.value)||12;
}

// ── Calculation engine ────────────────────────────────────────────────────────

function _calcIncome(inp,tbillYield,fdlxxYield,spaxxYield,spyiData,nbosData,targetAPY){
  const fdlxxTEY=fdlxxYield!=null?fdlxxYield/(1-CA_STATE_TAX_RATE):null;

  const tbillIncome=(inp.tbillAmt*(tbillYield??0))/100;
  const fdlxxIncome=(inp.fdlxxAmt*(fdlxxTEY??0))/100;
  const spaxxIncome=(inp.spaxxAmt*(spaxxYield??0))/100;
  const l1Capital  =inp.tbillAmt+inp.fdlxxAmt+inp.spaxxAmt;
  const l1Income   =tbillIncome+fdlxxIncome+spaxxIncome;
  const l1Yield    =l1Capital>0?l1Income/l1Capital*100:0;

  const l1Components=[
    {label:'T-Bills (3-month)', amt:inp.tbillAmt, yld:tbillYield, income:tbillIncome, note:null},
    {label:'FDLXX',             amt:inp.fdlxxAmt, yld:fdlxxTEY,   income:fdlxxIncome,
      note:fdlxxYield!=null?`Raw: ${fdlxxYield.toFixed(2)}% → TEY: ${fdlxxTEY.toFixed(2)}% (+${(fdlxxTEY-fdlxxYield).toFixed(2)}% CA benefit)`:null},
    {label:'SPAXX / Free cash', amt:inp.spaxxAmt, yld:spaxxYield, income:spaxxIncome, note:null},
  ];

  const spyiAmt   =spyiData.price!=null?inp.spyiShares*spyiData.price:0;
  const nbosAmt   =nbosData.price!=null?inp.nbosShares*nbosData.price:0;
  const spyiIncome=(spyiAmt*(spyiData.yld??0))/100;
  const nbosIncome=(nbosAmt*(nbosData.yld??0))/100;
  const l2Capital =spyiAmt+nbosAmt;
  const l2Income  =spyiIncome+nbosIncome;
  const l2Yield   =l2Capital>0?l2Income/l2Capital*100:0;

  const l2Components=[
    {label:'SPYI', amt:spyiAmt, shares:inp.spyiShares, price:spyiData.price, yld:spyiData.yld, income:spyiIncome},
    {label:'NBOS', amt:nbosAmt, shares:inp.nbosShares, price:nbosData.price, yld:nbosData.yld, income:nbosIncome},
  ];

  const putsIncome=(inp.putsNotional*targetAPY)/100;
  const ccIncome  =(inp.ccStockAmt*targetAPY)/100;
  const l3Income  =putsIncome+ccIncome;

  const l3Components=[
    {label:'Written puts (naked)', notional:inp.putsNotional, income:putsIncome, targetAPY},
    {label:'CC stock held',        notional:inp.ccStockAmt,   income:ccIncome,   targetAPY},
  ];

  const totalCapital =l1Capital+l2Capital;
  const totalIncome  =l1Income+l2Income+l3Income;
  const blendedYield =totalCapital>0?totalIncome/totalCapital*100:0;
  const l3Lift       =totalCapital>0?l3Income/totalCapital*100:0;

  return{
    l1:{capital:l1Capital,income:l1Income,yield:l1Yield,components:l1Components},
    l2:{capital:l2Capital,income:l2Income,yield:l2Yield,components:l2Components},
    l3:{income:l3Income,lift:l3Lift,components:l3Components,targetAPY},
    blended:{yield:blendedYield,capital:totalCapital,annualIncome:totalIncome,monthlyIncome:totalIncome/12},
    yields:{tbill:tbillYield,fdlxx:fdlxxYield,fdlxxTEY,spaxx:spaxxYield},
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function _fmtDollar(n){
  if(n==null||isNaN(n))return'--';
  if(Math.abs(n)>=1e6)return'$'+(n/1e6).toFixed(2)+'M';
  if(Math.abs(n)>=1e3)return'$'+n.toLocaleString('en-US',{maximumFractionDigits:0});
  return'$'+n.toFixed(2);
}
function _fmtPct(n,dec=2){return n==null||isNaN(n)?'--':n.toFixed(dec)+'%';}

function _manualYieldInput(id,savedVal,placeholder,fetchFailed){
  // Always rendered -- labeled as "override" when auto-fetch succeeded,
  // "failed" with amber warning when it did not.
  const val=savedVal!=null?savedVal:'';
  const borderColor=fetchFailed?'rgba(255,165,2,0.5)':'rgba(85,88,112,0.5)';
  const label=fetchFailed
    ?'<span style="font-family:var(--mono);font-size:10px;color:var(--warn)">&#x26A0; Auto-fetch failed — enter yield:</span>'
    :'<span style="font-family:var(--mono);font-size:10px;color:var(--text3)">Manual override (optional):</span>';
  return '<div style="display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap">'
    +label
    +'<div style="display:flex;align-items:center;gap:4px">'
    +'<input id="'+id+'" type="number" step="0.01" min="0" max="20" value="'+val+'" placeholder="'+placeholder+'"'
    +' style="width:72px;background:var(--surface2);border:1px solid '+borderColor+';border-radius:6px;'
    +'color:var(--text);font-family:var(--mono);font-size:13px;padding:5px 7px;outline:none"'
    +' oninput="_saveManualYields()">'
    +'<span style="font-family:var(--mono);font-size:11px;color:var(--text3)">%</span>'
    +'</div>'
    +'</div>';
}

function _layerCard({bg,border,accentColor,title,layerNum,capitalStr,yieldStr,incomeStr,components,note}){
  const rows=components.map(c=>{
    const yldStr=c.yld!=null?_fmtPct(c.yld):(c.targetAPY!=null?_fmtPct(c.targetAPY)+' target':'--');
    const amtStr=c.amt!=null?_fmtDollar(c.amt):(c.notional!=null?_fmtDollar(c.notional)+' notional':'--');
    const incStr=_fmtDollar(c.income);
    return'<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)">'
      +'<div style="display:flex;justify-content:space-between;align-items:flex-start">'
        +'<div style="flex:1">'
          +'<div style="font-family:var(--mono);font-size:11px;color:var(--text2)">'+c.label+'</div>'
          +(c.note?'<div style="font-family:var(--mono);font-size:9px;color:'+accentColor+';margin-top:1px">'+c.note+'</div>':'')
          +(c.shares!=null&&c.price!=null?'<div style="font-family:var(--mono);font-size:9px;color:var(--text3)">'+c.shares+' sh @ $'+c.price.toFixed(2)+'</div>':'')
        +'</div>'
        +'<div style="text-align:right;flex-shrink:0;margin-left:12px">'
          +'<div style="font-family:var(--mono);font-size:11px;color:var(--text2)">'+amtStr+'</div>'
          +'<div style="font-family:var(--mono);font-size:10px;color:'+accentColor+'">'+yldStr+'</div>'
          +'<div style="font-family:var(--mono);font-size:10px;color:var(--text3)">'+incStr+'/yr</div>'
        +'</div>'
      +'</div>'
      +(c.manualInput||'')
    +'</div>';
  }).join('');

  return'<div style="background:'+bg+';border:1px solid '+border+';border-left:4px solid '+border+';border-radius:var(--radius-lg);padding:14px;margin-bottom:10px">'
    +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">'
      +'<div>'
        +'<div style="font-family:var(--mono);font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">LAYER '+layerNum+'</div>'
        +'<div style="font-family:var(--sans);font-size:14px;font-weight:700;color:var(--text)">'+title+'</div>'
        +(capitalStr?'<div style="font-family:var(--mono);font-size:10px;color:var(--text3)">'+capitalStr+' deployed</div>':'')
      +'</div>'
      +'<div style="text-align:right">'
        +(yieldStr?'<div style="font-family:var(--mono);font-size:22px;font-weight:600;color:'+accentColor+'">'+yieldStr+'</div>':'')
        +(incomeStr?'<div style="font-family:var(--mono);font-size:10px;color:var(--text3)">'+incomeStr+'/yr</div>':'')
      +'</div>'
    +'</div>'
    +rows
    +(note?'<div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:8px;line-height:1.5">'+note+'</div>':'')
  +'</div>';
}

function _renderResults(result,mmfTs,mmfFromCache,mmfMeta){
  const{l1,l2,l3,blended}=result;
  const noCapital=blended.capital<=0;
  const inp=_loadIncomeInputs();
  const fdlxxNeedsManual=!!(mmfMeta?.fdlxxManual)||result.yields.fdlxx==null;
  const spaxxNeedsManual=!!(mmfMeta?.spaxxManual)||result.yields.spaxx==null;

  // ── Hero ──────────────────────────────────────────────────────────────────
  const heroHtml='<div style="background:linear-gradient(135deg,rgba(33,150,243,0.08),rgba(255,107,53,0.08),rgba(0,212,170,0.12));border:1px solid var(--border);border-radius:var(--radius-lg);padding:18px;margin-bottom:12px;text-align:center">'
    +'<div style="font-family:var(--mono);font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px">Blended Income Engine Yield</div>'
    +(noCapital
      ?'<div style="font-family:var(--mono);font-size:14px;color:var(--text3)">Enter amounts below to calculate</div>'
      :'<div style="font-family:var(--mono);font-size:48px;font-weight:700;color:var(--text);line-height:1">'+_fmtPct(blended.yield)+'</div>'
      +'<div style="font-family:var(--mono);font-size:11px;color:var(--text3);margin-top:4px">annualized blended yield on '+_fmtDollar(blended.capital)+' capital</div>'
      +'<div style="display:flex;justify-content:center;gap:24px;margin-top:14px">'
        +'<div><div style="font-family:var(--mono);font-size:10px;color:var(--text3)">Annual income</div>'
        +'<div style="font-family:var(--mono);font-size:20px;font-weight:600;color:var(--text)">'+_fmtDollar(blended.annualIncome)+'</div></div>'
        +'<div style="width:1px;background:var(--border)"></div>'
        +'<div><div style="font-family:var(--mono);font-size:10px;color:var(--text3)">Monthly income</div>'
        +'<div style="font-family:var(--mono);font-size:20px;font-weight:600;color:var(--accent)">'+_fmtDollar(blended.monthlyIncome)+'</div></div>'
      +'</div>'
      +(l3.income>0?'<div style="font-family:var(--mono);font-size:10px;color:'+L3_TEXT+';margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">Options overlay adds +'+_fmtPct(l3.lift)+' lift on total capital ('+_fmtDollar(l3.income)+'/yr in premium income)</div>':'')
    )
  +'</div>';

  // ── Layer 1 with manual fallbacks ─────────────────────────────────────────
  const l1ComponentsWithFallback=l1.components.map(c=>{
    if(c.label==='FDLXX'){
      // yld: use auto-fetched TEY if available, otherwise manual TEY
      const manualTEY=inp.fdlxxYieldManual!=null?inp.fdlxxYieldManual/(1-CA_STATE_TAX_RATE):null;
      const displayYld=c.yld!=null?c.yld:manualTEY;
      return{...c,yld:displayYld,
        manualInput:_manualYieldInput('inc-fdlxx-yield-manual',inp.fdlxxYieldManual,'e.g. 4.50',fdlxxNeedsManual)};
    }
    if(c.label==='SPAXX / Free cash'){
      // yld: use auto-fetched yield if available, otherwise manual
      const displayYld=c.yld!=null?c.yld:(inp.spaxxYieldManual??null);
      return{...c,yld:displayYld,
        manualInput:_manualYieldInput('inc-spaxx-yield-manual',inp.spaxxYieldManual,'e.g. 4.25',spaxxNeedsManual)};
    }
    return c;
  });

  const mmfStatusNote=(()=>{
    const parts=['FDLXX yield shown as CA state tax-equivalent (raw ÷ (1 − 9.3%)).'];
    parts.push('T-bill yield sourced from Market tab cache (^IRX).');
    if(!fdlxxNeedsManual&&!spaxxNeedsManual&&mmfTs){
      parts.push('MMF yields: '+(mmfFromCache?'cached':'live')+' as of '
        +new Date(mmfTs).toLocaleDateString('en-US',{month:'short',day:'numeric'})+'.');
    }
    if(fdlxxNeedsManual||spaxxNeedsManual){
      const which=fdlxxNeedsManual&&spaxxNeedsManual?'FDLXX and SPAXX':fdlxxNeedsManual?'FDLXX':'SPAXX';
      parts.push('Auto-fetch unavailable for '+which+' — enter yield % manually above, or tap Refresh Yields to retry. Check fidelity.com for current 7-day yield.');
    }
    return parts.join(' ');
  })();

  const l1Card=_layerCard({
    bg:L1_BG,border:L1_BORDER,accentColor:L1_TEXT,
    layerNum:1,title:'Fixed Income',
    capitalStr:_fmtDollar(l1.capital),
    yieldStr:l1.capital>0?_fmtPct(l1.yield):null,
    incomeStr:l1.capital>0?_fmtDollar(l1.income):null,
    components:l1ComponentsWithFallback,
    note:mmfStatusNote,
  });

  // ── Layer 2 ───────────────────────────────────────────────────────────────
  const l2MissingPrice=l2.components.some(c=>c.price==null&&
    (c.label==='SPYI'?_numVal('inc-spyi-shares')>0:_numVal('inc-nbos-shares')>0));
  const l2Card=_layerCard({
    bg:L2_BG,border:L2_BORDER,accentColor:L2_TEXT,
    layerNum:2,title:'ETF Income (SPYI / NBOS)',
    capitalStr:l2.capital>0?_fmtDollar(l2.capital):null,
    yieldStr:l2.capital>0?_fmtPct(l2.yield):null,
    incomeStr:l2.capital>0?_fmtDollar(l2.income):null,
    components:l2.components,
    note:l2MissingPrice
      ?'&#x26A0;&#xFE0F; ETF price not cached — visit the ETF tab and refresh to populate.'
      :'TTM distribution yield sourced from ETF tab cache.',
  });

  // ── Layer 3 ───────────────────────────────────────────────────────────────
  const l3Card='<div style="background:'+L3_BG+';border:1px solid '+L3_BORDER+';border-left:4px solid '+L3_BORDER+';border-radius:var(--radius-lg);padding:14px;margin-bottom:10px">'
    +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">'
      +'<div>'
        +'<div style="font-family:var(--mono);font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">LAYER 3</div>'
        +'<div style="font-family:var(--sans);font-size:14px;font-weight:700;color:var(--text)">Wheel Strategy</div>'
        +'<div style="font-family:var(--mono);font-size:10px;color:var(--text3)">Options overlay — premium income only</div>'
      +'</div>'
      +'<div style="text-align:right">'
        +'<div style="font-family:var(--mono);font-size:22px;font-weight:600;color:'+L3_TEXT+'">+'+_fmtPct(l3.lift)+' lift</div>'
        +'<div style="font-family:var(--mono);font-size:10px;color:var(--text3)">on total capital</div>'
      +'</div>'
    +'</div>'
    +l3.components.map(c=>'<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)">'
      +'<div>'
        +'<div style="font-family:var(--mono);font-size:11px;color:var(--text2)">'+c.label+'</div>'
        +'<div style="font-family:var(--mono);font-size:9px;color:var(--text3)">'+_fmtDollar(c.notional)+' notional @ '+_fmtPct(c.targetAPY)+' target</div>'
      +'</div>'
      +'<div style="text-align:right"><div style="font-family:var(--mono);font-size:11px;color:'+L3_TEXT+'">'+_fmtDollar(c.income)+'/yr</div></div>'
    +'</div>').join('')
    +'<div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:8px;line-height:1.5">'
      +'Premium income uses configured target APY ('+_fmtPct(l3.targetAPY)+'). '
      +'Notional for puts and CC stock excluded from capital denominator — collateral already counted in Layer 1.'
    +'</div>'
  +'</div>';

  return heroHtml+l1Card+l2Card+l3Card;
}

// ── Shared build + render ─────────────────────────────────────────────────────

function _buildAndRender(inp,mmf){
  const tbillYield=_getTBillYield();
  const spyiData  =_getETFYield('SPYI');
  const nbosData  =_getETFYield('NBOS');
  const targetAPY =_getTargetAPY();

  // Resolve effective yields: auto-fetched → manual override → null
  const fdlxxYield=mmf.fdlxx!=null?mmf.fdlxx
    :(inp.fdlxxYieldManual!=null?inp.fdlxxYieldManual:null);
  const spaxxYield=mmf.spaxx!=null?mmf.spaxx
    :(inp.spaxxYieldManual!=null?inp.spaxxYieldManual:null);

  const result=_calcIncome(inp,tbillYield,fdlxxYield,spaxxYield,spyiData,nbosData,targetAPY);
  const el=document.getElementById('income-results');
  if(el)el.innerHTML=_renderResults(result,mmf.ts,mmf.fromCache,mmf);
  S.set('income_ts',new Date().toISOString());
}

// ── Tab entry points ──────────────────────────────────────────────────────────

async function loadIncomeTab(){
  const el=document.getElementById('income-results');
  if(!el)return;
  const inp=_loadIncomeInputs();
  _fillInputs(inp);
  el.innerHTML='<div class="card"><div style="display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--text2)"><div class="spinner"></div>Fetching money market yields...</div></div>';
  const mmf=await _getMMFYields(inp.fdlxxYieldManual,inp.spaxxYieldManual);
  _buildAndRender(inp,mmf);
}

function restoreIncomeFromCache(){
  const inp=_loadIncomeInputs();
  _fillInputs(inp);
  const cached=S.get(INCOME_MMF_CACHE_KEY)||{fdlxx:null,spaxx:null,ts:null};
  const mmf={
    ...cached,fromCache:true,
    fdlxxManual:cached.fdlxx==null,
    spaxxManual:cached.spaxx==null
  };
  _buildAndRender(inp,mmf);
}

function recalcIncome(){
  const inp=_saveIncomeInputs();
  const cached=S.get(INCOME_MMF_CACHE_KEY)||{fdlxx:null,spaxx:null,ts:null};
  const mmf={
    ...cached,fromCache:true,
    fdlxxManual:cached.fdlxx==null,
    spaxxManual:cached.spaxx==null
  };
  _buildAndRender(inp,mmf);
}

function refreshIncomeYields(){
  S.del(INCOME_MMF_CACHE_KEY);
  loadIncomeTab();
}
