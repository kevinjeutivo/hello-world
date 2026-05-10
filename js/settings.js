// PutSeller Pro -- settings.js
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
  let usedMB='?',quotaMB='?',pct=0;
  try{
    const est=await navigator.storage.estimate();
    usedMB=(est.usage/1048576).toFixed(1);
    quotaMB=(est.quota/1048576).toFixed(0);
    pct=Math.round(est.usage/est.quota*100);
  }catch{}
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

function openSettings(){
  document.getElementById('finnhub-key-input').value=FINNHUB_KEY;
  document.getElementById('default-watchlist-input').value=watchlist.join(',');
  document.getElementById('vix-threshold-input').value=vixThreshold;
  document.getElementById('tz-pref-input').value=tzPref;
  document.getElementById('offline-mode-input').checked=offlineMode;
  document.getElementById('font-size-input').value=fontSize;
  loadWeightSliders();
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
  tzPref=document.getElementById('tz-pref-input').value;
  S.set('tz_pref',tzPref);
  offlineMode=document.getElementById('offline-mode-input').checked;
  S.set('offline_mode',String(offlineMode));
  updateOfflineModeBar();
  fontSize=document.getElementById('font-size-input').value||'19';
  S.set('font_size',fontSize);
  applyFontSize(fontSize);
  const cv=S.get('vix_hist');
  if(cv?.closes){const c=cv.closes.filter(x=>x!==null);if(c.length)updateVIXIndicator(c[c.length-1]);}
  closeSettings();
  renderWatchlist();
  populateSelects();
  if(currentTicker){
    document.getElementById('ticker-select').value=currentTicker;
    document.getElementById('options-ticker-select').value=currentTicker;
  }
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

function forceAppRefresh(){
  // Use reload() without the hard-reload argument so the service worker
  // intercepts the navigation and serves files from its fresh cache.
  // reload(true) bypasses the SW on iOS Safari, causing a mixed old/new
  // file state where the banner interval can be killed by stale code.
  if('caches'in window){
    caches.keys()
      .then(keys=>Promise.all(keys.map(k=>caches.delete(k))))
      .then(()=>{
        toast('Cache cleared -- reloading...',2500);
        setTimeout(()=>window.location.reload(),2500);
      });
  }else{
    window.location.reload();
  }
}
