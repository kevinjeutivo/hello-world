// PutSeller Pro -- income.js
// Income Engine tab: three-layer blended yield calculator.
// Layer 1: T-Bills + FDLXX (state-TEY) + SPAXX
// Layer 2: SPYI + NBOS (TTM yield from ETF cache)
// Layer 3: Written puts (target APY on notional) + CC stock (target APY on value)
// Globals used: WORKER_URL, S, offlineMode
// Dependencies: helpers.js, storage.js

const INCOME_STORAGE_KEY   = 'income_inputs';
const INCOME_MMF_CACHE_KEY = 'income_mmf_yields';
const INCOME_MMF_TTL_HRS   = 24;   // re-fetch money market yields after 24h
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
    tbillAmt:   0,
    fdlxxAmt:   0,
    spaxxAmt:   0,
    spyiShares: 0,
    nbosShares: 0,
    putsNotional: 0,
    ccStockAmt:   0,
  };
}

function _loadIncomeInputs(){
  return{..._defaultIncomeInputs(),...(S.get(INCOME_STORAGE_KEY)||{})};
}

function _saveIncomeInputs(){
  const inp={
    tbillAmt:    _numVal('inc-tbill-amt'),
    fdlxxAmt:    _numVal('inc-fdlxx-amt'),
    spaxxAmt:    _numVal('inc-spaxx-amt'),
    spyiShares:  _numVal('inc-spyi-shares'),
    nbosShares:  _numVal('inc-nbos-shares'),
    putsNotional:_numVal('inc-puts-notional'),
    ccStockAmt:  _numVal('inc-cc-stock-amt'),
  };
  S.set(INCOME_STORAGE_KEY,inp);
  return inp;
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

async function _fetchMMFYield(ticker){
  // Uses the worker's summary endpoint with defaultKeyStatistics module.
  // The `yield` field in defaultKeyStatistics is the 7-day SEC yield for MMFs.
  const r=await fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(ticker)}&type=summary&modules=defaultKeyStatistics`);
  if(!r.ok)throw new Error(`Worker ${r.status}`);
  const d=await r.json();
  const raw=d?.quoteSummary?.result?.[0]?.defaultKeyStatistics?.yield?.raw;
  if(raw==null)throw new Error('No yield data');
  return raw*100; // convert 0.0452 -> 4.52
}

async function _getMMFYields(){
  // Returns {fdlxx, spaxx, ts, fromCache} -- tries cache first, then live fetch.
  const cached=S.get(INCOME_MMF_CACHE_KEY);
  if(cached?.fdlxx!=null&&cached?.spaxx!=null){
    const ageHrs=(Date.now()-new Date(cached.ts).getTime())/3600000;
    if(ageHrs<INCOME_MMF_TTL_HRS)return{...cached,fromCache:true};
  }
  if(!navigator.onLine||offlineMode){
    if(cached)return{...cached,fromCache:true};
    return{fdlxx:null,spaxx:null,ts:null,fromCache:true};
  }
  // Fetch live
  let fdlxx=null,spaxx=null;
  try{fdlxx=await _fetchMMFYield('FDLXX');}catch(e){console.warn('FDLXX yield fetch failed:',e.message);}
  try{spaxx=await _fetchMMFYield('SPAXX');}catch(e){console.warn('SPAXX yield fetch failed:',e.message);}
  // Only cache if at least one succeeded
  if(fdlxx!=null||spaxx!=null){
    const rec={fdlxx,spaxx,ts:new Date().toISOString()};
    S.set(INCOME_MMF_CACHE_KEY,rec);
    return{...rec,fromCache:false};
  }
  // Fall back to older cache if live fetch totally failed
  if(cached)return{...cached,fromCache:true};
  return{fdlxx:null,spaxx:null,ts:null,fromCache:true};
}

// ── T-bill yield helper (from Market tab cache) ───────────────────────────────

function _getTBillYield(){
  const cd=S.get('tbills_cache');
  if(!cd?.tbill3m?.length)return null;
  return cd.tbill3m[cd.tbill3m.length-1].value; // already in percent
}

// ── ETF yield helpers (from ETF tab cache) ────────────────────────────────────

function _getETFYield(ticker){
  const snap=S.get('snap_etf_'+ticker);
  const div=S.get('div_etf_'+ticker);
  if(!snap?.price||!div?.distributions)return{price:null,yld:null};
  const tot=div.distributions.slice(0,12).reduce((s,d)=>s+(d.amount||0),0);
  return{price:snap.price,yld:tot/snap.price*100};
}

// ── Target APY (from Dashboard setting) ──────────────────────────────────────

function _getTargetAPY(){
  const el=document.getElementById('target-apy');
  return parseFloat(el?.value)||12;
}

// ── Calculation engine ────────────────────────────────────────────────────────

function _calcIncome(inp,tbillYield,fdlxxYield,spaxxYield,spyiData,nbosData,targetAPY){
  // Returns a result object with per-layer breakdown and blended totals.

  // State tax-equivalent yield: normalises FDLXX yield upward to remove
  // California state tax advantage, making it comparable to fully-taxable yields.
  // TEY = raw_yield / (1 - state_rate)
  const fdlxxTEY=fdlxxYield!=null?fdlxxYield/(1-CA_STATE_TAX_RATE):null;

  // ── Layer 1: Fixed income ─────────────────────────────────────────────────
  const tbillIncome   =(inp.tbillAmt   *(tbillYield ??0))/100;
  const fdlxxIncome   =(inp.fdlxxAmt   *(fdlxxTEY   ??0))/100;
  const spaxxIncome   =(inp.spaxxAmt   *(spaxxYield ??0))/100;
  const l1Capital     = inp.tbillAmt+inp.fdlxxAmt+inp.spaxxAmt;
  const l1Income      = tbillIncome+fdlxxIncome+spaxxIncome;
  const l1Yield       = l1Capital>0?l1Income/l1Capital*100:0;

  // Per-component breakdowns for display
  const l1Components=[
    {label:'T-Bills (3-month)',   amt:inp.tbillAmt,  yld:tbillYield,  income:tbillIncome, note:null},
    {label:'FDLXX',               amt:inp.fdlxxAmt,  yld:fdlxxTEY,    income:fdlxxIncome, note:fdlxxYield!=null?`Raw: ${fdlxxYield.toFixed(2)}% → TEY: ${fdlxxTEY.toFixed(2)}% (+${(fdlxxTEY-fdlxxYield).toFixed(2)}% CA benefit)`:null},
    {label:'SPAXX / Free cash',   amt:inp.spaxxAmt,  yld:spaxxYield,  income:spaxxIncome, note:null},
  ];

  // ── Layer 2: ETF income ───────────────────────────────────────────────────
  const spyiAmt  = spyiData.price!=null?inp.spyiShares*spyiData.price:0;
  const nbosAmt  = nbosData.price!=null?inp.nbosShares*nbosData.price:0;
  const spyiIncome=(spyiAmt*(spyiData.yld??0))/100;
  const nbosIncome=(nbosAmt*(nbosData.yld??0))/100;
  const l2Capital = spyiAmt+nbosAmt;
  const l2Income  = spyiIncome+nbosIncome;
  const l2Yield   = l2Capital>0?l2Income/l2Capital*100:0;

  const l2Components=[
    {label:'SPYI', amt:spyiAmt, shares:inp.spyiShares, price:spyiData.price, yld:spyiData.yld, income:spyiIncome},
    {label:'NBOS', amt:nbosAmt, shares:inp.nbosShares, price:nbosData.price, yld:nbosData.yld, income:nbosIncome},
  ];

  // ── Layer 3: Options premium ──────────────────────────────────────────────
  // Written puts: premium income = notional × target APY
  // CC stock: premium income = stock value × target APY
  // Neither adds to the capital denominator.
  const putsIncome =(inp.putsNotional*targetAPY)/100;
  const ccIncome   =(inp.ccStockAmt  *targetAPY)/100;
  const l3Income   = putsIncome+ccIncome;
  // L3 has no capital denominator contribution -- yield shown as lift on total capital

  const l3Components=[
    {label:'Written puts (naked)', notional:inp.putsNotional, income:putsIncome, targetAPY},
    {label:'CC stock held',        notional:inp.ccStockAmt,   income:ccIncome,   targetAPY},
  ];

  // ── Blended total ─────────────────────────────────────────────────────────
  // Denominator = L1 + L2 capital only (puts notional excluded per design)
  const totalCapital   = l1Capital+l2Capital;
  const totalIncome    = l1Income+l2Income+l3Income;
  const blendedYield   = totalCapital>0?totalIncome/totalCapital*100:0;
  const annualIncome   = totalIncome;
  const monthlyIncome  = totalIncome/12;

  // L3 as a standalone yield lift (premium ÷ total capital)
  const l3Lift = totalCapital>0?l3Income/totalCapital*100:0;

  return{
    l1:{capital:l1Capital,income:l1Income,yield:l1Yield,components:l1Components},
    l2:{capital:l2Capital,income:l2Income,yield:l2Yield,components:l2Components},
    l3:{income:l3Income,lift:l3Lift,components:l3Components,targetAPY},
    blended:{yield:blendedYield,capital:totalCapital,annualIncome,monthlyIncome},
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

function _layerCard({bg,border,accentColor,title,layerNum,capitalStr,yieldStr,incomeStr,components,note}){
  const rows=components.map(c=>{
    const yldStr=c.yld!=null?_fmtPct(c.yld):(c.targetAPY!=null?_fmtPct(c.targetAPY)+' target':'--');
    const amtStr=c.amt!=null?_fmtDollar(c.amt):(c.notional!=null?_fmtDollar(c.notional)+' notional':'--');
    const incStr=_fmtDollar(c.income);
    return'<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)">'
      +'<div>'
        +'<div style="font-family:var(--mono);font-size:11px;color:var(--text2)">'+c.label+'</div>'
        +(c.note?'<div style="font-family:var(--mono);font-size:9px;color:'+accentColor+';margin-top:1px">'+c.note+'</div>':'')
        +(c.shares!=null&&c.price!=null?'<div style="font-family:var(--mono);font-size:9px;color:var(--text3)">'+c.shares+' sh @ $'+c.price.toFixed(2)+'</div>':'')
      +'</div>'
      +'<div style="text-align:right;flex-shrink:0;margin-left:12px">'
        +'<div style="font-family:var(--mono);font-size:11px;color:var(--text2)">'+amtStr+'</div>'
        +'<div style="font-family:var(--mono);font-size:10px;color:'+accentColor+'">'+yldStr+'</div>'
        +'<div style="font-family:var(--mono);font-size:10px;color:var(--text3)">'+incStr+'/yr</div>'
      +'</div>'
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

function _renderResults(result,mmfTs,mmfFromCache){
  const{l1,l2,l3,blended,yields}=result;

  const noCapital=blended.capital<=0;

  // ── Hero blended yield ────────────────────────────────────────────────────
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
      +(l3.income>0?'<div style="font-family:var(--mono);font-size:10px;color:'+L3_TEXT+';margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">Options overlay adds +'+_fmtPct(l3.lift)+' lift on total capital ('
        +_fmtDollar(l3.income)+'/yr in premium income)</div>':'')
    )
  +'</div>';

  // ── Layer 1 ───────────────────────────────────────────────────────────────
  const l1Card=_layerCard({
    bg:L1_BG,border:L1_BORDER,accentColor:L1_TEXT,
    layerNum:1,title:'Fixed Income',
    capitalStr:_fmtDollar(l1.capital),
    yieldStr:l1.capital>0?_fmtPct(l1.yield):null,
    incomeStr:l1.capital>0?_fmtDollar(l1.income):null,
    components:l1.components,
    note:'FDLXX yield shown as CA state tax-equivalent (raw ÷ (1 − 9.3%)) — normalised against fully-taxable yields. T-bill yield sourced from Market tab cache (^IRX).'
      +(mmfTs?(' MMF yields: '+(mmfFromCache?'cached':'live')+' as of '+new Date(mmfTs).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+'.'):''),
  });

  // ── Layer 2 ───────────────────────────────────────────────────────────────
  const l2MissingPrice=l2.components.some(c=>c.price==null&&(c.label==='SPYI'?_numVal('inc-spyi-shares')>0:_numVal('inc-nbos-shares')>0));
  const l2Card=_layerCard({
    bg:L2_BG,border:L2_BORDER,accentColor:L2_TEXT,
    layerNum:2,title:'ETF Income (SPYI / NBOS)',
    capitalStr:l2.capital>0?_fmtDollar(l2.capital):null,
    yieldStr:l2.capital>0?_fmtPct(l2.yield):null,
    incomeStr:l2.capital>0?_fmtDollar(l2.income):null,
    components:l2.components,
    note:l2MissingPrice?'&#x26A0;&#xFE0F; ETF price not cached — visit the ETF tab and refresh to populate.'
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
      +'<div style="text-align:right">'
        +'<div style="font-family:var(--mono);font-size:11px;color:'+L3_TEXT+'">'+_fmtDollar(c.income)+'/yr</div>'
      +'</div>'
    +'</div>').join('')
    +'<div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:8px;line-height:1.5">'
      +'Premium income uses configured target APY ('+_fmtPct(l3.targetAPY)+'). '
      +'Notional for puts and stock value for CC writing are excluded from the capital denominator — '
      +'the collateral backing puts (T-bills, FDLXX, SPAXX) is already counted in Layer 1.'
    +'</div>'
  +'</div>';

  return heroHtml+l1Card+l2Card+l3Card;
}

// ── Tab entry points ──────────────────────────────────────────────────────────

async function loadIncomeTab(){
  const el=document.getElementById('income-results');
  if(!el)return;

  // Fill inputs from localStorage before showing spinner
  const inp=_loadIncomeInputs();
  _fillInputs(inp);

  el.innerHTML='<div class="card"><div style="display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--text2)"><div class="spinner"></div>Fetching money market yields...</div></div>';

  // Fetch/cache MMF yields
  const mmf=await _getMMFYields();

  // Pull everything else from cache
  const tbillYield=_getTBillYield();
  const spyiData=_getETFYield('SPYI');
  const nbosData=_getETFYield('NBOS');
  const targetAPY=_getTargetAPY();

  const result=_calcIncome(inp,tbillYield,mmf.fdlxx,mmf.spaxx,spyiData,nbosData,targetAPY);
  el.innerHTML=_renderResults(result,mmf.ts,mmf.fromCache);

  // Store last-rendered ts for the ts chip
  S.set('income_ts',new Date().toISOString());
}

function restoreIncomeFromCache(){
  // Called by showTab on tab switch -- fills inputs and recalculates from
  // cached data without a network fetch.
  const inp=_loadIncomeInputs();
  _fillInputs(inp);

  const el=document.getElementById('income-results');
  if(!el)return;

  const mmf=S.get(INCOME_MMF_CACHE_KEY)||{fdlxx:null,spaxx:null,ts:null};
  const tbillYield=_getTBillYield();
  const spyiData=_getETFYield('SPYI');
  const nbosData=_getETFYield('NBOS');
  const targetAPY=_getTargetAPY();

  const result=_calcIncome(inp,tbillYield,mmf.fdlxx,mmf.spaxx,spyiData,nbosData,targetAPY);
  el.innerHTML=_renderResults(result,mmf.ts,true);
}

function recalcIncome(){
  // Called by the Calculate button and on any input change.
  // Saves inputs then recalculates from cache -- no network fetch.
  const inp=_saveIncomeInputs();
  const el=document.getElementById('income-results');
  if(!el)return;

  const mmf=S.get(INCOME_MMF_CACHE_KEY)||{fdlxx:null,spaxx:null,ts:null};
  const tbillYield=_getTBillYield();
  const spyiData=_getETFYield('SPYI');
  const nbosData=_getETFYield('NBOS');
  const targetAPY=_getTargetAPY();

  const result=_calcIncome(inp,tbillYield,mmf.fdlxx,mmf.spaxx,spyiData,nbosData,targetAPY);
  el.innerHTML=_renderResults(result,mmf.ts,true);
}

function refreshIncomeYields(){
  // Called by the Refresh Yields button -- forces a live MMF fetch then recalcs.
  S.del(INCOME_MMF_CACHE_KEY);
  loadIncomeTab();
}
