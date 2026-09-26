// Income Engine -- settings.js
// Settings panel: open/close, save, conviction weights, storage, worker health.
// Globals used: FINNHUB_KEY, watchlist, vixThreshold, tzPref, offlineMode, fontSize, S
// Dependencies: helpers.js, ui.js, storage.js

// Base max point contributions per factor (must match scoring.js)
// FACTOR_BASE_MAX defined in scoring.js

function getConvictionWeights(){
  const defaults={ivr:1.0,rsi:1.0,range:1.0,apy:1.0,earnings:1.0,ma:1.0,upside:1.0,beta:1.0,oiGap:1.0};
  return{...defaults,...(S.get('conviction_weights')||{})};
}

function saveConvictionWeights(){
  const keys=['ivr','rsi','range','apy','earnings','ma','upside','beta','oiGap'];
  const weights={};
  keys.forEach(k=>{
    const el=document.getElementById('weight-'+k);
    if(el)weights[k]=Math.max(0,Math.min(3,parseFloat(el.value)||1.0));
  });
  S.set('conviction_weights',weights);
  toast('Conviction weights saved');
}

function resetConvictionWeights(){
  const defaults={ivr:1.0,rsi:1.0,range:1.0,apy:1.0,earnings:1.0,ma:1.0,upside:1.0,beta:1.0,oiGap:1.0};
  S.set('conviction_weights',defaults);
  loadWeightSliders();
  toast('Weights reset to defaults');
}

// Factor base max points (must match scoring.js FACTOR_BASE_MAX)
// FACTOR_BASE_MAX defined in scoring.js

const FACTOR_DESCRIPTIONS={
  ivr:'Historical Volatility Rank -- measures how elevated the stock\'s own recent realized volatility is vs its past year (not implied volatility from options prices). High HVR means the stock has been moving more than usual for itself, which tends to mean richer premiums. The most important factor for income generation.',
  rsi:'Relative Strength Index -- momentum (0-100). For puts, oversold (below 35) is favorable since the stock has pulled back. For calls, overbought (above 70) is favorable. Neutral RSI is neither good nor bad.',
  range:'52-week range position. For puts, lower in the range (near annual lows) means more downside cushion above your strike. For calls, upper half of range is favorable.',
  apy:'Estimated annualized yield of the recommended strike. Higher APY relative to your target (12%) directly improves the income thesis. Set to 0x to remove APY from scoring entirely.',
  earnings:'Proximity to the next earnings announcement. Within 35 days is penalized -- earnings create overnight gap risk. This is a pure penalty. Increase weight to be more conservative around earnings.',
  ma:'Moving average trend -- whether price is above its 50-day and 200-day MAs. Above both confirms an uptrend. Below both is a caution signal for put selling.',
  upside:'Analyst consensus price target distance from current price. Large upside to target (15%+) suggests analysts see the stock as undervalued, adding confidence for put selling.',
  beta:'Market sensitivity. High beta (above 1.8) means wider price swings and higher assignment risk. Increase weight to penalize volatile stocks more heavily in your scoring.',
  oiGap:'OI Gravity Gap -- the distance between current price and the strike with the highest open interest. For puts, a wide gap below (20%+) means the max-OI anchor is far beneath you, giving a comfortable runway. Increase weight if this factor matters most to your trade selection.'
};

function updateWeightShares(){
  const keys=['ivr','rsi','range','apy','earnings','ma','upside','beta','oiGap'];
  const weights={};
  keys.forEach(k=>{
    const el=document.getElementById('weight-'+k);
    weights[k]=el?parseFloat(el.value)||0:0;
  });
  const total=keys.reduce((s,k)=>s+(FACTOR_BASE_MAX[k]||1)*(weights[k]||0),0);
  keys.forEach(k=>{
    const share=total>0?Math.round((FACTOR_BASE_MAX[k]||1)*(weights[k]||0)/total*100):0;
    const shareEl=document.getElementById('weight-share-'+k);
    const barEl=document.getElementById('weight-bar-'+k);
    if(shareEl)shareEl.textContent=share+'%';
    if(barEl)barEl.style.width=Math.min(share,100)+'%';
  });
}

function loadWeightSliders(){
  const w=getConvictionWeights();
  const keys=['ivr','rsi','range','apy','earnings','ma','upside','beta','oiGap'];
  keys.forEach(k=>{
    const el=document.getElementById('weight-'+k);
    const valEl=document.getElementById('weight-val-'+k);
    if(el){el.value=w[k]||1.0;}
    if(valEl){valEl.textContent=(w[k]||1.0).toFixed(1)+'x';}
  });
  updateWeightShares();
}


async function checkFlightModeReady(){
  const el=document.getElementById('flight-mode-display');
  if(!el){console.error('flight-mode-display element not found');return;}
  el.innerHTML='<div style="color:var(--text3)">Checking...</div>';
  try{
  const now=Date.now();
  const maxAge=24*60*60*1000; // 24 hours -- reasonable for a flight
  const checks=[];

  // Helper: age in hours
  const ageHrs=rec=>{
    // Accepts a whole cache record ({ts,tsEpoch}) or a legacy bare ts string.
    const e=_recEpoch(rec);
    return e==null?null:(now-e)/3600000;
  };
  const ageStr=hrs=>{
    if(hrs===null)return'missing';
    if(hrs<1)return Math.round(hrs*60)+'m old';
    return hrs.toFixed(1)+'h old';
  };
  const ok=v=>v!==null&&v<24;

  // 1. Watchlist snaps -- in-memory global, not S.get('watchlist') directly
  // (see the same fix and reasoning in ticker.js's refreshSingleTicker).
  const wl=watchlist;
  let snapMissing=0,snapStale=0;
  wl.forEach(t=>{
    const sn=S.get('snap_'+t);
    if(!sn){snapMissing++;return;}
    const hrs=ageHrs(sn);
    if(!ok(hrs))snapStale++;
  });
  const snapStatus=snapMissing>0?'red':snapStale>0?'amber':'green';
  checks.push({label:'Ticker data ('+wl.length+' tickers)',
    status:snapStatus,
    detail:snapMissing>0?snapMissing+' tickers missing':snapStale>0?snapStale+' tickers stale':'All fresh'});

  // 2. Price history -- checks hist2y_ specifically, the app's actual
  // single source of truth for price history everywhere else (HVR,
  // relative performance, Bollinger Bands, Multiple History). Previously
  // checked a 'hist_'+ticker key that is never written by any code path
  // in the current architecture (hist6mo is always a derived, in-memory
  // slice of hist2y_, never its own persisted cache) -- meaning this
  // check silently reported every ticker as missing, always, regardless
  // of actual state, since it was auditing a key that structurally can't
  // exist. Real, if quiet, bug: a Flight Mode check that could never pass.
  let histMissing=0;
  wl.forEach(t=>{if(!S.get('hist2y_'+t))histMissing++;});
  checks.push({label:'Price history (2Y)',status:histMissing>0?'red':'green',
    detail:histMissing>0?histMissing+' missing':'All cached'});

  // 3. Options chains
  let optsMissing=0,optsZeroOI=0;
  wl.forEach(t=>{
    const o=S.get('options_'+t);
    if(!o){optsMissing++;return;}
    const nearEntry=_nearestExpEntry(t);
    const puts=nearEntry?_expPuts(nearEntry):[];
    const totalOI=puts.reduce((s,p)=>s+(p.openInterest||0),0);
    if(totalOI===0)optsZeroOI++;
  });
  const optsStatus=optsMissing>0?'red':optsZeroOI>0?'amber':'green';
  checks.push({label:'Options chains',status:optsStatus,
    detail:optsMissing>0?optsMissing+' missing':optsZeroOI>0?optsZeroOI+' have zero OI (fetch during market hours)':'All cached with OI'});

  // 4. VIX history
  const vixH=S.get('vix_hist');
  const vixAge=vixH?.ts?ageHrs(vixH):null;
  checks.push({label:'VIX data',status:ok(vixAge)?'green':'red',
    detail:vixAge!==null?ageStr(vixAge):'not cached'});

  // 5. ETF data
  const spyiDiv=S.get('div_etf_SPYI');
  const nbosDiv=S.get('div_etf_NBOS');
  const etfStatus=(!spyiDiv||!nbosDiv)?'red':'green';
  checks.push({label:'ETF data (SPYI/NBOS)',status:etfStatus,
    detail:etfStatus==='green'?'Cached':'Missing -- refresh ETF tab'});

  // 6. Market data
  const mktTsRaw=S.get('mkt_ts');
  const mktAge=ageHrs(mktTsRaw);
  checks.push({label:'Market data',status:ok(mktAge)?'green':'red',
    detail:mktAge!==null?ageStr(mktAge):'not cached'});

  // 7. News (non-critical, amber only)
  let newsMissing=0;
  wl.forEach(t=>{if(!S.get('news_'+t))newsMissing++;});
  checks.push({label:'Ticker news',status:newsMissing>0?'amber':'green',
    detail:newsMissing>0?newsMissing+' tickers missing news':'All cached'});

  // Overall
  const hasRed=checks.some(c=>c.status==='red');
  const hasAmber=checks.some(c=>c.status==='amber');
  const overall=hasRed?'red':hasAmber?'amber':'green';
  const overallLabel=hasRed?'NOT READY -- fetch data before flying':hasAmber?'MOSTLY READY -- minor gaps':'READY FOR FLIGHT';
  const overallColor=hasRed?'var(--red)':hasAmber?'var(--warn)':'var(--green)';

  const rowsHtml=checks.map(c=>{
    const dot=c.status==='green'?'&#x1F7E2;':c.status==='amber'?'&#x1F7E1;':'&#x1F534;';
    return '<div style="display:flex;gap:8px;align-items:baseline;margin-bottom:6px;font-family:var(--mono);font-size:11px">'
      +'<span style="flex-shrink:0">'+dot+'</span>'
      +'<div><div style="color:var(--text)">'+c.label+'</div>'
      +'<div style="color:var(--text3);font-size:10px">'+c.detail+'</div></div>'
      +'</div>';
  }).join('');

  el.innerHTML='<div style="font-family:var(--mono);font-size:13px;font-weight:600;color:'+overallColor+';margin-bottom:10px">'+overallLabel+'</div>'
    +rowsHtml
    +'<div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-top:8px">Run Full Refresh Everything before flights to ensure all data is fresh.</div>';
  }catch(e){
    console.error('Flight check error:',e);
    if(el)el.innerHTML='<span style="color:var(--red)">Check failed: '+e.message+'</span>';
  }
}

// Shared by measureStorage() and measureRealStorageCapacity() -- total bytes
// currently used across all of localStorage (UTF-16, 2 bytes/char, same
// convention as the rest of this file's byte accounting).
function _totalLocalStorageBytes(){
  let total=0;
  for(let i=0;i<localStorage.length;i++){
    const k=localStorage.key(i);
    total+=(localStorage.getItem(k)||'').length*2;
  }
  return total;
}

// Optional, explicit-opt-in test that empirically finds this device's real
// localStorage ceiling, since no browser API reports it directly on iOS
// Safari. Writes throwaway keys in a fixed-size chunk until the first
// QuotaExceededError, then halves the chunk size and keeps writing from
// where it left off, repeating until the chunk size drops below a small
// floor -- narrowing in on the boundary rather than settling for whatever
// the first coarse chunk size happened to land on. Every write is
// completely synchronous (no awaits inside the loop), so nothing else in
// the app can interleave a real write attempt while this is running close
// to the edge. All throwaway keys are cleaned up in a finally block
// regardless of how the loop ends, and a startup safety net (see
// _cleanupStrayStorageTestKeys, called from init) catches any that
// somehow survive an interruption (e.g. the app being backgrounded
// mid-test). The measured result is stored locally only -- deliberately
// not added to EXPORT_KEYS_STATIC or any of the export prefix patterns,
// since it describes this specific device, not portable app data.
function measureRealStorageCapacity(){
  const btn=document.getElementById('storage-capacity-test-btn');
  const el=document.getElementById('storage-display');
  if(btn)btn.disabled=true;
  if(el)el.textContent='Measuring real storage capacity...';

  const PREFIX='_storagetest_';
  const MIN_CHUNK_BYTES=512;
  let chunkBytes=51200; // 50KB starting point
  let writtenBytes=0;
  let keyIdx=0;
  const preTestBytes=_totalLocalStorageBytes();

  try{
    while(chunkBytes>=MIN_CHUNK_BYTES){
      try{
        // Each character is one UTF-16 code unit (2 bytes) -- matches the
        // length*2 convention used everywhere else in this file.
        localStorage.setItem(PREFIX+keyIdx,'x'.repeat(Math.floor(chunkBytes/2)));
        writtenBytes+=chunkBytes;
        keyIdx++;
      }catch(e){
        const isQuota=e&&(e.name==='QuotaExceededError'||e.code===22);
        if(!isQuota){
          console.warn('Unexpected error during storage capacity test, stopping early:',e?.message);
          break;
        }
        chunkBytes=Math.floor(chunkBytes/2);
      }
    }
  }finally{
    for(let i=0;i<keyIdx;i++)localStorage.removeItem(PREFIX+i);
  }

  const measuredTotalKB=Math.round((preTestBytes+writtenBytes)/1024);
  S.set('_storage_capacity_kb',{kb:measuredTotalKB,measuredAt:nowPT()});
  if(btn)btn.disabled=false;
  measureStorage();
}

// Startup safety net -- if measureRealStorageCapacity() was somehow
// interrupted before its own finally block could clean up (e.g. the app
// backgrounded mid-test), remove any surviving throwaway keys on next load
// rather than leaving them to silently eat into real storage headroom.
function _cleanupStrayStorageTestKeys(){
  const stray=[];
  for(let i=0;i<localStorage.length;i++){
    const k=localStorage.key(i);
    if(k&&k.startsWith('_storagetest_'))stray.push(k);
  }
  stray.forEach(k=>localStorage.removeItem(k));
}

async function measureStorage(){
  const el=document.getElementById('storage-display');
  if(!el)return;
  el.textContent='Measuring...';
  // Get quota via Storage API -- kept only as a secondary, clearly-labeled
  // figure. On iOS Safari this reflects the modern Storage API's own quota
  // (mostly the service worker's app-shell cache), NOT localStorage's real,
  // separate, much smaller ceiling -- localStorage has historically been
  // capped independently by WebKit (commonly ~5-10MB, observed to vary by
  // device/iOS version) and isn't visible through this API at all. Showing
  // "0% used" here while actually nearing localStorage's real wall is
  // actively misleading, which is why the localStorage total below is now
  // the headline figure instead.
  let usedMB='?',quotaMB='?';
  try{
    const est=await navigator.storage.estimate();
    usedMB=(est.usage/1048576).toFixed(1);
    quotaMB=(est.quota/1048576).toFixed(0);
  }catch{}
  // Break down by category + key count
  const cats={options:0,history:0,snap:0,news:0,other:0};
  const keyCounts={options:0,history:0,snap:0,news:0,other:0};
  for(let i=0;i<localStorage.length;i++){
    const k=localStorage.key(i);
    const bytes=(localStorage.getItem(k)||'').length*2;
    if(k.startsWith('options')){cats.options+=bytes;keyCounts.options++;}
    else if(k.startsWith('hist')){cats.history+=bytes;keyCounts.history++;}
    else if(k.startsWith('snap')){cats.snap+=bytes;keyCounts.snap++;}
    else if(k.startsWith('news')||k==='market_news'){cats.news+=bytes;keyCounts.news++;}
    else{cats.other+=bytes;keyCounts.other++;}
  }
  const fmt=b=>(b/1024).toFixed(0)+'KB';
  const totalLS=Object.values(cats).reduce((a,b)=>a+b,0);
  const totalKeys=localStorage.length;
  // Prefer a real measured capacity for this device if one exists; fall
  // back to the generic, clearly-labeled estimate otherwise.
  const measured=S.get('_storage_capacity_kb');
  const budgetKB=measured?.kb||5120;
  const budgetLabel=measured
    ?'measured '+(measured.kb/1024).toFixed(1)+'MB capacity for this device (tested '+measured.measuredAt+')'
    :'a typical ~'+(budgetKB/1024)+'MB budget (estimate, not measured on this device -- see "Measure Real Storage Limit" below)';
  const lsPct=Math.min(Math.round(totalLS/1024/budgetKB*100),100);
  const lsBarColor=lsPct>=90?'var(--red)':lsPct>=70?'var(--warn)':'var(--accent)';
  el.innerHTML='<div style="margin-bottom:4px">localStorage: <b>'+fmt(totalLS)+'</b> ('+totalKeys+' keys) -- roughly '+lsPct+'% of '+budgetLabel+'</div>'
    +'<div style="background:var(--bg2);border-radius:4px;height:6px;margin-bottom:4px"><div style="background:'+lsBarColor+';height:6px;border-radius:4px;width:'+lsPct+'%"></div></div>'
    +(measured?'':'<div style="color:var(--text3);font-size:9px;margin-bottom:8px">iOS Safari doesn\'t report localStorage\'s real limit -- this budget is an estimate, not a confirmed number. Actual ceilings vary by device/iOS version.</div>')
    +'<div>Options chains: '+fmt(cats.options)+' ('+keyCounts.options+' keys)</div>'
    +'<div>Price history: '+fmt(cats.history)+' ('+keyCounts.history+' keys)</div>'
    +'<div>Ticker snaps: '+fmt(cats.snap)+' ('+keyCounts.snap+' keys)</div>'
    +'<div>News: '+fmt(cats.news)+' ('+keyCounts.news+' keys)</div>'
    +'<div>Other: '+fmt(cats.other)+' ('+keyCounts.other+' keys)</div>'
    +'<div style="margin-top:8px;color:var(--text3);font-size:9px">Storage API (app shell + service worker cache, separate from localStorage): '+usedMB+'MB / '+quotaMB+'MB</div>';
}

async function workerHealthCheck(){
  const el=document.getElementById('worker-health-display');
  if(!el)return;
  el.textContent='Testing Worker...';
  const t0=Date.now();
  try{
    // Ping the Worker with a lightweight quote request for a well-known ticker
    const r=await fetch(WORKER_URL+'/?ticker=SPY&type=quote',{signal:AbortSignal.timeout(8000)});
    const latency=Date.now()-t0;
    if(!r.ok){el.innerHTML='<span style="color:var(--red)">Worker returned HTTP '+r.status+' ('+latency+'ms)</span>';return;}
    const d=await r.json();
    const price=d?.quoteResponse?.result?.[0]?.regularMarketPrice;
    if(price){
      el.innerHTML='<span style="color:var(--green)">Worker OK &mdash; '+latency+'ms latency</span>'
        +'<div style="color:var(--text3);font-size:10px;margin-top:2px">Yahoo auth working &middot; SPY quote: $'+price.toFixed(2)+'</div>';
    }else{
      el.innerHTML='<span style="color:var(--warn)">Worker reachable but Yahoo auth may be stale ('+latency+'ms)</span>'
        +'<div style="color:var(--text3);font-size:10px;margin-top:2px">Response received but no price data. Try refreshing data.</div>';
    }
  }catch(e){
    const latency=Date.now()-t0;
    el.innerHTML='<span style="color:var(--red)">Worker unreachable ('+latency+'ms) &mdash; '+e.message.slice(0,60)+'</span>'
      +'<div style="color:var(--text3);font-size:10px;margin-top:2px">Check your internet connection and Cloudflare Worker status.</div>';
  }
}

// Populate the options cache cutoff dropdown with hours 1pm-11pm ET
// expressed in the currently selected timezone.
function _populateCutoffSelect(){
  const sel=document.getElementById('options-cutoff-input');
  if(!sel)return;
  const savedET=parseInt(S.get('options_cutoff_et')||'18');
  // ET hours 13-23 (1pm-11pm)
  const etHours=Array.from({length:11},(_,i)=>i+13);
  // Compute offset from ET to display timezone
  // ET = America/New_York; get current offset difference
  function etToDisplay(etHour){
    // Create a date with that ET hour today
    const now=new Date();
    const etStr=now.toLocaleDateString('en-US',{timeZone:'America/New_York'});
    const [m,d,y]=etStr.split('/');
    const pad=n=>String(n).padStart(2,'0');
    // Build ISO string in ET
    const etDate=new Date(`${y}-${pad(m)}-${pad(d)}T${pad(etHour)}:00:00`);
    // Get display in selected timezone
    const tz=document.getElementById('tz-pref-input')?.value||tzPref||'PT';
    const tzName=tz==='PT'?'America/Los_Angeles':tz==='UTC'?'UTC':Intl.DateTimeFormat().resolvedOptions().timeZone;
    const label=etDate.toLocaleTimeString('en-US',{timeZone:tzName,hour:'numeric',minute:'2-digit',hour12:true});
    const tzLabel=tz==='PT'?'PT':tz==='UTC'?'UTC':'local';
    return label+' '+tzLabel;
  }
  sel.innerHTML=etHours.map(h=>`<option value="${h}"${h===savedET?' selected':''}>${etToDisplay(h)}</option>`).join('');
}

// Populate the state dropdown (Income tab tax-equivalent yield setting).
// Options built from US_STATES (income.js) rather than hand-written here,
// so there's one list to keep in sync, not two.
function _populateTaxStateSelect(){
  const sel=document.getElementById('tax-state-sel');
  if(!sel||typeof US_STATES==='undefined')return;
  const current=getTaxState();
  sel.innerHTML=US_STATES.map(s=>{
    const label=isNoIncomeTaxState(s)?s+' (no income tax)':s;
    return`<option value="${s}"${s===current?' selected':''}>${label}</option>`;
  }).join('');
}

// ── FOMC meeting dates (Fed Funds Futures probability breakdown, Market tab) ──
// Self-service editing for exactly the scenario where nobody's available to
// push a code update -- the Fed publishes these on its own site once a
// year, so anyone can copy the 8 new dates in by hand. See
// _effectiveFomcDates() in market.js for how a saved override here takes
// over from the built-in list.
function _renderFomcDatesEditor(){
  const ta=document.getElementById('fomc-dates-textarea');
  if(!ta||typeof _effectiveFomcDates!=='function')return;
  ta.value=_effectiveFomcDates().join('\n');
}
function saveFomcDates(){
  const ta=document.getElementById('fomc-dates-textarea');
  if(!ta)return;
  const lines=ta.value.split('\n').map(l=>l.trim()).filter(l=>l.length);
  const valid=[],invalid=[],duplicateMonths=[];
  const CURRENT_YEAR=new Date().getFullYear();
  const seenMonths=new Set();
  lines.forEach(l=>{
    // Strictly YYYY-MM-DD -- matches the format used throughout the rest
    // of the app, and avoids ambiguous MM/DD vs DD/MM parsing. Uses the
    // same real-calendar-date check as the Worker's EFFR route (not
    // `!isNaN(new Date(...))`, which silently rolls e.g. 2026-02-30
    // forward into March rather than rejecting it).
    if(!/^\d{4}-\d{2}-\d{2}$/.test(l)||!_isValidISODate(l)){invalid.push(l);return;}
    const year=parseInt(l.slice(0,4),10);
    // A generous window either side of "now" -- wide enough to never
    // reject a real, deliberately-entered date, narrow enough to catch
    // an obvious typo (a transposed digit landing decades off).
    if(year<CURRENT_YEAR-5||year>CURRENT_YEAR+10){invalid.push(l);return;}
    const monthKey=l.slice(0,7); // YYYY-MM
    if(seenMonths.has(monthKey)){duplicateMonths.push(l);return;}
    seenMonths.add(monthKey);
    valid.push(l);
  });
  if(invalid.length){
    toast('Not saved -- '+invalid.length+' line(s) invalid (not a real YYYY-MM-DD calendar date, or outside a reasonable year range): '+invalid.slice(0,3).join(', ')+(invalid.length>3?'...':''),5000);
    return;
  }
  if(duplicateMonths.length){
    // The FOMC has never actually held two scheduled meetings in the same
    // calendar month -- this almost always means a typo'd duplicate
    // rather than a genuine second meeting, so it's treated as a hard
    // stop rather than a silent accept.
    toast('Not saved -- more than one meeting in the same month: '+duplicateMonths.slice(0,3).join(', ')+(duplicateMonths.length>3?'...':'')+'. The FOMC has never held two scheduled meetings in one calendar month -- if this is a typo, fix the duplicate date and save again.',6000);
    return;
  }
  if(!valid.length){
    toast('Not saved -- list is empty. Use Reset to Defaults to start over.',4000);
    return;
  }
  // The FOMC normally holds 8 meetings/year -- not enforced as a hard
  // rule (a genuine reason to track more or fewer is possible), just
  // surfaced so an obviously-wrong count doesn't save silently unnoticed.
  if(valid.length<6||valid.length>10){
    toast('Saved '+valid.length+' meeting date(s) -- unusual count (FOMC normally holds 8/year). Double-check if this wasn\'t intentional.',5000);
  }
  const deduped=[...new Set(valid)].sort();
  S.set('fomc_meeting_dates_override',deduped);
  ta.value=deduped.join('\n');
  toast('FOMC meeting dates saved ('+deduped.length+' dates)',3000);
}
function resetFomcDatesToDefault(){
  S.del('fomc_meeting_dates_override');
  _renderFomcDatesEditor();
  toast('Reset to built-in defaults',2500);
}

function openSettings(){
  _checkForAppUpdate();
  document.getElementById('finnhub-key-input').value=FINNHUB_KEY;
  document.getElementById('worker-fragment-settings-input').value=S.get('worker_fragment')||'';
  document.getElementById('default-watchlist-input').value=watchlist.join(',');
  document.getElementById('vix-threshold-input').value=vixThreshold;
  document.getElementById('prefetch-sleep-input').value=parseInt(S.get('prefetch_sleep_ms'))||100;
  document.getElementById('tz-pref-input').value=tzPref;
  document.getElementById('offline-mode-input').checked=offlineMode;
  document.getElementById('debug-options-fetch-input').checked=S.get('debug_options_fetch')==='true';
  document.getElementById('fetch-upgrades-input').checked=S.get('fetch_upgrades_enabled')==='true';
  document.getElementById('wheelbt-term-structure-input').checked=S.get('wheelbt_term_structure_enabled')!=='false';
  document.getElementById('font-size-input').value=fontSize;
  loadWeightSliders();
  _populateCutoffSelect();
  _populateTaxStateSelect();
  _renderFomcDatesEditor();
  document.getElementById('state-tax-rate-input').value=getStateTaxRatePct();
  document.getElementById('settings-overlay').classList.add('open');
}

function closeSettings(){document.getElementById('settings-overlay').classList.remove('open');}

function closeSettingsIfOutside(e){if(e.target===document.getElementById('settings-overlay'))closeSettings();}

function saveSettings(){
  const key=document.getElementById('finnhub-key-input').value.trim();
  if(key){FINNHUB_KEY=key;S.set('finnhub_key',key);}
  const wf=_normalizeWorkerFragment(document.getElementById('worker-fragment-settings-input').value);
  if(wf){S.set('worker_fragment',wf);WORKER_URL=_buildWorkerUrl(wf);}
  const wl=document.getElementById('default-watchlist-input').value.split(',').map(t=>normalizeTicker(t)).filter(Boolean);
  if(wl.length>0){watchlist=wl;S.set('watchlist',wl);}
  vixThreshold=Math.round(finiteNumber(document.getElementById('vix-threshold-input').value,{min:1,max:200,fallback:20}));
  S.set('vix_threshold',String(vixThreshold));
  const _prefetchSleepMs=Math.min(5000,Math.max(100,parseInt(document.getElementById('prefetch-sleep-input').value)||100));
  S.set('prefetch_sleep_ms',String(_prefetchSleepMs));
  tzPref=document.getElementById('tz-pref-input').value;
  S.set('tz_pref',tzPref);
  const cutoffET=parseInt(document.getElementById('options-cutoff-input')?.value)||18;
  S.set('options_cutoff_et',String(cutoffET));
  offlineMode=document.getElementById('offline-mode-input').checked;
  S.set('offline_mode',String(offlineMode));
  S.set('debug_options_fetch',String(document.getElementById('debug-options-fetch-input').checked));
  S.set('fetch_upgrades_enabled',String(document.getElementById('fetch-upgrades-input').checked));
  S.set('wheelbt_term_structure_enabled',String(document.getElementById('wheelbt-term-structure-input').checked));
  updateOfflineModeBar();
  fontSize=document.getElementById('font-size-input').value||'19';
  S.set('font_size',fontSize);
  applyFontSize(fontSize);
  // Re-populate cutoff select so labels reflect new timezone
  _populateCutoffSelect();
  const cv=S.get('vix_hist');
  if(cv?.closes){const c=cv.closes.filter(x=>x!==null);if(c.length)updateVIXIndicator(c[c.length-1]);}
  closeSettings();
  renderWatchlist();
  populateSelects();
  // Restore selected ticker in dropdowns after rebuilding option elements
  if(currentTicker){
    document.getElementById('ticker-select').value=currentTicker;
    document.getElementById('options-ticker-select').value=currentTicker;
  }
  // Immediately re-format all timestamp chips in the newly selected timezone
  refreshTsChipAges();
  toast('Settings saved');
}

function updateOfflineModeBar(){
  const bar=document.getElementById('offline-mode-bar');
  if(bar)bar.style.display=offlineMode?'block':'none';
}

function clearAllDataWithGuard(){
  if(!navigator.onLine){
    document.getElementById('offline-confirm-modal').classList.add('open');
    closeSettings();
  }else{
    if(confirm('Clear all cached data? This cannot be undone.'))clearAllDataConfirmed();
  }
}

function closeOfflineModal(){document.getElementById('offline-confirm-modal').classList.remove('open');}

function clearAllDataConfirmed(){
  closeOfflineModal();
  localStorage.clear();FINNHUB_KEY='';WORKER_URL='';watchlist=[...DEFAULT_WATCHLIST];currentTicker='';offlineMode=false;
  toast('All saved app data cleared'); // localStorage only -- deliberately does not touch Cache Storage (the offline app shell), which stays intact so the PWA still works offline after this
  renderWatchlist();updateVIXIndicator(null);updateOfflineModeBar();
  try{openWorkerSetupOverlay();}catch(e){console.error('Worker setup overlay error:',e);}
}

function clearMarketDataCache(){
  // Keys to preserve -- manually entered data and settings
  const PRESERVE=new Set([
    'watchlist','tz_pref','font_size','vix_threshold','offline_mode',
    'watchlist_sort','heatmap_mode','watchlist_filter_mode','watchlist_starred','put_pos_sort','cc_pos_sort',
    'options_cutoff_et','rp_earnings_toggle','earnings_view_mode','dashboard_view_mode',
    'vol_badge_state','conviction_weights','last_ticker',
    'income_accounts_meta','income_active_account','income_migration_v1',
    'debug_options_fetch','prefetch_sleep_ms','fetch_upgrades_enabled','wheelbt_term_structure_enabled',
  ]);
  const toDelete=[];
  for(let i=0;i<localStorage.length;i++){
    const k=localStorage.key(i);
    if(!k)continue;
    if(PRESERVE.has(k))continue;
    if(k.startsWith('earnings_hist_'))continue;
    if(k.startsWith('earnings_confirmed_'))continue;
    if(k.startsWith('earnings_pending_'))continue;
    // Preserve all income account data (inputs, positions, MMF yields)
    if(k.startsWith('income_acct_'))continue;
    if(k.startsWith('income_'))continue; // catches income_accounts_meta, income_active_account etc.
    if(k.startsWith('conviction_'))continue;
    if(k.startsWith('put_pos'))continue;
    if(k.startsWith('cc_pos'))continue;
    if(k.startsWith('vol_badge'))continue;
    // NOTE: multiple_hist_ and fwdpe_track_ are intentionally NOT swept here,
    // even though this block clears several other per-ticker caches -- they
    // aren't re-fetchable market-data caches, they're accumulated history
    // (see _buildExportData below). Don't widen the prefixes above to catch
    // them; a "hist" or "mult" match here would silently destroy data a
    // refresh can't restore. fed_futures used to be swept here too, but is
    // no longer treated as purely routine -- it can genuinely fail to
    // re-fetch cleanly (an expired CME contract not returning usable data),
    // which is exactly why it now has its own carry-forward preservation
    // and export support. Sweeping it here on every "routine" clear would
    // undo that protection for no reason.
    if(k.startsWith('snap_')||k.startsWith('hist_')||k.startsWith('hist1y_')||
       k.startsWith('hist2y_')||k.startsWith('options_')||k.startsWith('news_')||
       k.startsWith('rec_')||k.startsWith('upgrades_')||
       k.startsWith('mkt_')||k.startsWith('tbills_')||k.startsWith('vix')||
       k.startsWith('div_')||k==='market_news'||
       k==='hist2y_sp500'||
       // fomc_meeting_history: as of 495, every entry is a resolved meeting
       // re-derivable from the NY Fed's official history (or a futures-
       // implied fallback that self-corrects the next time NY Fed data
       // covers it) -- routine, re-fetchable, safe to sweep. Not matched by
       // a shared prefix with fomc_meeting_dates_override (genuine user
       // config, deliberately NOT swept here) or fed_futures (deliberately
       // NOT swept here either, per the comment above), so both are named
       // explicitly rather than widening a prefix.
       k==='fomc_meeting_history'||k==='fomc_effr_cache'){
      toDelete.push(k);
    }
  }
  toDelete.forEach(k=>localStorage.removeItem(k));
  toast('Market data cache cleared ('+toDelete.length+' keys). Run a full refresh to repopulate.',4000);
}

// ── Data Portability: Export / Import ────────────────────────────────────────

const EXPORT_KEYS_STATIC=[
  'watchlist','tz_pref','font_size','vix_threshold',
  'offline_mode','watchlist_sort','heatmap_mode','watchlist_filter_mode','watchlist_starred','put_pos_sort','cc_pos_sort',
  'options_cutoff_et','rp_earnings_toggle','rp_total_return','conviction_weights','earnings_view_mode','dashboard_view_mode',
  'vol_badge_state','last_ticker',
  'etf_research_tickers',
  'income_accounts_meta','income_active_account','income_migration_v1',
  'debug_options_fetch','prefetch_sleep_ms','fetch_upgrades_enabled','wheelbt_term_structure_enabled',
  'dashboard_notes','bb_gap_overlay','gap_list_filter',
  'tax_state','state_tax_rate',
  'fomc_meeting_dates_override',
  // NOTE: fomc_meeting_history used to be listed here (unbounded, exported
  // indefinitely as irreplaceable data). As of the 495 NY-Fed-official-
  // source fix, every entry in that file is now either a genuinely
  // resolved meeting sourced from the New York Fed's own published target-
  // range history (re-derivable at any time -- the NY Fed API serves full
  // history back to 1954) or a futures-implied fallback for a meeting the
  // NY Fed data doesn't cover yet. Neither is irreplaceable the way this
  // export list is meant for, so it's been moved to the routine, re-
  // fetchable Clear Market Data Cache sweep below instead (see
  // clearMarketDataCache). Losing it just means falling back to the honest
  // "insufficient baseline" placeholder until it's rebuilt on the next
  // live fetch, not a correctness problem.
  // The raw Fed Funds Futures contract data itself (not just the derived
  // self-healing rate above) -- exportable specifically so a successful
  // fetch on one device/instance can be transplanted into another that's
  // stuck on a failed fetch for the same month, via a trimmed-down import
  // containing just this one key. Previously only treated as a routine,
  // re-fetchable market-data cache (eligible for the Clear Market Data
  // Cache sweep), which is still correct for ROUTINE refreshes -- this
  // addition is specifically about enabling manual cross-instance repair
  // when a fetch has been failing consistently, not about the normal case.
  'fed_futures',
];

function _buildExportData(){
  const data={_version:'2.0',_exportedAt:new Date().toISOString(),keys:{}};
  // Use S.get which JSON.parses the stored value -- avoids double-stringified values
  EXPORT_KEYS_STATIC.forEach(k=>{
    const v=S.get(k);
    if(v!=null)data.keys[k]=v;
  });
  // Per-ticker earnings history and confirmed/pending caches
  const _allKeys=Object.keys(localStorage);
  _allKeys.forEach(k=>{
    const _k=k.replace(/^"|"$/g,'');
    if(_k.startsWith('earnings_hist_')||_k.startsWith('earnings_confirmed_')||_k.startsWith('earnings_pending_')){
      const v=S.get(_k);
      if(v!=null&&(!Array.isArray(v)||v.length>0))data.keys[_k]=v;
    }
    // Multiple History (TTM & forward P/E): both the permanent per-quarter
    // records and the in-flight dense tracking data. Neither is re-fetchable
    // from Yahoo -- there's no historical forward-estimate endpoint -- so
    // unlike snap_/hist2y_/options_ (deliberately excluded, since a refresh
    // trivially repopulates them), losing either of these without a recent
    // backup is a permanent gap, same reasoning as earnings_hist_ above.
    if(_k.startsWith('multiple_hist_')||_k.startsWith('fwdpe_track_')){
      const v=S.get(_k);
      if(v!=null&&(!Array.isArray(v)||v.length>0))data.keys[_k]=v;
    }
    // Next-FY Multiple & Price Target: same reasoning as Multiple History
    // above -- Yahoo has no historical forward-estimate endpoint, so
    // nextfy_hist_ (permanent, one full series per completed fiscal year)
    // and nextfy_track_ (the in-flight current-year series) are both
    // genuinely irreplaceable if lost.
    if(_k.startsWith('nextfy_hist_')||_k.startsWith('nextfy_track_')){
      const v=S.get(_k);
      if(v!=null&&(!Array.isArray(v)||v.length>0))data.keys[_k]=v;
    }
    // All per-account income keys: income_ACCTID_*
    if(_k.startsWith('income_acct_')){
      const v=S.get(_k);
      if(v!=null)data.keys[_k]=v;
    }
    // Legacy flat income keys (pre-migration backups) -- include if present
    if(_k==='income_inputs'||_k==='income_mmf_yields'||_k==='put_positions'||_k==='cc_positions'){
      const v=S.get(_k);
      if(v!=null)data.keys[_k]=v;
    }
    // Per-ticker watchlist notes
    if(_k.startsWith('watchlist_note_')){
      const v=S.get(_k);
      if(v)data.keys[_k]=v;
    }
    // Per-ticker Relative Performance comparison selections -- a genuine
    // user choice (which ticker to benchmark against), not re-derivable
    // from any fetch. Found missing during a full audit -- same category
    // as watchlist_note_ just above, just never added.
    if(_k.startsWith('rp_compare_')){
      const v=S.get(_k);
      if(v)data.keys[_k]=v;
    }
  });

  return data;
}

function openDataPortabilityModal(){
  // Reset state
  document.getElementById('export-textarea').value='';
  document.getElementById('import-textarea').value='';
  document.getElementById('import-preview').style.display='none';
  document.getElementById('import-preview').innerHTML='';
  document.getElementById('restore-btn').disabled=true;
  document.getElementById('copy-export-btn').disabled=true;
  document.getElementById('share-export-btn').disabled=true;
  document.getElementById('data-portability-modal').classList.add('open');
}

function closeDataPortabilityModal(){
  document.getElementById('data-portability-modal').classList.remove('open');
}

function generateExport(){
  const data=_buildExportData();
  const json=JSON.stringify(data,null,2);
  const ta=document.getElementById('export-textarea');
  ta.value=json;
  const keyCount=Object.keys(data.keys).length;
  document.getElementById('copy-export-btn').disabled=false;
  document.getElementById('share-export-btn').disabled=false;
  toast('Export ready — '+keyCount+' keys',2500);
}

function copyExportToClipboard(){
  const json=document.getElementById('export-textarea').value;
  if(!json){toast('Generate export first');return;}
  navigator.clipboard.writeText(json).then(()=>toast('Copied to clipboard ✓',2500)).catch(()=>{
    // Fallback: select all text in textarea
    const ta=document.getElementById('export-textarea');
    ta.select();ta.setSelectionRange(0,999999);
    document.execCommand('copy');
    toast('Copied to clipboard ✓',2500);
  });
}

function shareExport(){
  const json=document.getElementById('export-textarea').value;
  if(!json){toast('Generate export first');return;}
  const ts=new Date().toISOString().split('T')[0];
  if(navigator.share){
    navigator.share({title:'Income Engine Backup '+ts,text:json})
      .catch(e=>{if(e.name!=='AbortError')toast('Share failed: '+e.message);});
  }else{
    toast('Share not available — use Copy to Clipboard instead');
  }
}

// ── Import preview ────────────────────────────────────────────────────────────

let _parsedImportData=null;

// ── Backup-import write-side validation (Phases 1-3, complete) ───────────────
// Mirrors EXPORT_KEYS_STATIC and _buildExportData's prefix families above --
// those already define what's durable/worth backing up; this defines what a
// VALID value for each of those keys actually looks like, so confirmImport()
// stops writing whatever a parsed backup file happens to contain. A key not
// covered here (not in the registry, or its own value fails validation) is
// dropped rather than written -- see _validateImportKeys below for exactly
// how "dropped" is decided and reported.
//
// Phase 1: watchlist, income_accounts_meta + per-account positions/inputs,
// fomc_meeting_dates_override, and the simple scalar settings in
// EXPORT_KEYS_STATIC.
// Phase 2: the historical-cache prefix families -- earnings_hist_/
// earnings_confirmed_/earnings_pending_ (fully field-validated), and
// multiple_hist_/fwdpe_track_/nextfy_hist_/nextfy_track_ (validated more
// leniently -- see the comment above _finiteOrNull below for why).
// Phase 3: fed_futures, watchlist_note_, rp_compare_, income_acct_*_mmf_yield
// (found during Phase 3 scoping -- had silently fallen through every
// earlier phase, since no prior prefix regex happened to match it), and
// the legacy pre-account-migration flat keys (income_inputs, put_positions,
// cc_positions, income_mmf_yields -- same shape as their per-account
// equivalents, reusing the same validators).
//
// Every key EXPORT_KEYS_STATIC and _buildExportData's prefix sweep actually
// produce is now covered by a validator. What's still NOT covered is a key
// that isn't in this registry AT ALL -- see the comment on "unrecognized
// entirely" in _validateImportKeys below for why that's still deliberately
// passed through rather than rejected.

function _validateBoolean(v){ return v===true||v===false?v:null; }
function _validateEnum(values){ return v=>values.includes(v)?v:null; }
// For settings whose exact enum wasn't worth fully cataloging for Phase 1 --
// still bounded and type-checked (never writes a non-string, never writes
// something absurdly long), just not validated against a specific known set.
function _validateSafeString(maxLen){ return v=>(typeof v==='string')?v.slice(0,maxLen):null; }

function _validateTickerArray(v,maxLen){
  if(!Array.isArray(v))return null;
  const out=[];
  for(const t of v){
    const nt=normalizeTicker(t);
    if(nt&&!out.includes(nt))out.push(nt);
    if(out.length>=maxLen)break;
  }
  return out;
}
function _validateDateArray(v,maxLen){
  if(!Array.isArray(v))return null;
  const out=[];
  for(const d of v){
    if(typeof d==='string'&&_isValidISODate(d)&&!out.includes(d))out.push(d);
    if(out.length>=maxLen)break;
  }
  return out;
}
function _validateConvictionWeights(v){
  if(!v||typeof v!=='object')return null;
  const keys=['ivr','rsi','range','apy','earnings','ma','upside','beta','oiGap'];
  const out={};
  keys.forEach(k=>{ out[k]=finiteNumber(v[k],{min:0,max:3,fallback:1.0}); });
  return out;
}
function _validateAccountMeta(a){
  if(!a||typeof a!=='object')return null;
  if(typeof a.id!=='string'||!/^acct_[A-Za-z0-9_]{1,40}$/.test(a.id))return null;
  if(typeof a.name!=='string'||!a.name.trim())return null;
  return{id:a.id,name:a.name.slice(0,30)};
}
// Shared by both put and CC positions -- isCall adds the one CC-only field.
function _validatePosition(p,isCall){
  if(!p||typeof p!=='object')return null;
  const ticker=normalizeTicker(p.ticker);
  if(!ticker)return null;
  const strike=finiteNumber(p.strike,{min:0.01,max:100000});
  if(strike==null)return null;
  if(typeof p.expDate!=='string'||!_isValidISODate(p.expDate))return null;
  const contractsRaw=finiteNumber(p.contracts,{min:1,max:10000});
  if(contractsRaw==null)return null;
  const contracts=Math.round(contractsRaw);
  // A malformed/missing id is regenerated rather than rejecting the whole
  // position -- the id is an internal handle (used for roll-tracking and
  // removal), not user data, so there's nothing to lose by giving it a
  // fresh one.
  const id=(typeof p.id==='string'&&/^pos_[A-Za-z0-9_]{1,30}$/.test(p.id))?p.id:('pos_'+Date.now()+'_'+Math.random().toString(36).slice(2,7));
  const addedTs=(typeof p.addedTs==='string'&&!isNaN(Date.parse(p.addedTs)))?p.addedTs:new Date().toISOString();
  const out={id,ticker,strike,expDate:p.expDate,contracts,addedTs};
  if(typeof p.rolledAt==='string'&&!isNaN(Date.parse(p.rolledAt)))out.rolledAt=p.rolledAt;
  if(isCall){
    const spw=finiteNumber(p.stockPriceAtWrite,{min:0.01,max:100000});
    if(spw!=null)out.stockPriceAtWrite=spw;
  }
  return out;
}
function _validateIncomeInputs(v){
  if(!v||typeof v!=='object')return null;
  const num=(x,max)=>finiteNumber(x,{min:0,max:max||1e9,fallback:0});
  return{
    tbillAmt:num(v.tbillAmt), fdlxxAmt:num(v.fdlxxAmt), spaxxAmt:num(v.spaxxAmt),
    spyiShares:num(v.spyiShares,1e9), nbosShares:num(v.nbosShares,1e9),
    putsNotional:num(v.putsNotional), ccStockAmt:num(v.ccStockAmt),
    targetAPY:finiteNumber(v.targetAPY,{min:0,max:500,fallback:12}),
    fdlxxYieldManual:(v.fdlxxYieldManual==null)?null:finiteNumber(v.fdlxxYieldManual,{min:0,max:100,fallback:null}),
    spaxxYieldManual:(v.spaxxYieldManual==null)?null:finiteNumber(v.spaxxYieldManual,{min:0,max:100,fallback:null}),
    fdlxxUseManual:v.fdlxxUseManual===true,
    spaxxUseManual:v.spaxxUseManual===true,
  };
}
// Shared by both per-account (income_acct_ID_put_positions) and legacy flat
// (put_positions, pre-migration) keys -- identical shape either way, since
// the migration step just copies the flat key's value verbatim into the
// per-account one (see runIncomeMigration in js/income.js).
function _validatePutPositionsArray(v){ return Array.isArray(v)?v.map(p=>_validatePosition(p,false)).filter(Boolean).slice(0,1000):null; }
function _validateCcPositionsArray(v){ return Array.isArray(v)?v.map(p=>_validatePosition(p,true)).filter(Boolean).slice(0,1000):null; }
function _validateMmfYield(v){
  if(!v||typeof v!=='object')return null;
  return{
    fdlxx:_finiteOrNull(v.fdlxx,{min:0,max:20}),
    spaxx:_finiteOrNull(v.spaxx,{min:0,max:20}),
    ts:(typeof v.ts==='string')?v.ts.slice(0,60):null,
  };
}
function _validateFedFuturesContract(c){
  if(!c||typeof c!=='object')return null;
  if(typeof c.month!=='string'||!/^[A-Za-z]{3} \d{4}$/.test(c.month))return null; // "Sep 2026" style label -- toLocaleDateString's own format
  const impliedRate=finiteNumber(c.impliedRate,{min:-5,max:50}); // generous either side of any real-world Fed funds rate
  if(impliedRate==null)return null;
  const price=finiteNumber(c.price,{min:50,max:110}); // 100-impliedRate convention
  if(price==null)return null;
  const out={ticker:(typeof c.ticker==='string')?c.ticker.slice(0,20):null,month:c.month,price,impliedRate};
  if(c.stale===true){
    out.stale=true;
    out.staleAsOf=(typeof c.staleAsOf==='string')?c.staleAsOf.slice(0,60):null;
    out.staleAsOfEpoch=_finiteOrNull(c.staleAsOfEpoch,{min:0,max:Date.now()+31536000000});
  }
  return out;
}
function _validateFedFutures(v){
  if(!v||typeof v!=='object'||!Array.isArray(v.data))return null;
  return{
    data:v.data.map(_validateFedFuturesContract).filter(Boolean).slice(0,20),
    failedMonths:Array.isArray(v.failedMonths)?v.failedMonths.filter(m=>typeof m==='string').map(m=>m.slice(0,20)).slice(0,20):[],
    ts:(typeof v.ts==='string')?v.ts.slice(0,60):'',
    tsEpoch:_finiteOrNull(v.tsEpoch,{min:0,max:Date.now()+31536000000}),
  };
}

const IMPORT_STATIC_VALIDATORS={
  watchlist: v=>_validateTickerArray(v,500),
  tz_pref: _validateEnum(['PT','UTC','local']),
  font_size: v=>finiteNumber(v,{min:10,max:24}),
  vix_threshold: v=>{const n=finiteNumber(v,{min:1,max:200});return n==null?null:Math.round(n);},
  offline_mode: _validateBoolean,
  watchlist_sort: _validateEnum(['alpha','opportunity']),
  heatmap_mode: _validateEnum(['off','change','ivr']),
  watchlist_filter_mode: _validateEnum(['all','positions','starred']),
  watchlist_starred: v=>_validateTickerArray(v,500),
  put_pos_sort: _validateSafeString(30),
  cc_pos_sort: _validateSafeString(30),
  options_cutoff_et: v=>{const n=finiteNumber(v,{min:0,max:23});return n==null?null:Math.round(n);},
  rp_earnings_toggle: _validateBoolean,
  rp_total_return: _validateBoolean,
  conviction_weights: _validateConvictionWeights,
  earnings_view_mode: _validateEnum(['upcoming','recent']),
  dashboard_view_mode: _validateEnum(['puts','cc','rsi','risk','gap','notes']),
  vol_badge_state: _validateSafeString(30),
  last_ticker: v=>normalizeTicker(v),
  etf_research_tickers: v=>_validateTickerArray(v,500),
  income_accounts_meta: v=>Array.isArray(v)?v.map(_validateAccountMeta).filter(Boolean).slice(0,50):null,
  income_active_account: v=>(typeof v==='string'&&/^acct_[A-Za-z0-9_]{1,40}$/.test(v))?v:null,
  income_migration_v1: _validateBoolean,
  debug_options_fetch: _validateBoolean,
  prefetch_sleep_ms: v=>{const n=finiteNumber(v,{min:100,max:5000});return n==null?null:Math.round(n);},
  fetch_upgrades_enabled: _validateBoolean,
  wheelbt_term_structure_enabled: _validateEnum(['true','false']),
  dashboard_notes: _validateSafeString(5000),
  bb_gap_overlay: _validateEnum(['on','off']),
  gap_list_filter: _validateSafeString(30),
  tax_state: v=>(typeof v==='string'&&/^[A-Z]{2}$/.test(v))?v:null,
  state_tax_rate: v=>finiteNumber(v,{min:0,max:20}),
  fomc_meeting_dates_override: v=>_validateDateArray(v,50),
  fed_futures: _validateFedFutures,
  // Legacy flat income keys (pre-account-migration backups) -- same shape
  // as their per-account equivalents below, since runIncomeMigration just
  // copies these verbatim into the per-account keyed versions.
  income_inputs: _validateIncomeInputs,
  income_mmf_yields: _validateMmfYield,
  put_positions: _validatePutPositionsArray,
  cc_positions: _validateCcPositionsArray,
};

// ── Phase 2: the historical-cache prefix families ────────────────────────────
// earnings_hist_/confirmed_/pending_ have simple, fully-known shapes (a
// small, fixed set of fields per entry, each a controlled-vocabulary
// string, a date, or a small number) and get FULLY validated field-by-
// field, same rigor as Phase 1.
//
// multiple_hist_/fwdpe_track_/nextfy_hist_/nextfy_track_ are different: per
// the app's own comments where these are written (js/ticker.js), this data
// is genuinely irreplaceable -- there's no historical forward-estimate
// endpoint to re-derive it from. That raises the stakes of getting a strict
// per-field validator WRONG (silently corrupting or dropping a real
// historical record because one rarely-seen nested field's exact shape was
// misjudged) higher than the stakes of validating it thoroughly. So these
// get a deliberately different, LENIENT strategy: the fields that are
// dates (used in comparisons elsewhere) or feed directly into arithmetic
// (prices, EPS figures, P/E ratios) are validated and individually nulled
// if invalid -- never rejecting the whole record over one bad number, the
// same instinct as Phase 1's per-item array filtering, just applied at the
// FIELD level here because a single record carries much more that would be
// lost if the whole thing were discarded. The deeply-nested diagnostic
// sub-objects (ttmComponents, yahooAnnual, priceCandidates, firstSeen,
// lastSeen) get only a type check (a real object, not a string/array
// pretending to be one) rather than a field-by-field validator, since
// they're written once and read back only for on-screen debug/diagnostic
// display (see the various JSON.stringify(...) debug views in
// js/ticker.js), not fed into further calculations.

function _finiteOrNull(x,opts){ return x==null?null:finiteNumber(x,{...opts,fallback:null}); }
// Normalizes to a real object or an explicit null -- never passes through
// undefined (checking-and-passing-through the original value would leave
// an absent field as `undefined`, which JSON.stringify silently drops,
// rather than a real, explicit null in the stored record).
function _plainObjectOrNull(v){ return(v!=null&&typeof v==='object'&&!Array.isArray(v))?v:null; }
// Shared by fwdpe_track_ and nextfy_hist_/nextfy_track_ entries -- both are
// {date, <a handful of numeric fields>} records, just with different field
// names.
function _validateNumericEntry(en,numFields){
  if(!en||typeof en!=='object')return null;
  if(typeof en.date!=='string'||!_isValidISODate(en.date))return null;
  const out={date:en.date};
  numFields.forEach(f=>{ out[f]=_finiteOrNull(en[f],{min:-1e7,max:1e7}); });
  return out;
}

function _validateEarningsHistEntry(e){
  if(!e||typeof e!=='object')return null;
  if(typeof e.date!=='string'||!_isValidISODate(e.date))return null;
  const source=['auto-confirmed','gap-estimated','time-estimated','manual-override'].includes(e.source)?e.source:null;
  if(!source)return null; // always set by the app -- absent/garbage means this entry isn't real
  const out={
    date:e.date,
    hour:['bmo','amc'].includes(e.hour)?e.hour:null,
    gapPct:_finiteOrNull(e.gapPct,{min:-100,max:1000}),
    direction:['up','down'].includes(e.direction)?e.direction:null,
    source,
  };
  if(e.override&&typeof e.override==='object'&&typeof e.override.date==='string'&&_isValidISODate(e.override.date)){
    out.override={date:e.override.date,hour:['bmo','amc'].includes(e.override.hour)?e.override.hour:null};
  }
  return out;
}
function _validateEarningsHist(v){
  if(!v||typeof v!=='object'||!Array.isArray(v.data))return null;
  return{
    data:v.data.map(_validateEarningsHistEntry).filter(Boolean).slice(0,500),
    ts:(typeof v.ts==='string')?v.ts.slice(0,60):'',
    tsEpoch:_finiteOrNull(v.tsEpoch,{min:0,max:Date.now()+31536000000}),
  };
}
function _validateEarningsConfirmed(v){
  if(!Array.isArray(v))return null;
  return v.filter(e=>e&&typeof e==='object'&&typeof e.date==='string'&&_isValidISODate(e.date))
    .map(e=>({date:e.date,hour:['bmo','amc'].includes(e.hour)?e.hour:null,addedTs:(typeof e.addedTs==='string')?e.addedTs.slice(0,60):null}))
    .slice(0,20);
}
function _validateEarningsPending(v){
  if(!Array.isArray(v))return null;
  return v.filter(e=>e&&typeof e==='object'&&typeof e.date==='string'&&_isValidISODate(e.date))
    .map(e=>({date:e.date,hour:['bmo','amc'].includes(e.hour)?e.hour:null,savedTs:(typeof e.savedTs==='string')?e.savedTs.slice(0,60):null}))
    .slice(0,10);
}

function _validateMultipleHistEntry(e){
  if(!e||typeof e!=='object')return null;
  if(typeof e.quarterEndDate!=='string'||!_isValidISODate(e.quarterEndDate))return null; // the one required/anchor field
  return{
    quarterEndDate:e.quarterEndDate,
    reportDate:(typeof e.reportDate==='string'&&_isValidISODate(e.reportDate))?e.reportDate:null,
    reportHour:['bmo','amc'].includes(e.reportHour)?e.reportHour:null,
    reportDateSource:(typeof e.reportDateSource==='string')?e.reportDateSource.slice(0,30):null,
    reportDateWasOverride:e.reportDateWasOverride===true,
    priceAtReport:_finiteOrNull(e.priceAtReport,{min:0,max:1e7}),
    priceCandidates:_plainObjectOrNull(e.priceCandidates),
    ttmEpsAsOfReport:_finiteOrNull(e.ttmEpsAsOfReport,{min:-1e6,max:1e6}),
    ttmComponents:_plainObjectOrNull(e.ttmComponents),
    ttmPE:_finiteOrNull(e.ttmPE,{min:-10000,max:10000}),
    epsActual:_finiteOrNull(e.epsActual,{min:-1e6,max:1e6}),
    epsEstimateQuarterly:_finiteOrNull(e.epsEstimateQuarterly,{min:-1e6,max:1e6}),
    yahooAnnual:_plainObjectOrNull(e.yahooAnnual),
    firstSeen:_plainObjectOrNull(e.firstSeen),
    lastSeen:_plainObjectOrNull(e.lastSeen),
  };
}
function _validateMultipleHist(v){
  return Array.isArray(v)?v.map(_validateMultipleHistEntry).filter(Boolean).slice(0,200):null;
}
const _FWDPE_ENTRY_NUM_FIELDS=['price','quarterlyEpsEst','projTtmEps','forwardPE','yahooAnnualFwdEps','yahooForwardPE'];
function _validateFwdpeTrackGroup(g){
  if(!g||typeof g!=='object')return null;
  if(typeof g.targetQuarterEnd!=='string'||!_isValidISODate(g.targetQuarterEnd))return null;
  const entries=Array.isArray(g.entries)?g.entries.map(en=>_validateNumericEntry(en,_FWDPE_ENTRY_NUM_FIELDS)).filter(Boolean).slice(0,50):[];
  return{targetQuarterEnd:g.targetQuarterEnd,entries};
}
function _validateFwdpeTrack(v){
  return Array.isArray(v)?v.map(_validateFwdpeTrackGroup).filter(Boolean).slice(0,10):null;
}

const _NEXTFY_ENTRY_NUM_FIELDS=['price','nextFYEps','multiple'];
function _validateNextfyHistEntry(h){
  if(!h||typeof h!=='object')return null;
  if(typeof h.fyEndDate!=='string'||!_isValidISODate(h.fyEndDate))return null;
  return{
    fyEndDate:h.fyEndDate,
    resolvedDate:(typeof h.resolvedDate==='string'&&_isValidISODate(h.resolvedDate))?h.resolvedDate:null,
    entries:Array.isArray(h.entries)?h.entries.map(en=>_validateNumericEntry(en,_NEXTFY_ENTRY_NUM_FIELDS)).filter(Boolean).slice(0,50):[],
  };
}
function _validateNextfyHist(v){
  return Array.isArray(v)?v.map(_validateNextfyHistEntry).filter(Boolean).slice(0,50):null;
}
function _validateNextfyTrack(v){
  if(!v||typeof v!=='object')return null;
  if(typeof v.targetFYEnd!=='string'||!_isValidISODate(v.targetFYEnd))return null;
  return{
    targetFYEnd:v.targetFYEnd,
    entries:Array.isArray(v.entries)?v.entries.map(en=>_validateNumericEntry(en,_NEXTFY_ENTRY_NUM_FIELDS)).filter(Boolean).slice(0,50):[],
    pendingFYEnd:(typeof v.pendingFYEnd==='string'&&_isValidISODate(v.pendingFYEnd))?v.pendingFYEnd:null,
  };
}

const IMPORT_PREFIX_VALIDATORS=[
  {test:k=>/^income_acct_[A-Za-z0-9_]{1,40}_put_positions$/.test(k), validate:_validatePutPositionsArray},
  {test:k=>/^income_acct_[A-Za-z0-9_]{1,40}_cc_positions$/.test(k), validate:_validateCcPositionsArray},
  {test:k=>/^income_acct_[A-Za-z0-9_]{1,40}_inputs$/.test(k), validate:_validateIncomeInputs},
  // Found while scoping Phase 3: this family was never matched by any
  // Phase 1/2 prefix regex (all three of those end in _put_positions$/
  // _cc_positions$/_inputs$, none of which match _mmf_yield$), so it had
  // been silently falling through to the unvalidated pass-through branch
  // since Phase 1 shipped, despite being genuine per-account data covered
  // by the export side's generic income_acct_ prefix sweep.
  {test:k=>/^income_acct_[A-Za-z0-9_]{1,40}_mmf_yield$/.test(k), validate:_validateMmfYield},
  {test:k=>/^earnings_hist_[A-Za-z0-9^.-]{1,15}$/.test(k), validate:_validateEarningsHist},
  {test:k=>/^earnings_confirmed_[A-Za-z0-9^.-]{1,15}$/.test(k), validate:_validateEarningsConfirmed},
  {test:k=>/^earnings_pending_[A-Za-z0-9^.-]{1,15}$/.test(k), validate:_validateEarningsPending},
  {test:k=>/^multiple_hist_[A-Za-z0-9^.-]{1,15}$/.test(k), validate:_validateMultipleHist},
  {test:k=>/^fwdpe_track_[A-Za-z0-9^.-]{1,15}$/.test(k), validate:_validateFwdpeTrack},
  {test:k=>/^nextfy_hist_[A-Za-z0-9^.-]{1,15}$/.test(k), validate:_validateNextfyHist},
  {test:k=>/^nextfy_track_[A-Za-z0-9^.-]{1,15}$/.test(k), validate:_validateNextfyTrack},
  {test:k=>/^watchlist_note_[A-Za-z0-9^.-]{1,15}$/.test(k), validate:v=>(typeof v==='string')?v.slice(0,500):null},
  {test:k=>/^rp_compare_[A-Za-z0-9^.-]{1,15}$/.test(k), validate:v=>normalizeTicker(v)},
];

// Walks every key in a parsed backup file's `keys` object and validates it
// against the registries above. A key not in either registry at all --
// unrecognized entirely -- and a key whose value fails its own validator --
// recognized, but malformed -- are both dropped, with a reason recorded for
// each so the person restoring a backup can see what happened rather than
// silently losing data. One bad key (or one bad ITEM inside an array key,
// since the array validators above already filter per-item) never blocks
// the rest of an otherwise-good backup from importing.
function _validateImportKeys(keys){
  const accepted={};
  const rejected=[];
  Object.entries(keys||{}).forEach(([k,v])=>{
    if(Object.prototype.hasOwnProperty.call(IMPORT_STATIC_VALIDATORS,k)){
      const result=IMPORT_STATIC_VALIDATORS[k](v);
      if(result!=null)accepted[k]=result;
      else rejected.push({key:k,reason:'malformed value'});
      return;
    }
    const prefixMatch=IMPORT_PREFIX_VALIDATORS.find(p=>p.test(k));
    if(prefixMatch){
      const result=prefixMatch.validate(v);
      if(result!=null)accepted[k]=result;
      else rejected.push({key:k,reason:'malformed value'});
      return;
    }
    // Reaching here means the key is genuinely unrecognized -- every
    // durable key EXPORT_KEYS_STATIC/_buildExportData actually produces
    // is now covered by a validator as of Phase 3. Still passed through
    // unvalidated rather than rejected: rejecting outright would require
    // being CERTAIN this registry is exhaustive, and a person's own
    // export from a future build (a new key this build doesn't know
    // about yet) shouldn't be treated as hostile just because it's newer
    // than this code.
    accepted[k]=v;
  });
  return{accepted,rejected};
}

function previewImport(){
  const raw=document.getElementById('import-textarea').value.trim();
  if(!raw){toast('Paste JSON backup first');return;}
  let parsed;
  try{parsed=JSON.parse(raw);}catch(e){toast('Invalid JSON — could not parse backup');return;}
  if(!parsed.keys||typeof parsed.keys!=='object'){toast('Invalid backup format — missing keys');return;}
  _parsedImportData=parsed;

  const keys=parsed.keys;
  const lines=[];

  // Header
  const exportedAt=parsed._exportedAt?new Date(parsed._exportedAt).toLocaleString('en-US',{timeZone:tzPref==='PT'?'America/Los_Angeles':tzPref==='UTC'?'UTC':Intl.DateTimeFormat().resolvedOptions().timeZone}):'unknown';
  lines.push('<div style="color:var(--accent);font-weight:700;margin-bottom:8px">Backup from: '+exportedAt+'</div>');

  // Watchlist
  try{
    const wl=Array.isArray(keys.watchlist)?keys.watchlist:(JSON.parse(keys.watchlist||'[]'));
    lines.push('<div style="margin-bottom:6px"><span style="color:var(--text3)">WATCHLIST ('+wl.length+' tickers)</span>');
    lines.push('<div style="color:var(--text2);padding-left:10px">'+wl.map(t=>_escHtml(t)).join(', ')+'</div></div>');
  }catch{}

  // Earnings overrides
  const earningsSummary=[];
  Object.entries(keys).forEach(([k,v])=>{
    if(!k.startsWith('earnings_hist_'))return;
    const ticker=k.replace('earnings_hist_','');
    try{
      const hist=(v&&typeof v==='object')?v:JSON.parse(v);
      const overrides=(hist.data||[]).filter(e=>e.override);
      if(overrides.length){
        earningsSummary.push('<div style="color:var(--text2);padding-left:10px">'+
          _escHtml(ticker)+': '+overrides.length+' override'+(overrides.length>1?'s':'')+' — '+
          overrides.map(e=>_escHtml(e.override.date+(e.override.hour?' '+String(e.override.hour).toUpperCase():''))).join(', ')+
        '</div>');
      }
    }catch{}
  });
  if(earningsSummary.length){
    lines.push('<div style="margin-bottom:6px"><span style="color:var(--text3)">EARNINGS DATE OVERRIDES</span>');
    lines.push(earningsSummary.join(''));
    lines.push('</div>');
  }

  // Put positions -- only show flat-key section if no per-account structure present
  // (i.e. pre-migration backup). Post-migration backups show positions per account below.
  const _hasAccountsMeta = !!(keys.income_accounts_meta &&
    (Array.isArray(keys.income_accounts_meta) ? keys.income_accounts_meta.length
      : JSON.parse(String(keys.income_accounts_meta||'[]')).length));
  if(!_hasAccountsMeta){
    try{
      const puts=Array.isArray(keys.put_positions)?keys.put_positions:(JSON.parse(keys.put_positions||'[]'));
      if(puts.length){
        lines.push('<div style="margin-bottom:6px"><span style="color:var(--text3)">PUT POSITIONS ('+puts.length+')</span>');
        puts.forEach(p=>{
          lines.push('<div style="color:var(--text2);padding-left:10px">'+
            _escHtml(p.ticker)+' $'+_escHtml(p.strike)+' put · exp '+_escHtml(p.expDate)+' · '+_escHtml(p.contracts)+' contract'+(p.contracts>1?'s':'')+
          '</div>');
        });
        lines.push('</div>');
      }
    }catch{}

    try{
      const ccs=Array.isArray(keys.cc_positions)?keys.cc_positions:(JSON.parse(keys.cc_positions||'[]'));
      if(ccs.length){
        lines.push('<div style="margin-bottom:6px"><span style="color:var(--text3)">COVERED CALL POSITIONS ('+ccs.length+')</span>');
        ccs.forEach(p=>{
          lines.push('<div style="color:var(--text2);padding-left:10px">'+
            _escHtml(p.ticker)+' $'+_escHtml(p.strike)+' call · exp '+_escHtml(p.expDate)+' · '+_escHtml(p.contracts)+' contract'+(p.contracts>1?'s':'')+
            ' · written @ $'+_escHtml(p.stockPriceAtWrite)+
          '</div>');
        });
        lines.push('</div>');
      }
    }catch{}
  }

  // Income accounts -- read from backup's income_accounts_meta (not current app state)
  try{
    const acctMeta = keys.income_accounts_meta;
    const accounts = Array.isArray(acctMeta) ? acctMeta
      : (acctMeta ? JSON.parse(String(acctMeta)) : null);
    if(accounts && accounts.length){
      lines.push('<div style="margin-bottom:6px"><span style="color:var(--text3)">INCOME ACCOUNTS ('+accounts.length+' account'+(accounts.length!==1?'s':'')+')</span>');
      accounts.forEach((a,i)=>{
        try{
          const putKey = 'income_'+a.id+'_put_positions';
          const ccKey  = 'income_'+a.id+'_cc_positions';
          const puts = Array.isArray(keys[putKey]) ? keys[putKey] : (keys[putKey] ? JSON.parse(String(keys[putKey])) : []);
          const ccs  = Array.isArray(keys[ccKey])  ? keys[ccKey]  : (keys[ccKey]  ? JSON.parse(String(keys[ccKey]))  : []);
          const incKey = 'income_'+a.id+'_inputs';
          const inc = (keys[incKey]&&typeof keys[incKey]==='object') ? keys[incKey] : (keys[incKey] ? JSON.parse(String(keys[incKey])) : {});
          // Account header line
          lines.push('<div style="color:var(--accent);padding-left:10px;margin-top:6px;font-weight:600">'+_escHtml(a.name)+'</div>');
          // Layer 1 summary if configured
          if(inc.tbillAmt||inc.fdlxxAmt||inc.spaxxAmt){
            const l1Parts=[];
            if(inc.tbillAmt)l1Parts.push('T-Bills $'+Number(inc.tbillAmt).toLocaleString());
            if(inc.fdlxxAmt)l1Parts.push('FDLXX $'+Number(inc.fdlxxAmt).toLocaleString());
            if(inc.spaxxAmt)l1Parts.push('SPAXX $'+Number(inc.spaxxAmt).toLocaleString());
            lines.push('<div style="color:var(--text2);padding-left:20px">Layer 1: '+l1Parts.join(', ')+'</div>');
          }
          // Put positions
          if(puts.length){
            lines.push('<div style="color:var(--text2);padding-left:20px">Puts ('+puts.length+'):</div>');
            puts.forEach(p=>{
              lines.push('<div style="color:var(--text2);padding-left:30px">'+
                _escHtml(p.ticker)+' $'+_escHtml(p.strike)+' · exp '+_escHtml(p.expDate)+' · '+_escHtml(p.contracts)+' contract'+(p.contracts>1?'s':'')+
              '</div>');
            });
          }else{
            lines.push('<div style="color:var(--text3);padding-left:20px">No put positions</div>');
          }
          // CC positions
          if(ccs.length){
            lines.push('<div style="color:var(--text2);padding-left:20px">CCs ('+ccs.length+'):</div>');
            ccs.forEach(p=>{
              lines.push('<div style="color:var(--text2);padding-left:30px">'+
                _escHtml(p.ticker)+' $'+_escHtml(p.strike)+' call · exp '+_escHtml(p.expDate)+' · '+_escHtml(p.contracts)+' contract'+(p.contracts>1?'s':'')+
                (p.stockPriceAtWrite?' · written @ $'+_escHtml(p.stockPriceAtWrite):'')+
              '</div>');
            });
          }else{
            lines.push('<div style="color:var(--text3);padding-left:20px">No CC positions</div>');
          }
        }catch(e){ lines.push('<div style="color:var(--text2);padding-left:10px">'+_escHtml(a.name)+': (data unreadable)</div>'); }
      });
      lines.push('</div>');
    }else if(keys.income_inputs||keys.put_positions||keys.cc_positions){
      // Pre-migration backup: show legacy flat-key summary with individual positions
      lines.push('<div style="margin-bottom:6px"><span style="color:var(--text3)">INCOME ENGINE (legacy format -- will migrate to Taxable account)</span>');
      try{
        const inc=(keys.income_inputs&&typeof keys.income_inputs==='object')?keys.income_inputs:(JSON.parse(keys.income_inputs||'{}'));
        const puts=Array.isArray(keys.put_positions)?keys.put_positions:(keys.put_positions?JSON.parse(String(keys.put_positions)):[]);
        const ccs=Array.isArray(keys.cc_positions)?keys.cc_positions:(keys.cc_positions?JSON.parse(String(keys.cc_positions)):[]);
        if(inc.tbillAmt)lines.push('<div style="color:var(--text2);padding-left:10px">T-Bills: $'+Number(inc.tbillAmt).toLocaleString()+'</div>');
        if(inc.fdlxxAmt)lines.push('<div style="color:var(--text2);padding-left:10px">FDLXX: $'+Number(inc.fdlxxAmt).toLocaleString()+'</div>');
        puts.forEach(p=>lines.push('<div style="color:var(--text2);padding-left:10px">'+_escHtml(p.ticker)+' $'+_escHtml(p.strike)+' put · exp '+_escHtml(p.expDate)+' · '+_escHtml(p.contracts)+' contract'+(p.contracts>1?'s':'')+'</div>'));
        ccs.forEach(p=>lines.push('<div style="color:var(--text2);padding-left:10px">'+_escHtml(p.ticker)+' $'+_escHtml(p.strike)+' call · exp '+_escHtml(p.expDate)+' · '+_escHtml(p.contracts)+' contract'+(p.contracts>1?'s':'')+(p.stockPriceAtWrite?' · written @ $'+_escHtml(p.stockPriceAtWrite):'')+'</div>'));
      }catch{}
      lines.push('</div>');
    }
  }catch{}

  // Settings
  lines.push('<div style="margin-bottom:6px"><span style="color:var(--text3)">SETTINGS</span>');
  if(keys.tz_pref)lines.push('<div style="color:var(--text2);padding-left:10px">Timezone: '+_escHtml(keys.tz_pref)+'</div>');
  if(keys.font_size)lines.push('<div style="color:var(--text2);padding-left:10px">Font size: '+_escHtml(keys.font_size)+'px</div>');
  if(keys.options_cutoff_et){
    const cutoffHourET=typeof keys.options_cutoff_et==='number'?keys.options_cutoff_et:parseInt(String(keys.options_cutoff_et));
    // Display in user's timezone (same as Settings dropdown), not raw ET
    try{
      const _tz=typeof tzPref!=='undefined'?(tzPref==='PT'?'America/Los_Angeles':tzPref==='UTC'?'UTC':Intl.DateTimeFormat().resolvedOptions().timeZone):'America/Los_Angeles';
      const _tzLabel=typeof tzPref!=='undefined'?(tzPref==='UTC'?'UTC':tzPref==='local'?'local':'PT'):'PT';
      const now=new Date();
      const etStr=now.toLocaleDateString('en-US',{timeZone:'America/New_York'});
      const [m,d,y]=etStr.split('/');
      const pad=n=>String(n).padStart(2,'0');
      const etDate=new Date(y+'-'+pad(m)+'-'+pad(d)+'T'+pad(cutoffHourET)+':00:00');
      const displayLabel=etDate.toLocaleTimeString('en-US',{timeZone:_tz,hour:'numeric',minute:'2-digit',hour12:true});
      lines.push('<div style="color:var(--text2);padding-left:10px">Options cache cutoff: '+displayLabel+' '+_tzLabel+'</div>');
    }catch{
      lines.push('<div style="color:var(--text2);padding-left:10px">Options cache cutoff: ET hour '+cutoffHourET+'</div>');
    }
  }
  if(keys.conviction_weights){
    try{
      const cw=(keys.conviction_weights&&typeof keys.conviction_weights==='object')?keys.conviction_weights:JSON.parse(keys.conviction_weights);
      const cwStr=Object.entries(cw).map(([k,v])=>_escHtml(k)+':'+_escHtml(v)).join(', ');
      lines.push('<div style="color:var(--text2);padding-left:10px">Conviction weights: '+cwStr+'</div>');
    }catch{}
  }
  lines.push('</div>');

  // Confirmed earnings cache summary
  try{
    const _confKeys=Object.keys(keys).filter(k=>k.startsWith('earnings_confirmed_'));
    if(_confKeys.length){
      lines.push('<div style="margin-bottom:6px"><span style="color:var(--text3)">CONFIRMED EARNINGS CACHE ('+_confKeys.length+' ticker'+(_confKeys.length>1?'s':'')+')</span>');
      _confKeys.forEach(k=>{
        const t=k.replace('earnings_confirmed_','');
        const entries=Array.isArray(keys[k])?keys[k]:(JSON.parse(keys[k]||'[]'));
        if(entries.length)lines.push('<div style="color:var(--text2);padding-left:10px">'+_escHtml(t)+': '+entries.length+' confirmed date'+(entries.length>1?'s':'')+' ('+entries.map(e=>_escHtml(e.date+(e.hour?' '+String(e.hour).toUpperCase():''))).join(', ')+')</div>');
      });
      lines.push('</div>');
    }
  }catch{}

  // Dashboard notes -- substantial user-authored content, same treatment
  // as Watchlist Notes below, unlike the minor settings/toggles that are
  // intentionally left out of this preview and covered only by the total
  // key count footer.
  try{
    if(typeof keys.dashboard_notes==='string'&&keys.dashboard_notes.trim()){
      const note=keys.dashboard_notes;
      lines.push('<div style="margin-bottom:6px"><span style="color:var(--text3)">NOTES ('+note.length+' char'+(note.length!==1?'s':'')+')</span>');
      lines.push('<div style="color:var(--text2);padding-left:10px">'+_escHtml(note.slice(0,100))+(note.length>100?'…':'')+'</div></div>');
    }
  }catch{}

  // Watchlist notes
  try{
    const noteKeys=Object.keys(keys).filter(k=>k.startsWith('watchlist_note_'));
    if(noteKeys.length){
      const tickers=noteKeys.map(k=>k.replace('watchlist_note_',''));
      lines.push('<div style="margin-bottom:6px"><span style="color:var(--text3)">WATCHLIST NOTES ('+tickers.length+' ticker'+(tickers.length!==1?'s':'')+')</span>');
      tickers.forEach(t=>{
        const note=typeof keys['watchlist_note_'+t]==='string'?keys['watchlist_note_'+t]:'';
        lines.push('<div style="color:var(--text2);padding-left:10px">'+_escHtml(t)+': '+_escHtml(note.slice(0,60))+(note.length>60?'…':'')+'</div>');
      });
      lines.push('</div>');
    }
  }catch{}

  // Sandbox ETFs
  try{
    const sbT=Array.isArray(keys.etf_research_tickers)?keys.etf_research_tickers:(JSON.parse(keys.etf_research_tickers||'[]'));
    if(sbT.length){
      lines.push('<div style="margin-bottom:6px"><span style="color:var(--text3)">ETF RESEARCH SANDBOX ('+sbT.length+' ticker'+(sbT.length>1?'s':'')+')</span>');
      lines.push('<div style="color:var(--text2);padding-left:10px">'+sbT.map(t=>_escHtml(t)).join(', ')+'</div></div>');
    }
  }catch{}

  // Total key count, plus what validation actually found -- shown BEFORE
  // the user taps Restore, not just reported afterward, so a skipped key
  // isn't a surprise.
  const{rejected}=_validateImportKeys(keys);
  lines.push('<div style="color:var(--text3);margin-top:4px;border-top:1px solid var(--border);padding-top:6px">'+Object.keys(keys).length+' keys total in backup.</div>');
  if(rejected.length){
    const shown=rejected.slice(0,10);
    lines.push('<div style="color:var(--warn);margin-top:2px">'+rejected.length+' key'+(rejected.length!==1?'s':'')+' will be skipped (unrecognized or malformed):</div>');
    lines.push('<div style="color:var(--text3);padding-left:10px;font-size:10px">'+
      shown.map(r=>_escHtml(r.key)+' ('+_escHtml(r.reason)+')').join('<br>')+
      (rejected.length>shown.length?'<br>… and '+(rejected.length-shown.length)+' more':'')+
    '</div>');
  }

  const preview=document.getElementById('import-preview');
  preview.innerHTML=lines.join('');
  preview.style.display='block';
  document.getElementById('restore-btn').disabled=false;
  toast('Preview ready — verify data below then tap Restore',3000);
}

function confirmImport(){
  if(!_parsedImportData?.keys){toast('No valid backup to restore');return;}
  const keys=_parsedImportData.keys;
  const{accepted,rejected}=_validateImportKeys(keys);
  let count=0;
  Object.entries(accepted).forEach(([k,v])=>{
    try{S.set(k,v);count++;}catch(e){console.warn('Import failed for key',k,e);}
  });
  // If this is a pre-migration backup (has old flat keys, no income_accounts_meta),
  // clear the migration flag so runIncomeMigration() re-runs on next income tab load
  const isPreMigration = !accepted.income_accounts_meta &&
    (accepted.income_inputs || accepted.put_positions || accepted.cc_positions);
  if(isPreMigration){
    S.del('income_migration_v1');
    console.log('Pre-migration backup detected -- income migration will re-run on next income tab load');
  }
  _parsedImportData=null;
  document.getElementById('restore-btn').disabled=true;
  document.getElementById('import-preview').style.display='none';
  document.getElementById('import-textarea').value='';
  closeDataPortabilityModal();
  toast('Restored '+count+' keys'+(rejected.length?' ('+rejected.length+' skipped -- see preview before restoring next time)':'')+'. Reload the app to apply.',rejected.length?6000:4000);
}

// ── Refresh Health Badge & Modal ──────────────────────────────────────────

function _updateRefreshHealthBadge(){
  const h=S.get('last_refresh_health');
  const badge=document.getElementById('refresh-health-badge');
  if(!badge)return;
  if(!h){badge.style.display='none';return;}
  const total=h.summary?.total||0;
  const ok=h.summary?.ok||0;
  const degraded=h.summary?.degraded?.length||0;
  const allOk=ok===total;
  badge.style.display='flex';
  badge.style.background=allOk?'rgba(0,212,170,0.15)':'rgba(255,165,2,0.2)';
  badge.style.borderColor=allOk?'rgba(0,212,170,0.4)':'rgba(255,165,2,0.5)';
  // Degraded tickers (snap/hist/finnhub all succeeded, but quoteSummary --
  // sector/beta/PEG/price targets/etc. -- came back from a previous fetch,
  // not this one) get a de-emphasized note rather than changing the
  // badge's overall pass/fail color, since a stale PEG value is a much
  // smaller concern than a genuinely failed ticker.
  const degradedNote=degraded>0?' <span style="color:var(--text3)">&middot; '+degraded+' stale valuation</span>':'';
  badge.innerHTML=(allOk?'&#x2714;':'&#x26A0;')+' '+ok+'/'+total+' tickers'+degradedNote+((!allOk||degraded>0)?' <span style="font-size:9px">tap for details</span>':'');
}

function openRefreshHealthModal(){
  const h=S.get('last_refresh_health');
  if(!h){toast('No refresh data yet — run a prefetch first');return;}
  let el=document.getElementById('refresh-health-modal');
  if(!el){
    el=document.createElement('div');el.className='modal-overlay';el.id='refresh-health-modal';
    document.body.appendChild(el);
    el.addEventListener('click',e=>{if(e.target===el)el.classList.remove('open');});
  }
  const total=h.summary?.total||0;const ok=h.summary?.ok||0;
  const failed=h.summary?.failed||[];
  const degraded=h.summary?.degraded||[];
  const allOk=ok===total;
  const elapsed=h.elapsedLabel||null;

  // Timing instrumentation -- temporary, added to answer a specific
  // question (is news on Finnhub's slow tier like earnings/upgrades, or
  // its fast tier?) before deciding whether to throttle it too. Shown
  // only when present, so this doesn't clutter the modal once removed.
  const ts=h.timingSummary;
  const _fmtTiming=(label,stat)=>stat?'<div style="display:flex;justify-content:space-between"><span style="color:var(--text2)">'+label+'</span><span style="color:var(--text3)">avg '+stat.avg+'ms &middot; '+stat.min+'-'+stat.max+'ms &middot; n='+stat.n+'</span></div>':'';
  const timingHtml=ts&&(ts.earnings||ts.upgrades||ts.news||ts.yahooBatch||ts.expiryChains)
    ?'<div style="font-family:var(--mono);font-size:10px;background:var(--surface2);border-radius:6px;padding:8px;margin-bottom:10px">'
     +'<div style="color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;font-size:9px;margin-bottom:4px">Endpoint timing (this run)</div>'
     +_fmtTiming('Finnhub earnings',ts.earnings)
     +_fmtTiming('Finnhub upgrades',ts.upgrades)
     +_fmtTiming('Finnhub news',ts.news)
     +_fmtTiming('Yahoo batch (whole)',ts.yahooBatch)
     +_fmtTiming('Yahoo expiry chains',ts.expiryChains)
     +'</div>'
    :'';

  const tickerRows=Object.entries(h.tickers||{}).map(([t,v])=>{
    // Must match prefetch.js's _coreOk EXACTLY -- these two are meant to
    // represent the same concept (the summary's N/total count and each
    // row's own badge), and previously didn't: this row-level check used
    // to omit options entirely, so a ticker whose options data failed
    // (metadata unavailable, or some expiration fetches came back with
    // nothing usable to fall back on) could show a green "OK" row here
    // while still being correctly counted as the failure behind a "46/47"
    // summary above it -- invisible in the one place meant to show which
    // ticker that was, with its own explanatory detail line suppressed
    // too (that line only renders when the row ISN'T "OK").
    const coreOk=v.snap&&v.hist&&v.finnhub&&v.options===true;
    const isDegraded=coreOk&&v.summaryDegraded;
    // Three states, not two: fully OK, degraded (core data fine, but
    // sector/beta/PEG/price targets/etc. are carried over from an earlier
    // fetch rather than confirmed fresh this run), or failed (core data
    // itself didn't come through). Distinct color/icon per state so a
    // stale-valuation ticker doesn't read as seriously as a genuine failure.
    const status=coreOk?(isDegraded?'&#x25D1;':'&#x2714;'):'&#x26A0;';
    const color=coreOk?(isDegraded?'#64b5f6':'var(--green)'):'var(--warn)';
    const detail=[
      v.snap?'':'snap failed',
      v.hist?'':'hist failed',
      v.options===true?'':v.options==='skipped'?'options skipped (fresh)':v.optionsExpDetail?`options ${v.optionsExpDetail.fresh+v.optionsExpDetail.preserved}/${v.optionsExpDetail.total} exp chains`:'options failed',
      v.finnhub?'':(v.finnhubDetail?v.finnhubDetail:'finnhub failed'),
      isDegraded?'valuation data (sector/beta/PEG/price targets) is from an earlier fetch, not this one':'',
    ].filter(Boolean).join(', ');
    return `<div onclick="_goToTickerFromHealthModal('${t}')" style="font-family:var(--mono);font-size:10px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer">
      <div style="display:flex;justify-content:space-between">
        <span style="color:var(--text2)">${t} <span style="color:var(--text3);font-size:9px">&#x203A;</span></span>
        <span style="color:${color}">${status}${coreOk?(isDegraded?' Stale valuation':' OK'):''}</span>
      </div>
      ${coreOk&&!isDegraded?'':`<div style="color:${color};margin-top:2px;word-break:break-word">${detail}</div>`}
    </div>`;
  }).join('');

  el.innerHTML=`<div class="modal-box" style="max-width:380px;max-height:80vh;overflow-y:auto">
    <div class="modal-title">Last Refresh Health</div>
    <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:10px">
      Completed: ${h.completedTs||h.ts||'unknown'}${elapsed?' &nbsp;·&nbsp; <span style="color:var(--text2)">'+elapsed+'</span>':''}<br>
      Result: <span style="color:${allOk?'var(--green)':'var(--warn)'}">${ok}/${total} tickers fully refreshed</span>${degraded.length?'<br>Valuation data (sector/beta/PEG/price targets) stale on <span style="color:#64b5f6">'+degraded.length+' ticker'+(degraded.length===1?'':'s')+'</span> -- quoteSummary failed as a whole for those, so nothing on this run was mixed fresh/stale within a single ticker.':''}
    </div>
    ${timingHtml}
    ${allOk?'':`<button class="btn btn-secondary" id="retry-failed-btn" style="width:100%;margin-bottom:10px" onclick="retryFailedTickers()">&#x21BB; Retry ${failed.length} Failed</button>`}
    <div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-bottom:4px">Tap any row to jump to that ticker</div>
    <div style="margin-bottom:12px">${tickerRows}</div>
    <button class="btn btn-secondary" style="width:100%" onclick="document.getElementById('refresh-health-modal').classList.remove('open')">Close</button>
  </div>`;
  el.classList.add('open');
}

function _goToTickerFromHealthModal(t){
  document.getElementById('refresh-health-modal').classList.remove('open');
  navigateToTicker(t);
}

async function retryFailedTickers(){
  const h=S.get('last_refresh_health');
  const failed=h?.summary?.failed||[];
  if(!failed.length){toast('Nothing to retry');return;}
  if(!navigator.onLine&&!offlineMode){toast('Offline -- cannot retry',3000);return;}
  if(offlineMode){toast('Offline mode -- disable in Settings to retry',3000);return;}
  if(!FINNHUB_KEY&&!WORKER_URL){toast('Add a Finnhub key or set your Server Address in Settings');return;}

  const btn=document.getElementById('retry-failed-btn');
  if(btn){btn.disabled=true;btn.textContent='Retrying...';}

  // refreshSingleTicker() sets currentTicker and re-renders the Ticker tab as
  // a side effect of doing its job -- save/restore around the batch so a
  // retry run from here doesn't silently leave the Ticker tab pointed at
  // whichever ticker happened to be retried last.
  const _savedTicker=currentTicker;
  const _savedSelectVal=document.getElementById('ticker-select')?.value;

  const sel=document.getElementById('ticker-select');
  const sleepMs=parseInt(S.get('prefetch_sleep_ms'))||100;
  for(let i=0;i<failed.length;i++){
    sel.value=failed[i];
    try{await refreshSingleTicker();}catch{}
    if(document.getElementById('refresh-health-modal')?.classList.contains('open'))openRefreshHealthModal();
    if(i<failed.length-1)await sleep(sleepMs);
  }

  if(_savedTicker&&sel){sel.value=_savedSelectVal||_savedTicker;currentTicker=_savedTicker;await loadTicker();}

  const _btn2=document.getElementById('retry-failed-btn');
  if(_btn2){_btn2.disabled=false;_btn2.textContent='\u21BB Retry Failed';}
  toast('Retry complete');
}

// Reports the latest deployed build available on GitHub, by fetching
// sw.js directly (cache-busted, so this isn't fooled by a stale cached
// copy of the very file it's inspecting).
//
// Deliberately does NOT claim to know which build is currently running,
// even though that seems like the obvious next step -- it isn't reliably
// knowable client-side. The original version compared this against
// caches.keys(), but Cache Storage answers "what caches exist," not
// "what's actively controlling this page right now": a service worker
// can silently install a newer cache in the background, well before that
// new version actually takes over -- so a page still genuinely running
// build 433 could see a 434 cache already sitting there and misreport
// itself as current. That's a real, observed bug, not a hypothetical --
// caught directly from a screenshot showing "latest version -- build 434"
// while the header (a separate, simpler label) still correctly showed
// 433. The only fully reliable fix is asking the actual controlling
// service worker directly via postMessage, which sw.js doesn't support
// yet -- deliberately not building that now. This simpler version reports
// only what's genuinely knowable (what's latest available) and stays
// silent on what's currently running, rather than risk repeating the
// same false claim in a different form.
async function _checkForAppUpdate(){
  const statusEl=document.getElementById('app-update-status');
  if(!statusEl)return;
  statusEl.textContent='Checking for updates...';
  try{
    const resp=await fetch('./sw.js?_t='+Date.now(),{cache:'no-store'});
    const text=await resp.text();
    const m=text.match(/const APP_BUILD\s*=\s*(\d+)/);
    const remoteBuild=m?parseInt(m[1]):null;
    if(remoteBuild==null){
      statusEl.textContent='Could not check for updates right now';
      return;
    }
    statusEl.textContent='Latest available: build '+remoteBuild+'. If this differs from the header above, tap Force App Refresh below.';
  }catch(e){
    statusEl.textContent='Could not check for updates -- '+(e?.message||'network error');
  }
}

function forceAppRefresh(){
  // reload() without true so the SW intercepts the reload and serves
  // files from its fresh cache. reload(true) bypasses the SW on iOS Safari.
  // Preserves the vendor cache (Chart.js, fonts) deliberately -- that's
  // the entire point of splitting it out (see sw.js): a routine refresh
  // shouldn't re-download files that never changed. Matched by prefix
  // rather than an exact name, since this file can't see sw.js's own
  // VENDOR_CACHE_NAME constant directly (different execution context) --
  // same naming-convention approach already used elsewhere (e.g. the
  // header's build-label parsing).
  if('caches'in window){caches.keys().then(keys=>{Promise.all(keys.filter(k=>!k.startsWith('income-engine-vendor-')).map(k=>caches.delete(k))).then(()=>{toast('Cache cleared -- reloading...',2500);setTimeout(()=>window.location.reload(),2500);});});}
  else{window.location.reload();}
}
