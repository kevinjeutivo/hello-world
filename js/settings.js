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
  ivr:'Implied Volatility Rank -- measures how elevated current IV is vs the past year. High IVR means options are unusually expensive, so you collect more premium for the same risk. The most important factor for income generation.',
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
  const ageHrs=ts=>{
    if(!ts)return null;
    try{
      // Handle both string timestamps and {ts:string} objects
      const tsStr=typeof ts==='object'&&ts.ts?ts.ts:(typeof ts==='string'?ts:null);
      if(!tsStr)return null;
      const d=new Date(tsStr.replace(/ PT$| UTC$| local$/,'').trim());
      return isNaN(d.getTime())?null:(now-d.getTime())/3600000;
    }catch{return null;}
  };
  const ageStr=hrs=>{
    if(hrs===null)return'missing';
    if(hrs<1)return Math.round(hrs*60)+'m old';
    return hrs.toFixed(1)+'h old';
  };
  const ok=v=>v!==null&&v<24;

  // 1. Watchlist snaps
  const wl=S.get('watchlist')||[];
  let snapMissing=0,snapStale=0;
  wl.forEach(t=>{
    const sn=S.get('snap_'+t);
    if(!sn){snapMissing++;return;}
    const hrs=ageHrs(sn.ts);
    if(!ok(hrs))snapStale++;
  });
  const snapStatus=snapMissing>0?'red':snapStale>0?'amber':'green';
  checks.push({label:'Ticker data ('+wl.length+' tickers)',
    status:snapStatus,
    detail:snapMissing>0?snapMissing+' tickers missing':snapStale>0?snapStale+' tickers stale':'All fresh'});

  // 2. Price history
  let histMissing=0;
  wl.forEach(t=>{if(!S.get('hist_'+t))histMissing++;});
  checks.push({label:'Price history (6M)',status:histMissing>0?'red':'green',
    detail:histMissing>0?histMissing+' missing':'All cached'});

  // 3. Options chains
  let optsMissing=0,optsZeroOI=0;
  wl.forEach(t=>{
    const o=S.get('options_'+t);
    if(!o){optsMissing++;return;}
    const puts=o.data?.optionChain?.result?.[0]?.options?.[0]?.puts||[];
    const totalOI=puts.reduce((s,p)=>s+(p.openInterest||0),0);
    if(totalOI===0)optsZeroOI++;
  });
  const optsStatus=optsMissing>0?'red':optsZeroOI>0?'amber':'green';
  checks.push({label:'Options chains',status:optsStatus,
    detail:optsMissing>0?optsMissing+' missing':optsZeroOI>0?optsZeroOI+' have zero OI (fetch during market hours)':'All cached with OI'});

  // 4. VIX history
  const vixH=S.get('vix_hist');
  const vixAge=vixH?.ts?ageHrs(vixH.ts):null;
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
  const mktAge=ageHrs(mktTsRaw?.ts||mktTsRaw);
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

async function measureStorage(){
  const el=document.getElementById('storage-display');
  if(!el)return;
  el.textContent='Measuring...';
  // Get quota via Storage API
  let usedMB='?',quotaMB='?',pct=0;
  try{
    const est=await navigator.storage.estimate();
    usedMB=(est.usage/1048576).toFixed(1);
    quotaMB=(est.quota/1048576).toFixed(0);
    pct=Math.round(est.usage/est.quota*100);
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
  el.innerHTML='<div style="margin-bottom:4px">Storage API: <b>'+usedMB+'MB</b> / '+quotaMB+'MB ('+pct+'%)</div>'
    +'<div style="background:var(--bg2);border-radius:4px;height:6px;margin-bottom:6px"><div style="background:var(--accent);height:6px;border-radius:4px;width:'+Math.min(pct,100)+'%"></div></div>'
    +'<div style="color:var(--text3);margin-bottom:4px">localStorage: '+totalKeys+' keys total</div>'
    +'<div>Options chains: '+fmt(cats.options)+' ('+keyCounts.options+' keys)</div>'
    +'<div>Price history: '+fmt(cats.history)+' ('+keyCounts.history+' keys)</div>'
    +'<div>Ticker snaps: '+fmt(cats.snap)+' ('+keyCounts.snap+' keys)</div>'
    +'<div>News: '+fmt(cats.news)+' ('+keyCounts.news+' keys)</div>'
    +'<div>Other: '+fmt(cats.other)+' ('+keyCounts.other+' keys)</div>'
    +'<div style="margin-top:4px;color:var(--text2)">Total localStorage: '+fmt(totalLS)+'</div>';
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

function openSettings(){
  document.getElementById('finnhub-key-input').value=FINNHUB_KEY;
  document.getElementById('default-watchlist-input').value=watchlist.join(',');
  document.getElementById('vix-threshold-input').value=vixThreshold;
  document.getElementById('prefetch-sleep-input').value=parseInt(S.get('prefetch_sleep_ms'))||500;
  document.getElementById('tz-pref-input').value=tzPref;
  document.getElementById('offline-mode-input').checked=offlineMode;
  document.getElementById('debug-options-fetch-input').checked=S.get('debug_options_fetch')==='true';
  document.getElementById('font-size-input').value=fontSize;
  loadWeightSliders();
  _populateCutoffSelect();
  document.getElementById('settings-overlay').classList.add('open');
}

function closeSettings(){document.getElementById('settings-overlay').classList.remove('open');}

function closeSettingsIfOutside(e){if(e.target===document.getElementById('settings-overlay'))closeSettings();}

function saveSettings(){
  const key=document.getElementById('finnhub-key-input').value.trim();
  if(key){FINNHUB_KEY=key;S.set('finnhub_key',key);}
  const wl=document.getElementById('default-watchlist-input').value.split(',').map(t=>t.trim().toUpperCase()).filter(t=>t.length>0);
  if(wl.length>0){watchlist=wl;S.set('watchlist',wl);}
  vixThreshold=parseInt(document.getElementById('vix-threshold-input').value)||20;
  S.set('vix_threshold',String(vixThreshold));
  const _prefetchSleepMs=Math.min(5000,Math.max(100,parseInt(document.getElementById('prefetch-sleep-input').value)||500));
  S.set('prefetch_sleep_ms',String(_prefetchSleepMs));
  tzPref=document.getElementById('tz-pref-input').value;
  S.set('tz_pref',tzPref);
  const cutoffET=parseInt(document.getElementById('options-cutoff-input')?.value)||18;
  S.set('options_cutoff_et',String(cutoffET));
  offlineMode=document.getElementById('offline-mode-input').checked;
  S.set('offline_mode',String(offlineMode));
  S.set('debug_options_fetch',String(document.getElementById('debug-options-fetch-input').checked));
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
  localStorage.clear();FINNHUB_KEY='';watchlist=[...DEFAULT_WATCHLIST];currentTicker='';offlineMode=false;
  toast('All data cleared');renderWatchlist();updateVIXIndicator(null);updateOfflineModeBar();
}

function clearMarketDataCache(){
  // Keys to preserve -- manually entered data and settings
  const PRESERVE=new Set([
    'watchlist','tz_pref','font_size','vix_threshold','offline_mode',
    'watchlist_sort','heatmap_mode','put_pos_sort','cc_pos_sort',
    'options_cutoff_et','rp_earnings_toggle','rp_span','bb_span',
    'vol_badge_state','conviction_weights','last_ticker',
    'income_accounts_meta','income_active_account','income_migration_v1',
    'debug_options_fetch','prefetch_sleep_ms',
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
    if(k.startsWith('snap_')||k.startsWith('hist_')||k.startsWith('hist1y_')||
       k.startsWith('hist2y_')||k.startsWith('options_')||k.startsWith('news_')||
       k.startsWith('rec_')||k.startsWith('upgrades_')||
       k.startsWith('mkt_')||k.startsWith('tbills_')||k.startsWith('vix')||
       k.startsWith('div_')||k==='market_news'||k==='fed_futures'||
       k==='hist2y_sp500'){
      toDelete.push(k);
    }
  }
  toDelete.forEach(k=>localStorage.removeItem(k));
  toast('Market data cache cleared ('+toDelete.length+' keys). Run a full refresh to repopulate.',4000);
}

// ── Data Portability: Export / Import ────────────────────────────────────────

const EXPORT_KEYS_STATIC=[
  'watchlist','tz_pref','font_size','vix_threshold',
  'offline_mode','watchlist_sort','heatmap_mode','put_pos_sort','cc_pos_sort',
  'options_cutoff_et','rp_earnings_toggle','conviction_weights',
  'vol_badge_state','last_ticker',
  'etf_research_tickers',
  'income_accounts_meta','income_active_account','income_migration_v1',
  'debug_options_fetch','prefetch_sleep_ms',
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
    lines.push('<div style="color:var(--text2);padding-left:10px">'+wl.join(', ')+'</div></div>');
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
          ticker+': '+overrides.length+' override'+(overrides.length>1?'s':'')+' — '+
          overrides.map(e=>e.override.date+(e.override.hour?' '+e.override.hour.toUpperCase():'')).join(', ')+
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
            p.ticker+' $'+p.strike+' put · exp '+p.expDate+' · '+p.contracts+' contract'+(p.contracts>1?'s':'')+
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
            p.ticker+' $'+p.strike+' call · exp '+p.expDate+' · '+p.contracts+' contract'+(p.contracts>1?'s':'')+
            ' · written @ $'+p.stockPriceAtWrite+
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
          lines.push('<div style="color:var(--accent);padding-left:10px;margin-top:6px;font-weight:600">'+a.name+'</div>');
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
                p.ticker+' $'+p.strike+' · exp '+p.expDate+' · '+p.contracts+' contract'+(p.contracts>1?'s':'')+
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
                p.ticker+' $'+p.strike+' call · exp '+p.expDate+' · '+p.contracts+' contract'+(p.contracts>1?'s':'')+
                (p.stockPriceAtWrite?' · written @ $'+p.stockPriceAtWrite:'')+
              '</div>');
            });
          }else{
            lines.push('<div style="color:var(--text3);padding-left:20px">No CC positions</div>');
          }
        }catch(e){ lines.push('<div style="color:var(--text2);padding-left:10px">'+a.name+': (data unreadable)</div>'); }
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
        puts.forEach(p=>lines.push('<div style="color:var(--text2);padding-left:10px">'+p.ticker+' $'+p.strike+' put · exp '+p.expDate+' · '+p.contracts+' contract'+(p.contracts>1?'s':'')+'</div>'));
        ccs.forEach(p=>lines.push('<div style="color:var(--text2);padding-left:10px">'+p.ticker+' $'+p.strike+' call · exp '+p.expDate+' · '+p.contracts+' contract'+(p.contracts>1?'s':'')+(p.stockPriceAtWrite?' · written @ $'+p.stockPriceAtWrite:'')+'</div>'));
      }catch{}
      lines.push('</div>');
    }
  }catch{}

  // Settings
  lines.push('<div style="margin-bottom:6px"><span style="color:var(--text3)">SETTINGS</span>');
  if(keys.tz_pref)lines.push('<div style="color:var(--text2);padding-left:10px">Timezone: '+keys.tz_pref+'</div>');
  if(keys.font_size)lines.push('<div style="color:var(--text2);padding-left:10px">Font size: '+keys.font_size+'px</div>');
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
      const cwStr=Object.entries(cw).map(([k,v])=>k+':'+v).join(', ');
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
        if(entries.length)lines.push('<div style="color:var(--text2);padding-left:10px">'+t+': '+entries.length+' confirmed date'+(entries.length>1?'s':'')+' ('+entries.map(e=>e.date+(e.hour?' '+e.hour.toUpperCase():'')).join(', ')+')</div>');
      });
      lines.push('</div>');
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
        lines.push('<div style="color:var(--text2);padding-left:10px">'+t+': '+note.slice(0,60)+(note.length>60?'…':'')+'</div>');
      });
      lines.push('</div>');
    }
  }catch{}

  // Sandbox ETFs
  try{
    const sbT=Array.isArray(keys.etf_research_tickers)?keys.etf_research_tickers:(JSON.parse(keys.etf_research_tickers||'[]'));
    if(sbT.length){
      lines.push('<div style="margin-bottom:6px"><span style="color:var(--text3)">ETF RESEARCH SANDBOX ('+sbT.length+' ticker'+(sbT.length>1?'s':'')+')</span>');
      lines.push('<div style="color:var(--text2);padding-left:10px">'+sbT.join(', ')+'</div></div>');
    }
  }catch{}

  // Total key count
  lines.push('<div style="color:var(--text3);margin-top:4px;border-top:1px solid var(--border);padding-top:6px">'+Object.keys(keys).length+' keys total in backup.</div>');

  const preview=document.getElementById('import-preview');
  preview.innerHTML=lines.join('');
  preview.style.display='block';
  document.getElementById('restore-btn').disabled=false;
  toast('Preview ready — verify data below then tap Restore',3000);
}

function confirmImport(){
  if(!_parsedImportData?.keys){toast('No valid backup to restore');return;}
  const keys=_parsedImportData.keys;
  let count=0;
  Object.entries(keys).forEach(([k,v])=>{
    try{S.set(k,v);count++;}catch(e){console.warn('Import failed for key',k,e);}
  });
  // If this is a pre-migration backup (has old flat keys, no income_accounts_meta),
  // clear the migration flag so runIncomeMigration() re-runs on next income tab load
  const isPreMigration = !keys.income_accounts_meta &&
    (keys.income_inputs || keys.put_positions || keys.cc_positions);
  if(isPreMigration){
    S.del('income_migration_v1');
    console.log('Pre-migration backup detected -- income migration will re-run on next income tab load');
  }
  _parsedImportData=null;
  document.getElementById('restore-btn').disabled=true;
  document.getElementById('import-preview').style.display='none';
  document.getElementById('import-textarea').value='';
  closeDataPortabilityModal();
  toast('Restored '+count+' keys. Reload the app to apply.',4000);
}

// ── Refresh Health Badge & Modal ──────────────────────────────────────────

function _updateRefreshHealthBadge(){
  const h=S.get('last_refresh_health');
  const badge=document.getElementById('refresh-health-badge');
  if(!badge)return;
  if(!h){badge.style.display='none';return;}
  const total=h.summary?.total||0;
  const ok=h.summary?.ok||0;
  const allOk=ok===total;
  badge.style.display='flex';
  badge.style.background=allOk?'rgba(0,212,170,0.15)':'rgba(255,165,2,0.2)';
  badge.style.borderColor=allOk?'rgba(0,212,170,0.4)':'rgba(255,165,2,0.5)';
  badge.innerHTML=(allOk?'&#x2714;':'&#x26A0;')+' '+ok+'/'+total+' tickers'+(allOk?'':' <span style="font-size:9px">tap for details</span>');
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
  const allOk=ok===total;
  const elapsed=h.elapsedLabel||null;

  const tickerRows=Object.entries(h.tickers||{}).map(([t,v])=>{
    const ok=v.snap&&v.hist&&v.finnhub;
    const status=ok?'&#x2714;':'&#x26A0;';
    const color=ok?'var(--green)':'var(--warn)';
    const detail=[
      v.snap?'':'snap failed',
      v.hist?'':'hist failed',
      v.options===true?'':v.options==='skipped'?'options skipped (fresh)':'options failed',
      v.finnhub?'':(v.finnhubDetail?v.finnhubDetail:'finnhub failed'),
    ].filter(Boolean).join(', ');
    return `<div style="font-family:var(--mono);font-size:10px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
      <div style="display:flex;justify-content:space-between">
        <span style="color:var(--text2)">${t}</span>
        <span style="color:${color}">${status}${ok?' OK':''}</span>
      </div>
      ${ok?'':`<div style="color:${color};margin-top:2px;word-break:break-word">${detail}</div>`}
    </div>`;
  }).join('');

  el.innerHTML=`<div class="modal-box" style="max-width:380px;max-height:80vh;overflow-y:auto">
    <div class="modal-title">Last Refresh Health</div>
    <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:10px">
      Completed: ${h.completedTs||h.ts||'unknown'}${elapsed?' &nbsp;·&nbsp; <span style="color:var(--text2)">'+elapsed+'</span>':''}<br>
      Result: <span style="color:${allOk?'var(--green)':'var(--warn)'}">${ok}/${total} tickers fully refreshed</span>
    </div>
    <div style="margin-bottom:12px">${tickerRows}</div>
    <button class="btn btn-secondary" style="width:100%" onclick="document.getElementById('refresh-health-modal').classList.remove('open')">Close</button>
  </div>`;
  el.classList.add('open');
}

function forceAppRefresh(){
  // reload() without true so the SW intercepts the reload and serves
  // files from its fresh cache. reload(true) bypasses the SW on iOS Safari.
  if('caches'in window){caches.keys().then(keys=>{Promise.all(keys.map(k=>caches.delete(k))).then(()=>{toast('Cache cleared -- reloading...',2500);setTimeout(()=>window.location.reload(),2500);});});}
  else{window.location.reload();}
}
