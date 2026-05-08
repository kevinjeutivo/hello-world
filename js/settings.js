// PutSeller Pro -- settings.js
// Settings panel: open/close, save, conviction weights, storage, worker health.
// Globals used: FINNHUB_KEY, watchlist, vixThreshold, tzPref, offlineMode, fontSize, S
// Dependencies: helpers.js, ui.js, storage.js

function getConvictionWeights(){
  return S.get('conviction_weights')||{ivr:1.0,rsi:1.0,range:1.0,apy:1.0,earnings:1.0,ma:1.0,upside:1.0,beta:1.0};
}

function saveConvictionWeights(){
  const keys=['ivr','rsi','range','apy','earnings','ma','upside','beta'];
  const weights={};
  keys.forEach(k=>{
    const el=document.getElementById('weight-'+k);
    if(el)weights[k]=Math.max(0,Math.min(3,parseFloat(el.value)||1.0));
  });
  S.set('conviction_weights',weights);
  toast('Conviction weights saved');
}

function resetConvictionWeights(){
  const defaults={ivr:1.0,rsi:1.0,range:1.0,apy:1.0,earnings:1.0,ma:1.0,upside:1.0,beta:1.0};
  S.set('conviction_weights',defaults);
  loadWeightSliders();
  toast('Weights reset to defaults');
}

function loadWeightSliders(){
  const w=getConvictionWeights();
  const keys=['ivr','rsi','range','apy','earnings','ma','upside','beta'];
  keys.forEach(k=>{
    const el=document.getElementById('weight-'+k);
    const valEl=document.getElementById('weight-val-'+k);
    if(el){el.value=w[k]||1.0;}
    if(valEl){valEl.textContent=(w[k]||1.0).toFixed(1)+'x';}
  });
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

function forceAppRefresh(){
  if('caches'in window){caches.keys().then(keys=>{Promise.all(keys.map(k=>caches.delete(k))).then(()=>{toast('Cache cleared -- reloading...',2500);setTimeout(()=>window.location.reload(true),2500);});});}
  else{window.location.reload(true);}
}
