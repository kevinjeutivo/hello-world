// PutSeller Pro -- income.js
// Income Engine tab: N-account wheel strategy tracker.
// Layer 1: T-Bills + FDLXX (state-TEY) + SPAXX
// Layer 2: SPYI + NBOS (TTM yield from ETF cache)
// Layer 3: Written puts + Covered calls (target APY on notional/stock value)
// Globals used: WORKER_URL, S, offlineMode
// Dependencies: helpers.js, storage.js

const INCOME_MMF_TTL_HRS   = 24;
const CA_STATE_TAX_RATE    = 0.093; // CA MFJ $200-300K bracket

// ── Account color palette (8 colors, assigned by creation order) ──────────────
const ACCT_COLORS = [
  '#00d4aa', // 1 teal   (--accent)    Taxable
  '#ff6b35', // 2 orange (--accent2)   Rollover IRA
  '#7c6af7', // 3 purple (--accent3)   Roth IRA
  '#64b5f6', // 4 blue
  '#ffd32a', // 5 yellow (--yellow)
  '#00c896', // 6 green  (--green)
  '#f06292', // 7 pink   (avoids red which signals warnings)
  '#ffa502', // 8 amber  (--warn)
];

// ── Account metadata ──────────────────────────────────────────────────────────
// income_accounts_meta: [{id, name, color, createdAt}, ...]
// income_active_account: id string
// Per-account keys: income_ACCTID_inputs, income_ACCTID_mmf_yield,
//   income_ACCTID_put_positions, income_ACCTID_cc_positions

const ACCT_META_KEY   = 'income_accounts_meta';
const ACCT_ACTIVE_KEY = 'income_active_account';
const MIGRATION_FLAG  = 'income_migration_v1';

// Module-level active account ID -- set atomically on switch, used by all saves
let _activeAccountId = '';

function _acctKey(suffix){ return 'income_' + _activeAccountId + '_' + suffix; }
function _acctKeyFor(id, suffix){ return 'income_' + id + '_' + suffix; }

function _getAccounts(){
  return S.get(ACCT_META_KEY) || [];
}

function _saveAccounts(accounts){
  S.set(ACCT_META_KEY, accounts);
}

function _getActiveAccount(){
  const accounts = _getAccounts();
  return accounts.find(a => a.id === _activeAccountId) || accounts[0] || null;
}

function _acctColor(account){
  if(!account) return ACCT_COLORS[0];
  const accounts = _getAccounts();
  const idx = accounts.findIndex(a => a.id === account.id);
  return ACCT_COLORS[Math.max(0, idx) % ACCT_COLORS.length];
}

function _genAcctId(){
  return 'acct_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

// ── One-time migration from flat keys to per-account namespaced keys ──────────
// Called from init() in index.html -- runs once, then sets MIGRATION_FLAG.
// Safe to call multiple times: no-ops if flag already set.
// Also called after backup restore if old flat keys detected.

function runIncomeMigration(){
  if(S.get(MIGRATION_FLAG)) return;
  // Create default 3 accounts
  const acct1Id = _genAcctId();
  const acct2Id = _genAcctId();
  const acct3Id = _genAcctId();
  const now = new Date().toISOString();
  const accounts = [
    {id: acct1Id, name: 'Taxable',      createdAt: now},
    {id: acct2Id, name: 'Rollover IRA', createdAt: now},
    {id: acct3Id, name: 'Roth IRA',     createdAt: now},
  ];
  _saveAccounts(accounts);

  // Migrate existing flat-key data into Account 1 (Taxable)
  const oldInputs = S.get('income_inputs');
  if(oldInputs) S.set(_acctKeyFor(acct1Id, 'inputs'), oldInputs);

  const oldMMF = S.get('income_mmf_yields');
  if(oldMMF) S.set(_acctKeyFor(acct1Id, 'mmf_yield'), oldMMF);

  const oldPuts = S.get('put_positions');
  if(oldPuts) S.set(_acctKeyFor(acct1Id, 'put_positions'), oldPuts);

  const oldCC = S.get('cc_positions');
  if(oldCC) S.set(_acctKeyFor(acct1Id, 'cc_positions'), oldCC);

  // Set active account to Taxable
  S.set(ACCT_ACTIVE_KEY, acct1Id);

  // Run expired position cleanup across all accounts
  _cleanupAllAccountExpiredPositions(accounts);

  S.set(MIGRATION_FLAG, '1');
}

// Cleans up expired positions past linger window across ALL accounts.
// Called at migration time and can be called on init for ongoing hygiene.
function _cleanupAllAccountExpiredPositions(accounts){
  if(!accounts) accounts = _getAccounts();
  accounts.forEach(a => {
    try{
      const puts = S.get(_acctKeyFor(a.id, 'put_positions')) || [];
      const putKeep = puts.filter(p => _posExpiryStatus(p) !== 'remove');
      if(putKeep.length !== puts.length) S.set(_acctKeyFor(a.id, 'put_positions'), putKeep);

      const ccs = S.get(_acctKeyFor(a.id, 'cc_positions')) || [];
      const ccKeep = ccs.filter(p => _posExpiryStatus(p) !== 'remove');
      if(ccKeep.length !== ccs.length) S.set(_acctKeyFor(a.id, 'cc_positions'), ccKeep);
    }catch(e){ console.warn('Cleanup error for account', a.id, e?.message); }
  });
}

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

// ── Input persistence (per active account) ────────────────────────────────────

function _defaultIncomeInputs(){
  // targetAPY defaults to global dashboard value if set, else 12
  const globalAPY = parseFloat(document.getElementById('target-apy')?.value) || 12;
  return{
    tbillAmt:0, fdlxxAmt:0, spaxxAmt:0,
    spyiShares:0, nbosShares:0,
    putsNotional:0, ccStockAmt:0,
    fdlxxYieldManual:null,
    spaxxYieldManual:null,
    fdlxxUseManual:false,
    spaxxUseManual:false,
    targetAPY: globalAPY,
  };
}

function _loadIncomeInputs(){
  return{..._defaultIncomeInputs(),...(S.get(_acctKey('inputs'))||{})};
}

function _saveIncomeInputs(){
  const _saveKey = _acctKey('inputs'); // capture active account at save time
  const existing = S.get(_saveKey) || {};
  const inp={
    tbillAmt:    _numVal('inc-tbill-amt'),
    fdlxxAmt:    _numVal('inc-fdlxx-amt'),
    spaxxAmt:    _numVal('inc-spaxx-amt'),
    spyiShares:  _numVal('inc-spyi-shares'),
    nbosShares:  _numVal('inc-nbos-shares'),
    putsNotional:_numVal('inc-puts-notional'),
    ccStockAmt:  _numVal('inc-cc-stock-amt'),
    targetAPY:   parseFloat(document.getElementById('inc-target-apy')?.value) || 12,
    // Preserve manual yield overrides and toggle states
    fdlxxYieldManual:existing.fdlxxYieldManual??null,
    spaxxYieldManual:existing.spaxxYieldManual??null,
    fdlxxUseManual:existing.fdlxxUseManual??false,
    spaxxUseManual:existing.spaxxUseManual??false,
  };
  S.set(_saveKey, inp);
  return inp;
}

function _saveManualYields(){
  // Persist the entered values immediately.
  // Recalculation is triggered by onblur (when user taps outside the field)
  // rather than oninput, so the user can type freely without interruption.
  const _saveKey = _acctKey('inputs'); // capture active account at save time
  const existing = S.get(_saveKey) || {};
  const fdlxxEl=document.getElementById('inc-fdlxx-yield-manual');
  const spaxxEl=document.getElementById('inc-spaxx-yield-manual');
  if(fdlxxEl){const v=parseFloat(fdlxxEl.value);existing.fdlxxYieldManual=isNaN(v)||v<=0?null:v;}
  if(spaxxEl){const v=parseFloat(spaxxEl.value);existing.spaxxYieldManual=isNaN(v)||v<=0?null:v;}
  const fdlxxToggle=document.getElementById('inc-fdlxx-use-manual');
  const spaxxToggle=document.getElementById('inc-spaxx-use-manual');
  if(fdlxxToggle)existing.fdlxxUseManual=fdlxxToggle.checked;
  if(spaxxToggle)existing.spaxxUseManual=spaxxToggle.checked;
  S.set(_saveKey, existing);
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
  // Per-account target APY
  const apyEl = document.getElementById('inc-target-apy');
  if(apyEl) apyEl.value = inp.targetAPY || 12;
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

async function _getMMFYields(manualFdlxx, manualSpaxx){
  // Returns {fdlxx, spaxx, ts, fromCache, fdlxxManual, spaxxManual}
  // Cache key is per-account -- capture at call time to avoid race conditions
  const mmfKey = _acctKey('mmf_yield');
  const cached = S.get(mmfKey);
  if(cached?.fdlxx!=null && cached?.spaxx!=null){
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

  // Cache only auto-fetched values -- write to per-account key only
  if(!fdlxxManual||!spaxxManual){
    const rec={
      fdlxx:fdlxxManual?(cached?.fdlxx??null):fdlxx,
      spaxx:spaxxManual?(cached?.spaxx??null):spaxx,
      ts:new Date().toISOString()
    };
    if(rec.fdlxx!=null||rec.spaxx!=null) S.set(mmfKey, rec);
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

// ── Target APY (per-account) ──────────────────────────────────────────────────

function _getTargetAPY(){
  // Reads from the per-account APY field in the Income tab.
  // Falls back to global dashboard value if not set.
  const acctEl = document.getElementById('inc-target-apy');
  if(acctEl && parseFloat(acctEl.value) > 0) return parseFloat(acctEl.value);
  const globalEl = document.getElementById('target-apy');
  return parseFloat(globalEl?.value) || 12;
}

// ── Calculation engine ────────────────────────────────────────────────────────

function _calcIncome(inp,tbillYield,fdlxxYield,spaxxYield,spyiData,nbosData,targetAPY){
  const tbillTEY=tbillYield!=null?tbillYield/(1-CA_STATE_TAX_RATE):null;
  const fdlxxTEY=fdlxxYield!=null?fdlxxYield/(1-CA_STATE_TAX_RATE):null;

  const tbillIncome=(inp.tbillAmt*(tbillTEY??0))/100;
  const fdlxxIncome=(inp.fdlxxAmt*(fdlxxTEY??0))/100;
  const spaxxIncome=(inp.spaxxAmt*(spaxxYield??0))/100;
  const l1Capital  =inp.tbillAmt+inp.fdlxxAmt+inp.spaxxAmt;
  const l1Income   =tbillIncome+fdlxxIncome+spaxxIncome;
  const l1Yield    =l1Capital>0?l1Income/l1Capital*100:0;

  const l1Components=[
    {label:'T-Bills (3-month)', amt:inp.tbillAmt, yld:tbillTEY, income:tbillIncome,
      note:tbillYield!=null?`Raw: ${tbillYield.toFixed(2)}% → TEY: ${tbillTEY.toFixed(2)}% (+${(tbillTEY-tbillYield).toFixed(2)}% CA benefit)`:null},
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

  // Positions trackers override manual notional fields when positions exist
  const _posNotionalTotal=_activePosNotionalTotal();
  const _effectivePutsNotional=_posNotionalTotal>0?_posNotionalTotal:inp.putsNotional;
  const _ccNotionalTotal=_activeCCNotionalTotal();
  const _effectiveCCNotional=_ccNotionalTotal>0?_ccNotionalTotal:inp.ccStockAmt;
  const putsIncome=(_effectivePutsNotional*targetAPY)/100;
  const ccIncome  =(_effectiveCCNotional  *targetAPY)/100;
  const l3Income  =putsIncome+ccIncome;

  const l3Components=[
    {label:'Written puts (naked)', notional:_effectivePutsNotional, income:putsIncome, targetAPY, fromPositions:_posNotionalTotal>0},
    {label:'CC stock held',        notional:_effectiveCCNotional, income:ccIncome, targetAPY, fromCCPositions:_ccNotionalTotal>0},
  ];

  // CC stock is deployed capital (actually owned shares) so belongs in denominator.
  // Put notional stays excluded -- collateral already counted in Layer 1.
  const totalCapital =l1Capital+l2Capital+_effectiveCCNotional;
  const totalIncome  =l1Income+l2Income+l3Income;
  const blendedYield =totalCapital>0?totalIncome/totalCapital*100:0;
  const l3Lift       =totalCapital>0?l3Income/totalCapital*100:0;

  return{
    l1:{capital:l1Capital,income:l1Income,yield:l1Yield,components:l1Components},
    l2:{capital:l2Capital,income:l2Income,yield:l2Yield,components:l2Components},
    l3:{income:l3Income,lift:l3Lift,components:l3Components,targetAPY},
    blended:{yield:blendedYield,capital:totalCapital,annualIncome:totalIncome,monthlyIncome:totalIncome/12},
    yields:{tbill:tbillYield,tbillTEY,fdlxx:fdlxxYield,fdlxxTEY,spaxx:spaxxYield},
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

function _manualYieldInput(id,toggleId,savedVal,placeholder,fetchFailed,useManual,fetchedVal){
  // Always rendered.
  // When auto-fetch succeeded: shows toggle + dimmed/active input based on toggle state.
  // When auto-fetch failed: amber warning, input always active, no toggle needed.
  const val=savedVal!=null?savedVal:'';

  if(fetchFailed){
    // No fetched value -- input is always the only source, no toggle needed
    return '<div style="display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap">'
      +'<span style="font-family:var(--mono);font-size:10px;color:var(--warn)">&#x26A0; Auto-fetch failed — enter yield:</span>'
      +'<div style="display:flex;align-items:center;gap:4px">'
      +'<input id="'+id+'" type="number" step="0.01" min="0" max="20" value="'+val+'" placeholder="'+placeholder+'"'
      +' style="width:72px;background:var(--surface2);border:1px solid rgba(255,165,2,0.5);border-radius:6px;'
      +'color:var(--text);font-family:var(--mono);font-size:13px;padding:5px 7px;outline:none"'
      +' onblur="_saveManualYields()">'
      +'<span style="font-family:var(--mono);font-size:11px;color:var(--text3)">%</span>'
      +'</div></div>';
  }

  // Auto-fetch succeeded -- show toggle to optionally override
  const inputOpacity=useManual?'1':'0.35';
  const inputBorder=useManual?'rgba(255,165,2,0.6)':'rgba(85,88,112,0.4)';
  const activeLabel=useManual
    ?'<span style="font-family:var(--mono);font-size:10px;color:var(--warn);font-weight:600">Manual active</span>'
    :'<span style="font-family:var(--mono);font-size:10px;color:var(--text3)">Manual override:</span>';
  const fetchedDisplay=fetchedVal!=null?'<span style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-left:4px">(fetched: '+fetchedVal.toFixed(2)+'%)</span>':''

  return '<div style="margin-top:8px">'
    // Toggle row
    +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'
      +'<label style="position:relative;display:inline-block;width:36px;height:20px;flex-shrink:0">'
        +'<input type="checkbox" id="'+toggleId+'" '+( useManual?'checked':'' )+' style="opacity:0;width:0;height:0"'
        +' onchange="_saveManualYields()">'
        +'<span style="position:absolute;cursor:pointer;inset:0;background:'+( useManual?'var(--warn)':'var(--surface3)')+';'
        +'border-radius:20px;transition:0.2s">'
        +'<span style="position:absolute;height:14px;width:14px;left:'+( useManual?'19px':'3px')+';bottom:3px;'
        +'background:#fff;border-radius:50%;transition:0.2s"></span></span>'
      +'</label>'
      +activeLabel
      +fetchedDisplay
    +'</div>'
    // Input row
    +'<div style="display:flex;align-items:center;gap:4px">'
      +'<input id="'+id+'" type="number" step="0.01" min="0" max="20" value="'+val+'" placeholder="'+placeholder+'"'
      +' style="width:72px;background:var(--surface2);border:1px solid '+inputBorder+';border-radius:6px;'
      +'color:var(--text);font-family:var(--mono);font-size:13px;padding:5px 7px;outline:none;opacity:'+inputOpacity+'"'
      +' onblur="_saveManualYields()">'
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

function _renderResults(result,mmfTs,mmfFromCache,mmfMeta,rawFetched){
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
      const fetchedRaw=rawFetched?.fdlxx??null; // raw fetched yield (pre-TEY), always from MMF cache
      const manualTEY=inp.fdlxxYieldManual!=null?inp.fdlxxYieldManual/(1-CA_STATE_TAX_RATE):null;
      // Display TEY: if toggle active and manual set, use manualTEY; else use auto-fetched TEY
      const displayYld=(inp.fdlxxUseManual&&manualTEY!=null)?manualTEY:(c.yld??manualTEY);
      return{...c,yld:displayYld,
        manualInput:_manualYieldInput(
          'inc-fdlxx-yield-manual','inc-fdlxx-use-manual',inp.fdlxxYieldManual,'e.g. 4.50',
          fdlxxNeedsManual,inp.fdlxxUseManual,fetchedRaw)};
    }
    if(c.label==='SPAXX / Free cash'){
      const fetchedRaw=rawFetched?.spaxx??null;
      const displayYld=(inp.spaxxUseManual&&inp.spaxxYieldManual!=null)
        ?inp.spaxxYieldManual:(c.yld??(inp.spaxxYieldManual??null));
      return{...c,yld:displayYld,
        manualInput:_manualYieldInput(
          'inc-spaxx-yield-manual','inc-spaxx-use-manual',inp.spaxxYieldManual,'e.g. 4.25',
          spaxxNeedsManual,inp.spaxxUseManual,fetchedRaw)};
    }
    return c;
  });

  const mmfStatusNote=(()=>{
    const parts=['T-bills and FDLXX yields shown as CA state tax-equivalent (raw ÷ (1 − 9.3%)) — both are exempt from CA state income tax.'];
    parts.push('T-bill yield sourced from Market tab cache (^IRX). Refresh the Market tab to update it.');
    if(!fdlxxNeedsManual&&!spaxxNeedsManual&&mmfTs){
      parts.push('MMF yields: '+(mmfFromCache?'cached':'live')+' as of '
        +new Date(mmfTs).toLocaleDateString('en-US',{month:'short',day:'numeric'})+'.');
    }
    if(inp.fdlxxUseManual&&inp.fdlxxYieldManual!=null)parts.push('FDLXX: using your manual yield of '+inp.fdlxxYieldManual.toFixed(2)+'%.');
    if(inp.spaxxUseManual&&inp.spaxxYieldManual!=null)parts.push('SPAXX: using your manual yield of '+inp.spaxxYieldManual.toFixed(2)+'%.');
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
  const _posList=_renderPositionList();
  const _ccList=_renderCCPositionList();

  // Pre-compute sort toggle buttons outside string concat to avoid scoping issues
  const _pSm=_getPosSort();
  const _pBtnBase='font-family:var(--mono);font-size:9px;padding:3px 8px;border-radius:6px;border:1px solid var(--border);cursor:pointer;';
  const _pBtnA=_pBtnBase+'background:var(--accent);color:#000;';
  const _pBtnI=_pBtnBase+'background:var(--surface2);color:var(--text3);';
  const _putSortBtns=
    '<button style="'+(_pSm==='ticker'?_pBtnA:_pBtnI)+'" onclick="setPosSort(&quot;ticker&quot;)">By Ticker</button>'+
    '<button style="'+(_pSm==='expiry'?_pBtnA:_pBtnI)+'" onclick="setPosSort(&quot;expiry&quot;)">By Expiry</button>';

  const _cSm=_getCCSort();
  const _ccSortBtns=
    '<button style="'+(_cSm==='ticker'?_pBtnA:_pBtnI)+'" onclick="setCCSort(&quot;ticker&quot;)">By Ticker</button>'+
    '<button style="'+(_cSm==='expiry'?_pBtnA:_pBtnI)+'" onclick="setCCSort(&quot;expiry&quot;)">By Expiry</button>';

  const l3Card=
    '<div style="background:'+L3_BG+';border:1px solid '+L3_BORDER+';border-left:4px solid '+L3_BORDER+';border-radius:var(--radius-lg);padding:14px;margin-bottom:10px">'+
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">'+
        '<div>'+
          '<div style="font-family:var(--mono);font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:1px">LAYER 3</div>'+
          '<div style="font-family:var(--sans);font-size:14px;font-weight:700;color:var(--text)">Wheel Strategy</div>'+
          '<div style="font-family:var(--mono);font-size:10px;color:var(--text3)">Options overlay — premium income only</div>'+
        '</div>'+
        '<div style="text-align:right">'+
          '<div style="font-family:var(--mono);font-size:22px;font-weight:600;color:'+L3_TEXT+'">+'+_fmtPct(l3.lift)+' lift</div>'+
          '<div style="font-family:var(--mono);font-size:10px;color:var(--text3)">on total capital</div>'+
        '</div>'+
      '</div>'+
      // ── Put positions section ──────────────────────────────────────────────
      '<div style="border-top:1px solid rgba(0,212,170,0.15);padding-top:10px;margin-bottom:8px">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'+
          '<div style="font-family:var(--mono);font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px">Put Positions</div>'+
          '<div style="display:flex;align-items:center;gap:6px">'+
            '<div style="display:flex;gap:2px">'+_putSortBtns+'</div>'+
            '<button class="btn btn-secondary" style="font-size:10px;padding:3px 10px" onclick="_openAddPositionModal()">+ Add Position</button>'+
          '</div>'+
        '</div>'+
        _posList.html+
      '</div>'+
      // ── CC positions section ───────────────────────────────────────────────
      '<div style="border-top:1px solid rgba(255,107,53,0.2);padding-top:10px;margin-top:4px;margin-bottom:8px">'+
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'+
          '<div style="font-family:var(--mono);font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px">Covered Call Positions</div>'+
          '<div style="display:flex;align-items:center;gap:6px">'+
            '<div style="display:flex;gap:2px">'+_ccSortBtns+'</div>'+
            '<button class="btn btn-secondary" style="font-size:10px;padding:3px 10px" onclick="_openAddCCModal()">+ Add CC</button>'+
          '</div>'+
        '</div>'+
        _ccList.html+
      '</div>'+
      // ── Component income rows ──────────────────────────────────────────────
      l3.components.map(c=>
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px solid rgba(255,255,255,0.05)">'+
          '<div>'+
            '<div style="font-family:var(--mono);font-size:11px;color:var(--text2)">'+c.label+'</div>'+
            '<div style="font-family:var(--mono);font-size:9px;color:var(--text3)">'+_fmtDollar(c.notional)+' notional @ '+_fmtPct(c.targetAPY)+' target'+
              (c.fromPositions?' <span style="color:'+L3_TEXT+'">&#x2713; from put positions</span>':'')+
              (c.fromCCPositions?' <span style="color:'+L2_TEXT+'">&#x2713; from CC positions</span>':'')+
            '</div>'+
          '</div>'+
          '<div style="text-align:right">'+
            '<div style="font-family:var(--mono);font-size:11px;color:'+L3_TEXT+'">'+_fmtDollar(c.income)+'/yr</div>'+
          '</div>'+
        '</div>'
      ).join('')+
      '<div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:8px;line-height:1.5">'+
        'Premium income uses configured target APY ('+_fmtPct(l3.targetAPY)+'). '+
        'Put notional excluded from capital denominator — collateral already counted in Layer 1. CC stock notional included in denominator as deployed capital. '+
        (l3.components[0]?.fromPositions?'Notional derived from position tracker.':'Manual notional used — add positions above to auto-calculate.')+
      '</div>'+
    '</div>';

  return heroHtml+l1Card+l2Card+l3Card;
}

// ── Shared build + render ─────────────────────────────────────────────────────

function _buildAndRender(inp,mmf){
  const tbillYield=_getTBillYield();
  const spyiData  =_getETFYield('SPYI');
  const nbosData  =_getETFYield('NBOS');
  const targetAPY =_getTargetAPY();

  // Resolve effective yields respecting toggle state:
  //   auto-fetch failed → manual is only option
  //   auto-fetch succeeded + toggle on → manual overrides fetched
  //   auto-fetch succeeded + toggle off → use fetched value
  const fdlxxFetched=mmf.fdlxx;
  const spaxxFetched=mmf.spaxx;
  const fdlxxYield=(fdlxxFetched==null)
    ?(inp.fdlxxYieldManual??null)
    :(inp.fdlxxUseManual&&inp.fdlxxYieldManual!=null?inp.fdlxxYieldManual:fdlxxFetched);
  const spaxxYield=(spaxxFetched==null)
    ?(inp.spaxxYieldManual??null)
    :(inp.spaxxUseManual&&inp.spaxxYieldManual!=null?inp.spaxxYieldManual:spaxxFetched);

  const result=_calcIncome(inp,tbillYield,fdlxxYield,spaxxYield,spyiData,nbosData,targetAPY);
  const el=document.getElementById('income-results');
  if(el)el.innerHTML=_renderResults(result,mmf.ts,mmf.fromCache,mmf,{fdlxx:mmf.fdlxx,spaxx:mmf.spaxx});
}

function refreshIncomeYields(){
  // Delete only the active account's MMF yield cache, then reload
  S.del(_acctKey('mmf_yield'));
  loadIncomeTab();
}

function _updateAcctBarStickyTop(){
  // Bar uses position:fixed (outside #app's zoom context).
  // Top must be set in viewport pixels using getBoundingClientRect,
  // which correctly accounts for CSS zoom on #app.
  // Also pad .main top so income tab content isn't hidden under the fixed bar.
  try{
    const nav = document.querySelector('.nav-tabs');
    const bar = document.getElementById('income-acct-bar');
    const main = document.querySelector('.main');
    if(nav && bar){
      const navBottom = nav.getBoundingClientRect().bottom;
      bar.style.top = navBottom + 'px';
      // Add top padding to .main equal to bar height so content isn't obscured
      if(main && bar.style.display !== 'none'){
        const barH = bar.offsetHeight || 44;
        main.style.paddingTop = barH + 'px';
      }
    }
  }catch(e){}
}

function _removeAcctBarPadding(){
  // Called when leaving income tab -- remove the extra top padding from .main
  try{
    const main = document.querySelector('.main');
    if(main) main.style.paddingTop = '';
  }catch(e){}
}

// Modal state: track which account a modal was opened for (race condition guard)
let _pendingModalAccountId = null;
let _modalOpen = false; // true while any income modal is open -- blocks account switching

function _setModalOpen(open){
  _modalOpen = open;
  // Disable/enable account switcher chips while modal is open
  document.querySelectorAll('.acct-chip').forEach(chip => {
    chip.style.pointerEvents = open ? 'none' : '';
    chip.style.opacity = open ? '0.5' : '';
  });
}

function _applyAccountGlow(color){
  const panel = document.getElementById('tab-income');
  if(!panel) return;
  // Pure box-shadow inset -- no border, no layout shift
  // Tweak --acct-glow-spread and --acct-glow-alpha in app.css to adjust luminescence
  const spread = getComputedStyle(document.documentElement)
    .getPropertyValue('--acct-glow-spread').trim() || '24px';
  const alpha = getComputedStyle(document.documentElement)
    .getPropertyValue('--acct-glow-alpha').trim() || '50';
  panel.style.boxShadow = `inset 8px 0 ${spread} -2px ${color}${alpha}`;
}

function _renderAccountSwitcher(){
  const bar = document.getElementById('income-acct-bar');
  if(!bar) return;

  // Always make bar visible when this is called
  bar.style.display = 'flex';
  bar.style.flexDirection = 'row';
  bar.style.alignItems = 'center';
  bar.style.gap = '8px';

  const accounts = _getAccounts();

  // Style the overview button
  const overviewBtn = document.getElementById('income-overview-btn');
  if(overviewBtn){
    overviewBtn.style.cssText =
      'flex-shrink:0;font-family:var(--mono);font-size:9px;padding:3px 7px;' +
      'border-radius:4px;border:1px solid var(--border);background:var(--surface2);' +
      'color:var(--text3);cursor:pointer;white-space:nowrap;transition:all 0.2s;' +
      'letter-spacing:0.3px';
  }

  const chipsEl = document.getElementById('income-acct-chips');
  if(!chipsEl) return;

  chipsEl.style.display = 'flex';
  chipsEl.style.flexDirection = 'row';
  chipsEl.style.flexWrap = 'nowrap';
  chipsEl.style.gap = '6px';
  chipsEl.style.overflowX = 'auto';
  chipsEl.style.flex = '1';
  chipsEl.style.webkitOverflowScrolling = 'touch';
  chipsEl.style.paddingBottom = '2px';

  if(!accounts.length){
    chipsEl.innerHTML = `<span style="font-family:var(--mono);font-size:11px;color:var(--text3)">Loading accounts…</span>`;
    return;
  }

  const chips = accounts.map((a, i) => {
    const color = ACCT_COLORS[i % ACCT_COLORS.length];
    const isActive = a.id === _activeAccountId;
    const activeStyle = isActive
      ? `background:${color}22;border-color:${color};color:${color};font-weight:500;`
      : 'background:var(--surface2);border:1px solid var(--border);color:var(--text2);';
    return `<div class="acct-chip${isActive?' active':''}" ` +
      `style="display:inline-flex;align-items:center;flex-shrink:0;white-space:nowrap;gap:5px;` +
      `font-family:var(--mono);font-size:11px;padding:5px 10px;border-radius:6px;` +
      `border:1px solid;transition:all 0.2s;user-select:none;-webkit-user-select:none;` +
      `${activeStyle}">` +
      `<span style="cursor:pointer" onclick="_switchAccount('${a.id}')">${a.name}</span>` +
      `<span style="cursor:pointer;font-size:9px;opacity:0.6;line-height:1;padding-left:2px" ` +
        `onclick="event.stopPropagation();_openRenameAccountModal('${a.id}')">✎</span>` +
      `</div>`;
  }).join('');

  chipsEl.innerHTML =
    chips +
    `<div style="display:inline-flex;align-items:center;flex-shrink:0;` +
    `font-family:var(--mono);font-size:13px;padding:3px 9px;border-radius:6px;` +
    `border:1px solid var(--border);background:var(--surface2);color:var(--text3);` +
    `cursor:pointer;line-height:1;-webkit-user-select:none" ` +
    `onclick="_openAddAccountModal()">＋</div>`;
}

function _switchAccount(id){
  if(_modalOpen) return; // race condition guard
  if(id === _activeAccountId) return;
  // Flush any pending saves to the current account before switching
  try{ _saveIncomeInputs(); }catch(e){}
  // Switch
  _activeAccountId = id;
  S.set(ACCT_ACTIVE_KEY, id);
  // Re-render switcher and apply new glow
  _renderAccountSwitcher();
  const accounts = _getAccounts();
  const idx = accounts.findIndex(a => a.id === id);
  _applyAccountGlow(ACCT_COLORS[Math.max(0, idx) % ACCT_COLORS.length]);
  // Load the new account's data
  restoreIncomeFromCache();
}

// ── Account management modals ─────────────────────────────────────────────────

function _openAddAccountModal(){
  if(_modalOpen) return;
  _setModalOpen(true);
  let el = document.getElementById('income-acct-add-modal');
  if(!el){
    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'income-acct-add-modal';
    document.body.appendChild(el);
  }
  el.innerHTML =
    '<div class="modal-box">' +
      '<div class="modal-title modal-title-neutral">Add Account</div>' +
      '<div class="modal-body">Choose a name for the new account (e.g. "SEP IRA", "HSA").</div>' +
      '<input class="input" id="new-acct-name-inp" placeholder="Account name" style="margin-bottom:12px" maxlength="30">' +
      '<div style="display:flex;gap:8px">' +
        '<button class="btn btn-secondary btn-sm" onclick="_closeAddAccountModal()">Cancel</button>' +
        '<button class="btn btn-primary btn-sm" onclick="_confirmAddAccount()">Add</button>' +
      '</div>' +
    '</div>';
  el.classList.add('open');
  setTimeout(() => document.getElementById('new-acct-name-inp')?.focus(), 100);
}

function _closeAddAccountModal(){
  document.getElementById('income-acct-add-modal')?.classList.remove('open');
  _setModalOpen(false);
}

function _confirmAddAccount(){
  const name = document.getElementById('new-acct-name-inp')?.value?.trim();
  if(!name){ toast('Please enter an account name'); return; }
  const accounts = _getAccounts();
  if(accounts.some(a => a.name.toLowerCase() === name.toLowerCase())){
    toast('An account with that name already exists'); return;
  }
  const newId = _genAcctId();
  accounts.push({id: newId, name, createdAt: new Date().toISOString()});
  _saveAccounts(accounts);
  _closeAddAccountModal();
  _renderAccountSwitcher();
  toast('Account "' + name + '" added');
}

function _openRenameAccountModal(id){
  if(_modalOpen) return;
  _setModalOpen(true);
  _pendingModalAccountId = id;
  const accounts = _getAccounts();
  const acct = accounts.find(a => a.id === id);
  if(!acct){ _setModalOpen(false); return; }
  let el = document.getElementById('income-acct-rename-modal');
  if(!el){
    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'income-acct-rename-modal';
    document.body.appendChild(el);
  }
  el.innerHTML =
    '<div class="modal-box">' +
      '<div class="modal-title modal-title-neutral">Rename Account</div>' +
      '<div class="modal-body">Current name: <strong>' + acct.name + '</strong></div>' +
      '<input class="input" id="rename-acct-inp" value="' + acct.name + '" maxlength="30" style="margin-bottom:8px">' +
      '<div style="display:flex;gap:8px;margin-top:8px">' +
        '<button class="btn btn-secondary btn-sm" onclick="_closeRenameAccountModal()">Cancel</button>' +
        '<button class="btn btn-primary btn-sm" onclick="_confirmRenameAccount()">Rename</button>' +
        '<button class="btn btn-danger btn-sm" onclick="_openDeleteAccountModal(\'' + id + '\')">Delete…</button>' +
      '</div>' +
    '</div>';
  el.classList.add('open');
  setTimeout(() => { const i = document.getElementById('rename-acct-inp'); if(i){i.focus();i.select();} }, 100);
}

function _closeRenameAccountModal(){
  document.getElementById('income-acct-rename-modal')?.classList.remove('open');
  _pendingModalAccountId = null;
  _setModalOpen(false);
}

function _confirmRenameAccount(){
  const id = _pendingModalAccountId;
  if(!id) return;
  const newName = document.getElementById('rename-acct-inp')?.value?.trim();
  if(!newName){ toast('Please enter a name'); return; }
  const accounts = _getAccounts();
  const acct = accounts.find(a => a.id === id);
  if(!acct) return;
  if(accounts.some(a => a.id !== id && a.name.toLowerCase() === newName.toLowerCase())){
    toast('Another account already has that name'); return;
  }
  acct.name = newName;
  _saveAccounts(accounts);
  _closeRenameAccountModal();
  _renderAccountSwitcher();
  toast('Renamed to "' + newName + '"');
}

function _openDeleteAccountModal(id){
  // Close rename modal first
  document.getElementById('income-acct-rename-modal')?.classList.remove('open');
  const accounts = _getAccounts();
  const acct = accounts.find(a => a.id === id);
  if(!acct) return;
  if(accounts.length <= 1){ toast('Cannot delete the only account'); _setModalOpen(false); return; }
  _pendingModalAccountId = id;

  // Check for active positions
  const puts = S.get(_acctKeyFor(id, 'put_positions')) || [];
  const ccs  = S.get(_acctKeyFor(id, 'cc_positions'))  || [];
  const activePuts = puts.filter(p => _posExpiryStatus(p) !== 'remove' && _posExpiryStatus(p) !== 'expired-linger');
  const activeCCs  = ccs.filter(p  => _posExpiryStatus(p) !== 'remove' && _posExpiryStatus(p) !== 'expired-linger');
  const hasPositions = activePuts.length > 0 || activeCCs.length > 0;

  let el = document.getElementById('income-acct-delete-modal');
  if(!el){
    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'income-acct-delete-modal';
    document.body.appendChild(el);
  }

  const posWarning = hasPositions
    ? `<div style="background:rgba(255,71,87,0.1);border:1px solid rgba(255,71,87,0.3);border-radius:8px;padding:10px;margin-bottom:12px;font-family:var(--mono);font-size:11px;color:var(--red);line-height:1.5">` +
      `⚠ This account has ${activePuts.length} put position${activePuts.length!==1?'s':''} and ${activeCCs.length} CC position${activeCCs.length!==1?'s':''}.<br>` +
      `Export a backup first so this data is recoverable.</div>` +
      `<div style="display:flex;gap:8px;margin-bottom:12px">` +
        `<button class="btn btn-secondary btn-sm" onclick="_exportBeforeDelete()" style="flex:1">Export Backup Now</button>` +
      `</div>`
    : '';

  el.innerHTML =
    '<div class="modal-box">' +
      '<div class="modal-title">Delete "' + acct.name + '"?</div>' +
      '<div class="modal-body">This permanently deletes this account and all its data. This cannot be undone.</div>' +
      posWarning +
      '<div style="font-family:var(--mono);font-size:11px;color:var(--text2);margin-bottom:6px">Type <strong>' + acct.name.toUpperCase() + '</strong> to confirm:</div>' +
      '<input class="input" id="delete-acct-confirm-inp" placeholder="' + acct.name.toUpperCase() + '" style="margin-bottom:12px" autocomplete="off">' +
      '<div style="display:flex;gap:8px">' +
        '<button class="btn btn-secondary btn-sm" onclick="_closeDeleteAccountModal()">Cancel</button>' +
        '<button class="btn btn-danger btn-sm" id="delete-acct-confirm-btn" disabled onclick="_confirmDeleteAccount()">Delete</button>' +
      '</div>' +
    '</div>';
  el.classList.add('open');

  // Enable delete button only when name matches
  const inp = document.getElementById('delete-acct-confirm-inp');
  const btn = document.getElementById('delete-acct-confirm-btn');
  if(inp && btn){
    inp.addEventListener('input', () => {
      btn.disabled = inp.value.trim().toUpperCase() !== acct.name.toUpperCase();
    });
    setTimeout(() => inp.focus(), 100);
  }
}

function _exportBeforeDelete(){
  try{
    const data = typeof _buildExportData === 'function' ? _buildExportData() : null;
    if(!data){ toast('Open Settings > Data Portability to export manually'); return; }
    const json = JSON.stringify(data, null, 2);
    if(navigator.clipboard){ navigator.clipboard.writeText(json).then(() => toast('Backup copied to clipboard — paste it somewhere safe')); }
    else{ toast('Copy your backup from Settings > Data Portability'); }
  }catch(e){ toast('Export failed — use Settings > Data Portability'); }
}

function _closeDeleteAccountModal(){
  document.getElementById('income-acct-delete-modal')?.classList.remove('open');
  _pendingModalAccountId = null;
  _setModalOpen(false);
}

function _confirmDeleteAccount(){
  const id = _pendingModalAccountId;
  if(!id) return;
  const accounts = _getAccounts();
  if(accounts.length <= 1){ toast('Cannot delete the only account'); return; }
  const acctName = accounts.find(a => a.id === id)?.name || '';

  // Delete all per-account keys
  ['inputs','mmf_yield','put_positions','cc_positions'].forEach(suffix => {
    S.del(_acctKeyFor(id, suffix));
  });

  // Remove from accounts meta
  const remaining = accounts.filter(a => a.id !== id);
  _saveAccounts(remaining);

  // Switch to first remaining account if deleted account was active
  if(_activeAccountId === id){
    _activeAccountId = remaining[0].id;
    S.set(ACCT_ACTIVE_KEY, _activeAccountId);
  }

  _closeDeleteAccountModal();
  _renderAccountSwitcher();
  const newIdx = remaining.findIndex(a => a.id === _activeAccountId);
  _applyAccountGlow(ACCT_COLORS[Math.max(0, newIdx) % ACCT_COLORS.length]);
  restoreIncomeFromCache();
  toast('"' + acctName + '" deleted');
}

// ── Aggregate All-Accounts Overview pop-up ────────────────────────────────────

function openIncomeOverview(){
  const accounts = _getAccounts();
  let el = document.getElementById('income-overview-modal');
  if(!el){
    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'income-overview-modal';
    document.body.appendChild(el);
  }

  const rows = accounts.map((a, i) => {
    const color = ACCT_COLORS[i % ACCT_COLORS.length];
    const puts = (S.get(_acctKeyFor(a.id, 'put_positions')) || [])
      .filter(p => _posExpiryStatus(p) !== 'remove');
    const ccs  = (S.get(_acctKeyFor(a.id, 'cc_positions'))  || [])
      .filter(p => _posExpiryStatus(p) !== 'remove');

    const activePuts = puts.filter(p => _posExpiryStatus(p) !== 'expired-linger');
    const activeCCs  = ccs.filter(p  => _posExpiryStatus(p) !== 'expired-linger');

    const putNotional = activePuts.reduce((s,p) => s + _posNotional(p), 0);
    const ccNotional  = activeCCs.reduce((s,p)  => s + _ccPosNotional(p), 0);

    // Urgency: find worst status across all active positions
    const allActive = [...activePuts, ...activeCCs];
    let urgency = 'none';
    let urgencyColor = 'var(--text3)';
    let urgencyLabel = '';
    let itmFlag = '';

    if(allActive.length){
      const statuses = allActive.map(p => _posExpiryStatus(p));
      if(statuses.includes('expiring-imminent')){ urgency='imminent'; urgencyColor='var(--red)'; urgencyLabel='⚠ Expires ≤2d'; }
      else if(statuses.includes('expiring-soon')){ urgency='soon'; urgencyColor='var(--warn)'; urgencyLabel='⚡ Expires ≤7d'; }
      else{ urgencyLabel=''; }

      // ITM check on put positions
      const itmPuts = activePuts.filter(p => {
        const pricing = _getPosPricing(p);
        return pricing.itm === true;
      });
      if(itmPuts.length){
        itmFlag = `<span style="color:var(--red);font-size:10px;margin-left:6px">⚠ ${itmPuts.length} ITM put${itmPuts.length!==1?'s':''}</span>`;
      }
    }

    const isActive = a.id === _activeAccountId;
    return `<div style="background:${isActive?'var(--surface2)':'var(--surface)'};border:1px solid var(--border);border-left:3px solid ${color};border-radius:8px;padding:12px;margin-bottom:8px;cursor:pointer" onclick="_switchFromOverview('${a.id}')">` +
      `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">` +
        `<div style="font-family:var(--sans);font-size:13px;font-weight:700;color:${color}">${a.name}${isActive?' <span style="font-size:9px;color:var(--text3)">(active)</span>':''}</div>` +
        `<div style="font-family:var(--mono);font-size:10px;color:${urgencyColor}">${urgencyLabel}</div>` +
      `</div>` +
      `<div style="font-family:var(--mono);font-size:11px;color:var(--text2);line-height:1.8">` +
        `<div>Puts: ${activePuts.length} position${activePuts.length!==1?'s':''} · ${_fmtDollar(putNotional)} notional${itmFlag}</div>` +
        `<div>CCs: ${activeCCs.length} position${activeCCs.length!==1?'s':''} · ${_fmtDollar(ccNotional)} notional</div>` +
      `</div>` +
    `</div>`;
  }).join('');

  el.innerHTML =
    '<div class="modal-box" style="max-width:380px">' +
      '<div class="modal-title modal-title-neutral" style="margin-bottom:14px">All Accounts Overview</div>' +
      '<div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:10px">Tap an account to switch to it</div>' +
      rows +
      '<button class="btn btn-secondary btn-sm" style="margin-top:4px;width:100%" onclick="document.getElementById(\'income-overview-modal\').classList.remove(\'open\')">Close</button>' +
    '</div>';
  el.classList.add('open');
}

function _switchFromOverview(id){
  document.getElementById('income-overview-modal')?.classList.remove('open');
  _switchAccount(id);
}

// ── Tab entry points ──────────────────────────────────────────────────────────

function _initAccountState(){
  // Ensure _activeAccountId is set from storage before any income operation runs
  const accounts = _getAccounts();
  if(!accounts.length) return; // migration hasn't run yet
  const stored = S.get(ACCT_ACTIVE_KEY);
  const valid = accounts.find(a => a.id === stored);
  _activeAccountId = valid ? valid.id : accounts[0].id;
  if(!valid) S.set(ACCT_ACTIVE_KEY, _activeAccountId);
  // Apply glow
  const idx = accounts.findIndex(a => a.id === _activeAccountId);
  _applyAccountGlow(ACCT_COLORS[Math.max(0, idx) % ACCT_COLORS.length]);
  _renderAccountSwitcher();
  // Set sticky top offset after render, measuring actual nav height
  requestAnimationFrame(_updateAcctBarStickyTop);
}

async function loadIncomeTab(){
  _initAccountState();
  const el=document.getElementById('income-results');
  if(!el)return;
  const inp=_loadIncomeInputs();
  _fillInputs(inp);
  el.innerHTML='<div class="card"><div style="display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--text2)"><div class="spinner"></div>Fetching money market yields...</div></div>';
  const mmf=await _getMMFYields(inp.fdlxxYieldManual,inp.spaxxYieldManual);
  _buildAndRender(inp,mmf);
}

function restoreIncomeFromCache(){
  _initAccountState();
  const inp=_loadIncomeInputs();
  _fillInputs(inp);
  const mmfKey = _acctKey('mmf_yield');
  const cached = S.get(mmfKey) || {fdlxx:null,spaxx:null,ts:null};
  const mmf={
    ...cached,fromCache:true,
    fdlxxManual:cached.fdlxx==null,
    spaxxManual:cached.spaxx==null
  };
  _buildAndRender(inp,mmf);
}

function recalcIncome(){
  const inp=_saveIncomeInputs();
  const mmfKey = _acctKey('mmf_yield');
  const cached = S.get(mmfKey) || {fdlxx:null,spaxx:null,ts:null};
  const mmf={
    ...cached,fromCache:true,
    fdlxxManual:cached.fdlxx==null,
    spaxxManual:cached.spaxx==null
  };
  _buildAndRender(inp,mmf);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUT POSITIONS TRACKER
// Manages individual naked put positions for Layer 3 notional calculation.
// Storage key: income_ACCTID_put_positions → array of position objects:
//   {id, ticker, strike, expDate, contracts, addedTs}
// ═══════════════════════════════════════════════════════════════════════════════

const PUT_POS_SORT_KEY = 'put_pos_sort'; // 'ticker' | 'expiry'
const POS_LINGER_DAYS = 7; // expired positions linger this many days before auto-removal

// ── Position sort ────────────────────────────────────────────────────────────

function _getPosSort(){
  return S.get(PUT_POS_SORT_KEY)||'ticker';
}

function setPosSort(mode){
  S.set(PUT_POS_SORT_KEY, mode);
  recalcIncome();
}

function _sortPositions(positions){
  const mode = _getPosSort();
  const active = positions.filter(p => {
    const s = _posExpiryStatus(p);
    return s === 'active' || s === 'expiring-soon' || s === 'expiring-imminent';
  });
  const expired = positions.filter(p => _posExpiryStatus(p) === 'expired-linger');

  const cmp = mode === 'expiry'
    ? (a,b) => a.expDate.localeCompare(b.expDate) || a.ticker.localeCompare(b.ticker) || a.strike - b.strike
    : (a,b) => a.ticker.localeCompare(b.ticker) || a.strike - b.strike || a.expDate.localeCompare(b.expDate);

  return [...active.sort(cmp), ...expired.sort(cmp)];
}

// ── Position storage helpers ──────────────────────────────────────────────────

function _loadPositions(){
  return S.get(_acctKey('put_positions')) || [];
}

function _savePositions(positions){
  S.set(_acctKey('put_positions'), positions);
}

function _posNotional(pos){
  return pos.strike * 100 * pos.contracts;
}

function _posExpiryStatus(pos){
  // Returns: 'active' | 'expiring-soon' | 'expiring-imminent' | 'expired-linger' | 'remove'
  const today = new Date();
  today.setHours(0,0,0,0);
  const exp = new Date(pos.expDate + 'T12:00:00Z');
  const daysUntil = Math.round((exp - today) / 86400000);
  if(daysUntil < -POS_LINGER_DAYS) return 'remove';
  if(daysUntil < 0)  return 'expired-linger';
  if(daysUntil <= 2) return 'expiring-imminent';
  if(daysUntil <= 7) return 'expiring-soon';
  return 'active';
}

function _activePosNotionalTotal(){
  const positions = _loadPositions();
  // Auto-clean positions past linger period
  const keep = positions.filter(p => _posExpiryStatus(p) !== 'remove');
  if(keep.length !== positions.length) _savePositions(keep);
  return keep
    .filter(p => {
      const s = _posExpiryStatus(p);
      return s === 'active' || s === 'expiring-soon' || s === 'expiring-imminent';
    })
    .reduce((sum, p) => sum + _posNotional(p), 0);
}

// ── Put position price / time-value lookup ─────────────────────────────────────
// Pulls current underlying price from the snap cache and, when available, the
// matching put contract's premium from the per-expiration options cache to
// derive time value (extrinsic) remaining -- the signal for roll/assignment risk.
// Degrades gracefully: missing snap -> no price; missing/unmatched options
// cache -> price + moneyness only, no time value. Never throws.

function _getPosPricing(pos){
  const snap = S.get('snap_' + pos.ticker);
  const currentPrice = snap?.price ?? null;
  if(currentPrice == null) return { currentPrice: null, itm: null, intrinsic: null, timeValue: null };

  const itm = currentPrice < pos.strike;
  const intrinsic = Math.max(pos.strike - currentPrice, 0) * 100 * pos.contracts;

  let timeValue = null;
  try{
    const cache = S.get('options_exp_' + pos.ticker + '_' + pos.expDate);
    const puts = cache?.optionChain?.result?.[0]?.options?.[0]?.puts || [];
    const match = puts.find(p => Math.abs(p.strike - pos.strike) < 0.005);
    if(match){
      const premium = (match.bid > 0 ? match.bid : (match.lastPrice || 0));
      if(premium > 0){
        const totalPremium = premium * 100 * pos.contracts;
        timeValue = Math.max(totalPremium - intrinsic, 0);
      }
    }
  }catch{}

  return { currentPrice, itm, intrinsic, timeValue };
}

// ── Monthly expiration detection from options cache ───────────────────────────

function _getMonthlyExpirations(ticker){
  const cache = S.get('options_' + ticker);
  const result = cache?.data?.optionChain?.result?.[0];
  if(!result) return [];
  const rawTs = result.expirationDates || [];
  const pairs = rawTs.map(ts => ({
    ts,
    date: new Date(ts * 1000).toISOString().split('T')[0]
  }));
  // Standard monthly: 3rd Fri (or Thu), day 15-21
  const monthly = pairs.filter(p => {
    const d = new Date(p.date + 'T12:00:00Z');
    return (d.getUTCDay() === 5 || d.getUTCDay() === 4) &&
           d.getUTCDate() >= 15 && d.getUTCDate() <= 21;
  });
  // Fallback: first 3 future expirations
  const future = pairs.filter(p => new Date(p.date + 'T12:00:00Z') >= new Date());
  const result2 = monthly.length ? monthly : future.slice(0,3);
  return result2
    .filter(p => new Date(p.date + 'T12:00:00Z') >= new Date())
    .sort((a,b) => a.date.localeCompare(b.date))
    .slice(0, 6); // up to 6 monthly expirations
}

function _getStrikesForExpiration(ticker, expDate){
  const cache = S.get('options_exp_' + ticker + '_' + expDate);
  const result = cache?.optionChain?.result?.[0];
  if(!result) return [];
  const puts = result.options?.[0]?.puts || [];
  // No price-based filter -- show all strikes so existing positions at any
  // moneyness (deeply ITM or deeply OTM) can be entered accurately.
  return puts
    .filter(p => p.strike > 0)
    .map(p => p.strike)
    .filter((v,i,a) => a.indexOf(v) === i) // dedupe
    .sort((a,b) => b - a); // descending (higher strikes first)
}

// ── Position add/remove UI ────────────────────────────────────────────────────

function _openAddPositionModal(){
  // Build modal HTML
  const wl = [...watchlist].sort((a,b) => a.localeCompare(b));
  if(!wl.length){toast('Add tickers to your watchlist first');return;}

  // Capture account ID at modal-open time (race condition guard)
  _pendingModalAccountId = _activeAccountId;
  _setModalOpen(true);

  let el = document.getElementById('pos-add-modal');
  if(!el){
    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'pos-add-modal';
    document.body.appendChild(el);
    el.addEventListener('click', e => {if(e.target===el)_closePosModal();});
  }

  el.innerHTML =
    '<div class="modal-box" style="max-width:340px">' +
      '<div class="modal-title">Add Put Position</div>' +
      '<div class="input-group" style="margin-bottom:10px">' +
        '<label class="input-label">Ticker</label>' +
        '<select class="input" id="pos-ticker-sel" onchange="_onPosTickerChange()">' +
          '<option value="">-- Select ticker --</option>' +
          wl.map(t => '<option value="'+t+'">'+t+'</option>').join('') +
        '</select>' +
      '</div>' +
      '<div class="input-group" style="margin-bottom:10px" id="pos-exp-group">' +
        '<label class="input-label">Expiration</label>' +
        '<select class="input" id="pos-exp-sel" onchange="_onPosExpChange()" disabled>' +
          '<option value="">-- Select ticker first --</option>' +
        '</select>' +
      '</div>' +
      '<div class="input-group" style="margin-bottom:10px" id="pos-strike-group">' +
        '<label class="input-label">Strike</label>' +
        '<select class="input" id="pos-strike-sel" disabled>' +
          '<option value="">-- Select expiration first --</option>' +
        '</select>' +
      '</div>' +
      '<div class="input-group" style="margin-bottom:14px">' +
        '<label class="input-label">Contracts</label>' +
        '<input class="input" type="number" id="pos-contracts" min="1" value="1" placeholder="1">' +
      '</div>' +
      '<div id="pos-no-data-warn" style="font-family:var(--mono);font-size:10px;color:var(--warn);display:none;margin-bottom:10px">' +
        '&#x26A0; No cached options for this ticker. Visit the Options tab to load data first.' +
      '</div>' +
      '<div style="display:flex;gap:8px">' +
        '<button class="btn btn-secondary btn-sm" onclick="_closePosModal()">Cancel</button>' +
        '<button class="btn btn-primary btn-sm" onclick="_confirmAddPosition()">Add Position</button>' +
      '</div>' +
    '</div>';

  el.classList.add('open');
}

function _closePosModal(){
  const el = document.getElementById('pos-add-modal');
  if(el) el.classList.remove('open');
  _pendingModalAccountId = null;
  _setModalOpen(false);
}

function _onPosTickerChange(){
  const ticker = document.getElementById('pos-ticker-sel')?.value;
  const expSel = document.getElementById('pos-exp-sel');
  const strikeSel = document.getElementById('pos-strike-sel');
  const warn = document.getElementById('pos-no-data-warn');
  if(!expSel||!strikeSel) return;

  expSel.innerHTML = '<option value="">-- Select expiration --</option>';
  strikeSel.innerHTML = '<option value="">-- Select expiration first --</option>';
  expSel.disabled = true;
  strikeSel.disabled = true;
  warn.style.display = 'none';

  if(!ticker) return;
  const exps = _getMonthlyExpirations(ticker);
  if(!exps.length){
    warn.style.display = 'block';
    return;
  }
  exps.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.date;
    // Display as e.g. "Jun 20, 2025"
    opt.textContent = new Date(e.date+'T12:00:00Z')
      .toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    expSel.appendChild(opt);
  });
  expSel.disabled = false;
}

function _onPosExpChange(){
  const ticker = document.getElementById('pos-ticker-sel')?.value;
  const expDate = document.getElementById('pos-exp-sel')?.value;
  const strikeSel = document.getElementById('pos-strike-sel');
  if(!strikeSel) return;

  strikeSel.innerHTML = '<option value="">-- Select strike --</option>';
  strikeSel.disabled = true;
  if(!ticker || !expDate) return;

  const strikes = _getStrikesForExpiration(ticker, expDate);
  const snap = S.get('snap_'+ticker);
  const price = snap?.price || 0;

  if(!strikes.length){
    strikeSel.innerHTML = '<option value="">No strikes cached for this expiration</option>';
    return;
  }
  strikes.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    const otmPct = price > 0 ? ((price - s) / price * 100) : null;
    const moneyness = otmPct !== null
      ? (otmPct > 0 ? otmPct.toFixed(1)+'% OTM' : Math.abs(otmPct).toFixed(1)+'% ITM')
      : '';
    opt.textContent = '$' + s.toFixed(2) + (moneyness ? ' — ' + moneyness : '');
    strikeSel.appendChild(opt);
  });
  strikeSel.disabled = false;
}

function _confirmAddPosition(){
  const ticker   = document.getElementById('pos-ticker-sel')?.value;
  const expDate  = document.getElementById('pos-exp-sel')?.value;
  const strike   = parseFloat(document.getElementById('pos-strike-sel')?.value);
  const contracts= Math.max(1, parseInt(document.getElementById('pos-contracts')?.value)||1);

  if(!ticker || !expDate || !strike){
    toast('Please select ticker, expiration and strike');
    return;
  }

  // Use account captured at modal-open time (race condition guard)
  const targetAcctId = _pendingModalAccountId || _activeAccountId;
  const posKey = _acctKeyFor(targetAcctId, 'put_positions');
  const positions = S.get(posKey) || [];
  const id = 'pos_' + Date.now();
  positions.push({id, ticker, strike, expDate, contracts, addedTs: new Date().toISOString()});
  S.set(posKey, positions);
  _closePosModal();
  recalcIncome();
  toast('Position added: ' + ticker + ' $' + strike.toFixed(0) + ' x' + contracts);
}

let _pendingRemovePosId = null;

function _openRemovePosModal(id){
  _pendingRemovePosId = id;
  _pendingModalAccountId = _activeAccountId; // capture account at open time
  _setModalOpen(true);
  const positions = _loadPositions();
  const pos = positions.find(p => p.id === id);
  if(!pos){ _setModalOpen(false); return; }

  let el = document.getElementById('pos-remove-modal');
  if(!el){
    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'pos-remove-modal';
    el.innerHTML =
      '<div class="modal-box">' +
        '<div class="modal-title" id="prm-title">Remove position?</div>' +
        '<div class="modal-body" id="prm-body"></div>' +
        '<div style="display:flex;gap:8px">' +
          '<button class="btn btn-secondary btn-sm" id="prm-cancel">Cancel</button>' +
          '<button class="btn btn-danger btn-sm" id="prm-confirm">Remove</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    document.getElementById('prm-cancel').addEventListener('click', () => {
      _pendingRemovePosId = null;
      _pendingModalAccountId = null;
      _setModalOpen(false);
      el.classList.remove('open');
    });
    document.getElementById('prm-confirm').addEventListener('click', _confirmRemovePos);
    el.addEventListener('click', e => {
      if(e.target === el){ _pendingRemovePosId = null; _pendingModalAccountId = null; _setModalOpen(false); el.classList.remove('open'); }
    });
  }
  document.getElementById('prm-body').textContent =
    'Remove ' + pos.ticker + ' $' + pos.strike.toFixed(0) +
    ' put expiring ' + pos.expDate + ' (' + pos.contracts + ' contract' +
    (pos.contracts > 1 ? 's' : '') + ')?';
  el.classList.add('open');
}

function _confirmRemovePos(){
  const id = _pendingRemovePosId;
  const acctId = _pendingModalAccountId || _activeAccountId;
  _pendingRemovePosId = null;
  _pendingModalAccountId = null;
  _setModalOpen(false);
  document.getElementById('pos-remove-modal')?.classList.remove('open');
  if(!id) return;
  // Use captured account ID -- guards against account switching while modal open
  const posKey = _acctKeyFor(acctId, 'put_positions');
  const positions = (S.get(posKey) || []).filter(p => p.id !== id);
  S.set(posKey, positions);
  recalcIncome();
  toast('Position removed');
}

// ── Position list renderer ────────────────────────────────────────────────────

function _renderPositionList(){
  const positions = _loadPositions();
  // Auto-remove positions past linger period
  const keep = positions.filter(p => _posExpiryStatus(p) !== 'remove');
  if(keep.length !== positions.length) _savePositions(keep);

  const activeNotional = keep
    .filter(p => {
      const s = _posExpiryStatus(p);
      return s === 'active' || s === 'expiring-soon' || s === 'expiring-imminent';
    })
    .reduce((sum, p) => sum + _posNotional(p), 0);

  const sorted = _sortPositions(keep);
  const STATUS_STYLE = {
    'active':             {border:'rgba(0,212,170,0.3)',  bg:'rgba(0,212,170,0.06)',  label:'',             labelColor:''},
    'expiring-soon':      {border:'rgba(255,165,2,0.5)',  bg:'rgba(255,165,2,0.08)',  label:'Exp ≤7d',      labelColor:'var(--warn)'},
    'expiring-imminent':  {border:'rgba(255,71,87,0.6)',  bg:'rgba(255,71,87,0.08)',  label:'Exp ≤2d',      labelColor:'var(--red)'},
    'expired-linger':     {border:'rgba(85,88,112,0.3)',  bg:'rgba(85,88,112,0.06)',  label:'Expired',      labelColor:'var(--text3)'},
  };

  const clearExpiredBtn = keep.some(p => _posExpiryStatus(p) === 'expired-linger')
    ? '<button class="btn btn-secondary" style="font-size:10px;padding:4px 10px;margin-top:6px" onclick="_clearExpiredPositions()">Clear Expired</button>'
    : '';

  const rows = sorted.map(pos => {
    const status = _posExpiryStatus(pos);
    const ss = STATUS_STYLE[status];
    const notional = _posNotional(pos);
    const expired = status === 'expired-linger';
    const today = new Date(); today.setHours(0,0,0,0);
    const exp = new Date(pos.expDate + 'T12:00:00Z');
    const daysUntil = Math.round((exp - today) / 86400000);
    const daysStr = expired
      ? 'Expired ' + Math.abs(daysUntil) + 'd ago'
      : daysUntil === 0 ? 'Expires today' : 'Exp in ' + daysUntil + 'd';

    const pricing = expired ? { currentPrice: null, itm: null, timeValue: null } : _getPosPricing(pos);
    const priceStr = pricing.currentPrice != null ? ' · now $' + pricing.currentPrice.toFixed(2) : '';
    const itmTag = pricing.itm
      ? '<span style="color:var(--red)">&#x26A0; ITM</span>'
      : '';
    const timeValueLine = pricing.timeValue != null
      ? '<div style="font-family:var(--mono);font-size:9px;color:'+(pricing.itm?'var(--warn)':'var(--text3)')+'">'+
          'Time value: '+_fmtDollar(pricing.timeValue)+(pricing.itm?' remaining &mdash; consider rolling':'')+
        '</div>'
      : '';

    return '<div style="background:'+ss.bg+';border:1px solid '+ss.border+';border-radius:8px;padding:10px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;'+(expired?'opacity:0.5':'')+'">' +
      '<div>' +
        '<div style="font-family:var(--mono);font-size:13px;font-weight:700;color:'+(expired?'var(--text3)':'var(--accent)')+'">'+
          pos.ticker+' $'+pos.strike.toFixed(0)+
          (ss.label?'<span style="font-size:9px;color:'+ss.labelColor+';margin-left:6px;font-weight:400">'+ss.label+'</span>':'')+
          (itmTag&&!expired?' <span style="font-size:9px;margin-left:4px">'+itmTag+'</span>':'')+
        '</div>'+
        '<div style="font-family:var(--mono);font-size:10px;color:var(--text3)">'+
          pos.contracts+' contract'+(pos.contracts>1?'s':'')+' · '+pos.expDate+' · '+daysStr+priceStr+
        '</div>'+
        timeValueLine+
        '<div style="font-family:var(--mono);font-size:10px;color:'+(expired?'var(--text3)':L3_TEXT)+'">'+
          _fmtDollar(notional)+' notional'+(expired?' (excluded)':'') +
        '</div>'+
      '</div>'+
      '<button style="background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer;padding:4px 8px" '+
        'onclick="_openRemovePosModal(\''+pos.id+'\')">&times;</button>'+
    '</div>';
  }).join('');

  const emptyMsg = keep.length === 0
    ? '<div style="font-family:var(--mono);font-size:11px;color:var(--text3);text-align:center;padding:12px 0">No positions entered. Tap Add Position to begin.</div>'
    : '';

  return {
    html:
      '<div style="margin-bottom:6px">' +
        (keep.length > 0
          ? '<div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:8px">' +
              'Active notional: <span style="color:'+L3_TEXT+';font-weight:600">'+_fmtDollar(activeNotional)+'</span>' +
            '</div>'
          : '') +
        rows + emptyMsg + clearExpiredBtn +
      '</div>',
    activeNotional
  };
}

function _clearExpiredPositions(){
  const keep = _loadPositions().filter(p => _posExpiryStatus(p) !== 'expired-linger');
  _savePositions(keep);
  recalcIncome();
  toast('Expired positions cleared');
}

// ═══════════════════════════════════════════════════════════════════════════════
// COVERED CALL POSITIONS TRACKER
// Mirrors put positions tracker for Layer 3 CC stock notional.
// Storage key: income_ACCTID_cc_positions → array of position objects:
//   {id, ticker, strike, expDate, contracts, stockPriceAtWrite, addedTs}
// Notional per position: stockPriceAtWrite × 100 × contracts
// ═══════════════════════════════════════════════════════════════════════════════

const CC_POS_SORT_KEY = 'cc_pos_sort'; // 'ticker' | 'expiry'

// ── CC sort ───────────────────────────────────────────────────────────────────

function _getCCSort(){
  return S.get(CC_POS_SORT_KEY)||'ticker';
}

function setCCSort(mode){
  S.set(CC_POS_SORT_KEY, mode);
  recalcIncome();
}

function _sortCCPositions(positions){
  const mode = _getCCSort();
  const active = positions.filter(p => {
    const s = _posExpiryStatus(p);
    return s === 'active' || s === 'expiring-soon' || s === 'expiring-imminent';
  });
  const expired = positions.filter(p => _posExpiryStatus(p) === 'expired-linger');
  const cmp = mode === 'expiry'
    ? (a,b) => a.expDate.localeCompare(b.expDate) || a.ticker.localeCompare(b.ticker) || a.strike - b.strike
    : (a,b) => a.ticker.localeCompare(b.ticker) || a.strike - b.strike || a.expDate.localeCompare(b.expDate);
  return [...active.sort(cmp), ...expired.sort(cmp)];
}

// ── CC storage helpers ────────────────────────────────────────────────────────

function _loadCCPositions(){
  return S.get(_acctKey('cc_positions')) || [];
}

function _saveCCPositions(positions){
  S.set(_acctKey('cc_positions'), positions);
}

function _ccPosNotional(pos){
  return (pos.stockPriceAtWrite||0) * 100 * pos.contracts;
}

function _activeCCNotionalTotal(){
  const positions = _loadCCPositions();
  const keep = positions.filter(p => _posExpiryStatus(p) !== 'remove');
  if(keep.length !== positions.length) _saveCCPositions(keep);
  return keep
    .filter(p => {
      const s = _posExpiryStatus(p);
      return s === 'active' || s === 'expiring-soon' || s === 'expiring-imminent';
    })
    .reduce((sum, p) => sum + _ccPosNotional(p), 0);
}

// ── CC strike helper — call strikes ──────────────────────────────────────────

function _getCallStrikesForExpiration(ticker, expDate){
  const cache = S.get('options_exp_' + ticker + '_' + expDate);
  const result = cache?.optionChain?.result?.[0];
  if(!result) return [];
  const calls = result.options?.[0]?.calls || [];
  // No price-based filter -- show all strikes so existing CC positions at any
  // moneyness (deeply ITM or deeply OTM) can be entered accurately.
  return calls
    .filter(c => c.strike > 0)
    .map(c => c.strike)
    .filter((v,i,a) => a.indexOf(v) === i)
    .sort((a,b) => a - b); // ascending (lower/ITM strikes first for calls)
}

// ── CC add/remove UI ──────────────────────────────────────────────────────────

function _openAddCCModal(){
  const wl = [...watchlist].sort((a,b) => a.localeCompare(b));
  if(!wl.length){toast('Add tickers to your watchlist first');return;}

  // Capture account ID at modal-open time (race condition guard)
  _pendingModalAccountId = _activeAccountId;
  _setModalOpen(true);

  let el = document.getElementById('cc-add-modal');
  if(!el){
    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'cc-add-modal';
    document.body.appendChild(el);
    el.addEventListener('click', e => {if(e.target===el)_closeAddCCModal();});
  }

  el.innerHTML =
    '<div class="modal-box" style="max-width:340px">' +
      '<div class="modal-title">Add Covered Call Position</div>' +
      '<div class="input-group" style="margin-bottom:10px">' +
        '<label class="input-label">Ticker</label>' +
        '<select class="input" id="cc-ticker-sel" onchange="_onCCTickerChange()">' +
          '<option value="">-- Select ticker --</option>' +
          wl.map(t => '<option value="'+t+'">'+t+'</option>').join('') +
        '</select>' +
      '</div>' +
      '<div class="input-group" style="margin-bottom:10px">' +
        '<label class="input-label">Expiration</label>' +
        '<select class="input" id="cc-exp-sel" onchange="_onCCExpChange()" disabled>' +
          '<option value="">-- Select ticker first --</option>' +
        '</select>' +
      '</div>' +
      '<div class="input-group" style="margin-bottom:10px">' +
        '<label class="input-label">Strike (call)</label>' +
        '<select class="input" id="cc-strike-sel" onchange="_onCCStrikeChange()" disabled>' +
          '<option value="">-- Select expiration first --</option>' +
        '</select>' +
      '</div>' +
      '<div class="input-group" style="margin-bottom:10px">' +
        '<label class="input-label">Contracts</label>' +
        '<input class="input" type="number" id="cc-contracts" min="1" value="1" placeholder="1">' +
      '</div>' +
      '<div class="input-group" style="margin-bottom:14px">' +
        '<label class="input-label">Stock price at time of writing ($)</label>' +
        '<input class="input" type="number" id="cc-stock-price-at-write" min="0" step="0.01" placeholder="e.g. 150.00">' +
        '<div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-top:3px">Pre-filled with current cached price. Edit if writing at a different price.</div>' +
      '</div>' +
      '<div id="cc-no-data-warn" style="font-family:var(--mono);font-size:10px;color:var(--warn);display:none;margin-bottom:10px">' +
        '&#x26A0; No cached options for this ticker. Visit the Options tab to load data first.' +
      '</div>' +
      '<div style="display:flex;gap:8px">' +
        '<button class="btn btn-secondary btn-sm" onclick="_closeAddCCModal()">Cancel</button>' +
        '<button class="btn btn-primary btn-sm" onclick="_confirmAddCC()">Add Position</button>' +
      '</div>' +
    '</div>';

  el.classList.add('open');
}

function _closeAddCCModal(){
  const el = document.getElementById('cc-add-modal');
  if(el) el.classList.remove('open');
  _pendingModalAccountId = null;
  _setModalOpen(false);
}

function _onCCTickerChange(){
  const ticker = document.getElementById('cc-ticker-sel')?.value;
  const expSel = document.getElementById('cc-exp-sel');
  const strikeSel = document.getElementById('cc-strike-sel');
  const warn = document.getElementById('cc-no-data-warn');
  const priceEl = document.getElementById('cc-stock-price-at-write');
  if(!expSel||!strikeSel) return;

  expSel.innerHTML = '<option value="">-- Select expiration --</option>';
  strikeSel.innerHTML = '<option value="">-- Select expiration first --</option>';
  expSel.disabled = true;
  strikeSel.disabled = true;
  warn.style.display = 'none';
  if(priceEl) priceEl.value = '';

  if(!ticker) return;

  // Pre-fill current stock price
  if(priceEl){
    const snap = S.get('snap_'+ticker);
    if(snap?.price) priceEl.value = snap.price.toFixed(2);
  }

  const exps = _getMonthlyExpirations(ticker);
  if(!exps.length){
    warn.style.display = 'block';
    return;
  }
  exps.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.date;
    opt.textContent = new Date(e.date+'T12:00:00Z')
      .toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    expSel.appendChild(opt);
  });
  expSel.disabled = false;
}

function _onCCExpChange(){
  const ticker   = document.getElementById('cc-ticker-sel')?.value;
  const expDate  = document.getElementById('cc-exp-sel')?.value;
  const strikeSel= document.getElementById('cc-strike-sel');
  if(!strikeSel) return;

  strikeSel.innerHTML = '<option value="">-- Select strike --</option>';
  strikeSel.disabled = true;
  if(!ticker||!expDate) return;

  const strikes = _getCallStrikesForExpiration(ticker, expDate);
  const snap = S.get('snap_'+ticker);
  const price = snap?.price || 0;

  if(!strikes.length){
    strikeSel.innerHTML = '<option value="">No call strikes cached for this expiration</option>';
    return;
  }
  strikes.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    const otmPct = price > 0 ? ((s - price) / price * 100) : null;
    const moneyness = otmPct !== null
      ? (otmPct >= 0 ? otmPct.toFixed(1)+'% OTM' : Math.abs(otmPct).toFixed(1)+'% ITM')
      : '';
    opt.textContent = '$' + s.toFixed(2) + (moneyness ? ' — ' + moneyness : '');
    strikeSel.appendChild(opt);
  });
  strikeSel.disabled = false;
}

function _onCCStrikeChange(){
  // Nothing extra needed -- stock price is already pre-filled on ticker change
}

function _confirmAddCC(){
  const ticker          = document.getElementById('cc-ticker-sel')?.value;
  const expDate         = document.getElementById('cc-exp-sel')?.value;
  const strike          = parseFloat(document.getElementById('cc-strike-sel')?.value);
  const contracts       = Math.max(1, parseInt(document.getElementById('cc-contracts')?.value)||1);
  const stockPriceAtWrite = parseFloat(document.getElementById('cc-stock-price-at-write')?.value);

  if(!ticker||!expDate||!strike){
    toast('Please select ticker, expiration and strike');
    return;
  }
  if(!stockPriceAtWrite||stockPriceAtWrite<=0){
    toast('Please enter the stock price at time of writing');
    return;
  }

  // Use account captured at modal-open time (race condition guard)
  const targetAcctId = _pendingModalAccountId || _activeAccountId;
  const ccKey = _acctKeyFor(targetAcctId, 'cc_positions');
  const positions = S.get(ccKey) || [];
  const id = 'cc_' + Date.now();
  positions.push({id, ticker, strike, expDate, contracts, stockPriceAtWrite, addedTs: new Date().toISOString()});
  S.set(ccKey, positions);
  _closeAddCCModal();
  recalcIncome();
  toast('CC position added: ' + ticker + ' $' + strike.toFixed(0) + ' call x' + contracts);
}

let _pendingRemoveCCId = null;

function _openRemoveCCModal(id){
  _pendingRemoveCCId = id;
  _pendingModalAccountId = _activeAccountId; // capture account at open time
  _setModalOpen(true);
  const pos = _loadCCPositions().find(p => p.id === id);
  if(!pos){ _setModalOpen(false); return; }

  let el = document.getElementById('cc-remove-modal');
  if(!el){
    el = document.createElement('div');
    el.className = 'modal-overlay';
    el.id = 'cc-remove-modal';
    el.innerHTML =
      '<div class="modal-box">' +
        '<div class="modal-title">Remove CC position?</div>' +
        '<div class="modal-body" id="crm-body"></div>' +
        '<div style="display:flex;gap:8px">' +
          '<button class="btn btn-secondary btn-sm" id="crm-cancel">Cancel</button>' +
          '<button class="btn btn-danger btn-sm" id="crm-confirm">Remove</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    document.getElementById('crm-cancel').addEventListener('click', () => {
      _pendingRemoveCCId = null;
      _pendingModalAccountId = null;
      _setModalOpen(false);
      el.classList.remove('open');
    });
    document.getElementById('crm-confirm').addEventListener('click', _confirmRemoveCC);
    el.addEventListener('click', e => {
      if(e.target===el){_pendingRemoveCCId=null;_pendingModalAccountId=null;_setModalOpen(false);el.classList.remove('open');}
    });
  }
  document.getElementById('crm-body').textContent =
    'Remove ' + pos.ticker + ' $' + pos.strike.toFixed(0) +
    ' call expiring ' + pos.expDate + ' (' + pos.contracts + ' contract' +
    (pos.contracts>1?'s':'')+', stock at $'+pos.stockPriceAtWrite.toFixed(2)+' at write)?';
  el.classList.add('open');
}

function _confirmRemoveCC(){
  const id = _pendingRemoveCCId;
  const acctId = _pendingModalAccountId || _activeAccountId;
  _pendingRemoveCCId = null;
  _pendingModalAccountId = null;
  _setModalOpen(false);
  document.getElementById('cc-remove-modal')?.classList.remove('open');
  if(!id) return;
  // Use captured account ID
  const ccKey = _acctKeyFor(acctId, 'cc_positions');
  S.set(ccKey, (S.get(ccKey)||[]).filter(p => p.id !== id));
  recalcIncome();
  toast('CC position removed');
}

// ── CC position list renderer ─────────────────────────────────────────────────

function _renderCCPositionList(){
  const positions = _loadCCPositions();
  const keep = positions.filter(p => _posExpiryStatus(p) !== 'remove');
  if(keep.length !== positions.length) _saveCCPositions(keep);

  const activeNotional = keep
    .filter(p => {
      const s = _posExpiryStatus(p);
      return s==='active'||s==='expiring-soon'||s==='expiring-imminent';
    })
    .reduce((sum,p) => sum + _ccPosNotional(p), 0);

  const STATUS_STYLE = {
    'active':            {border:'rgba(0,212,170,0.3)', bg:'rgba(0,212,170,0.06)', label:'',        labelColor:''},
    'expiring-soon':     {border:'rgba(255,165,2,0.5)', bg:'rgba(255,165,2,0.08)', label:'Exp ≤7d', labelColor:'var(--warn)'},
    'expiring-imminent': {border:'rgba(255,71,87,0.6)', bg:'rgba(255,71,87,0.08)', label:'Exp ≤2d', labelColor:'var(--red)'},
    'expired-linger':    {border:'rgba(85,88,112,0.3)', bg:'rgba(85,88,112,0.06)', label:'Expired', labelColor:'var(--text3)'},
  };

  const clearExpiredBtn = keep.some(p => _posExpiryStatus(p)==='expired-linger')
    ? '<button class="btn btn-secondary" style="font-size:10px;padding:4px 10px;margin-top:6px" onclick="_clearExpiredCCPositions()">Clear Expired</button>'
    : '';

  const sorted = _sortCCPositions(keep);

  const rows = sorted.map(pos => {
    const status = _posExpiryStatus(pos);
    const ss = STATUS_STYLE[status];
    const notional = _ccPosNotional(pos);
    const expired = status === 'expired-linger';
    const today = new Date(); today.setHours(0,0,0,0);
    const exp = new Date(pos.expDate+'T12:00:00Z');
    const daysUntil = Math.round((exp-today)/86400000);
    const daysStr = expired
      ? 'Expired '+Math.abs(daysUntil)+'d ago'
      : daysUntil===0?'Expires today':'Exp in '+daysUntil+'d';
    const snap = S.get('snap_'+pos.ticker);
    const currentPrice = snap?.price||null;
    const priceDiff = currentPrice&&pos.stockPriceAtWrite
      ? ((currentPrice-pos.stockPriceAtWrite)/pos.stockPriceAtWrite*100)
      : null;
    const nearStrike = currentPrice&&pos.strike
      ? ((pos.strike-currentPrice)/currentPrice*100)
      : null;

    return '<div style="background:'+ss.bg+';border:1px solid '+ss.border+';border-radius:8px;padding:10px;margin-bottom:6px;'+(expired?'opacity:0.5':'')+'">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start">' +
        '<div style="flex:1">' +
          '<div style="font-family:var(--mono);font-size:13px;font-weight:700;color:'+(expired?'var(--text3)':L2_TEXT)+'">'+
            pos.ticker+' $'+pos.strike.toFixed(0)+' call'+
            (ss.label?'<span style="font-size:9px;color:'+ss.labelColor+';margin-left:6px;font-weight:400">'+ss.label+'</span>':'')+
          '</div>'+
          '<div style="font-family:var(--mono);font-size:10px;color:var(--text3)">'+
            pos.contracts+' contract'+(pos.contracts>1?'s':'')+' · '+pos.expDate+' · '+daysStr+
          '</div>'+
          '<div style="font-family:var(--mono);font-size:10px;color:var(--text3)">'+
            'Written @ $'+pos.stockPriceAtWrite.toFixed(2)+
            (priceDiff!==null?' · now $'+currentPrice.toFixed(2)+(priceDiff>=0?' <span style="color:var(--green)">+'+priceDiff.toFixed(1)+'%</span>':' <span style="color:var(--red)">'+priceDiff.toFixed(1)+'%</span>'):'')+'</div>'+
          (nearStrike!==null&&!expired?
            '<div style="font-family:var(--mono);font-size:9px;color:'+(nearStrike<=5?'var(--warn)':'var(--text3)')+'">'+
              'Strike '+(nearStrike>=0?nearStrike.toFixed(1)+'% above':Math.abs(nearStrike).toFixed(1)+'% below')+' current price'+
              (nearStrike<=5&&nearStrike>=0?' &#x26A0; Call-away risk':'')+(nearStrike<0?' &#x26A0; ITM':'')+
            '</div>':'')+
          '<div style="font-family:var(--mono);font-size:10px;color:'+(expired?'var(--text3)':L2_TEXT)+'">'+
            _fmtDollar(notional)+' notional'+(expired?' (excluded)':'')+
          '</div>'+
        '</div>'+
        '<button style="background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer;padding:4px 8px" '+
          'onclick="_openRemoveCCModal(\''+pos.id+'\')">&times;</button>'+
      '</div>'+
    '</div>';
  }).join('');

  const emptyMsg = keep.length===0
    ? '<div style="font-family:var(--mono);font-size:11px;color:var(--text3);text-align:center;padding:12px 0">No CC positions entered. Tap Add CC Position to begin.</div>'
    : '';

  return {
    html:
      '<div style="margin-bottom:6px">'+
        (keep.length>0
          ?'<div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:8px">'+
              'Active notional: <span style="color:'+L2_TEXT+';font-weight:600">'+_fmtDollar(activeNotional)+'</span>'+
            '</div>'
          :'')+
        rows+emptyMsg+clearExpiredBtn+
      '</div>',
    activeNotional
  };
}

function _clearExpiredCCPositions(){
  _saveCCPositions(_loadCCPositions().filter(p => _posExpiryStatus(p)!=='expired-linger'));
  recalcIncome();
  toast('Expired CC positions cleared');
}
