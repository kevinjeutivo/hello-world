// PutSeller Pro -- vix.js
// VIX intraday price now uses 5-minute history bars instead of the unreliable quote endpoint.
// VIX tab: load, render chart and content.
// Globals used: vixThreshold, WORKER_URL, S
// Dependencies: helpers.js, ui.js, storage.js

// How old VIX cached data can be (minutes) before a tab switch triggers a
// live refresh.  30 minutes matches the staleness threshold used elsewhere.
const VIX_CACHE_FRESH_MINS=30;
// During market hours use a shorter threshold so intraday VIX stays current
function _vixEffectiveCacheMins(){
  try{const ms=getMarketState().state;return(ms==='open'||ms==='premarket'||ms==='afterhours')?5:30;}
  catch{return 30;}
}

// Returns the age in minutes of a stored timestamp string, or Infinity if
// absent / unparseable.  Handles both bare strings and {ts:'...'} objects.
function _vixCacheAgeMins(tsStr){
  if(!tsStr)return Infinity;
  try{
    const clean=(typeof tsStr==='object'&&tsStr.ts)?tsStr.ts:tsStr;
    const d=new Date(String(clean).replace(/ PT$| UTC$| local$/,'').trim());
    if(isNaN(d.getTime()))return Infinity;
    return(Date.now()-d.getTime())/60000;
  }catch{return Infinity;}
}

function restoreVIXFromCache(){
  const cv=S.get('vix_hist');
  const cv3=S.get('vix3m_hist');

  // Always render whatever is cached first — this guarantees the user sees
  // something immediately and that no cached data is ever lost.
  if(cv){
    renderVIXContent(
      {timestamps:cv.timestamps.map(d=>new Date(d)),closes:cv.closes},
      cv3?{timestamps:cv3.timestamps.map(d=>new Date(d)),closes:cv3.closes}:null,
      false,
      cv.ts
    );
    refreshTsChipAges();
  }

  // After rendering the cache, decide whether to fetch fresh data:
  //   • Only when the device is online AND offlineMode is disabled.
  //   • Only when the cached data is stale (or absent).
  // loadVIX() has its own offline guards at the top and wraps every S.set()
  // in a try block — it never zeros the cache on a failed fetch.
  const ageMins=_vixCacheAgeMins(cv?.ts);
  if(ageMins>=_vixEffectiveCacheMins()&&navigator.onLine&&!offlineMode){
    try{const ms=getMarketState().state;
      if((ms==='open'||ms==='afterhours')&&ageMins<30){
        // Within 30 min of last full fetch: just update the intraday bar
        _refreshVIXIntraday();
      }else{
        // Cache is old or market closed: do a full reload
        loadVIX();
      }
    }catch{loadVIX();}
  }
}

// Lightweight intraday VIX refresh -- only updates the last bar in the
// existing daily cache, no full year re-fetch. Called by restoreVIXFromCache
// during market hours when the cache is stale but < 30 minutes old.
async function _refreshVIXIntraday(){
  const cv=S.get('vix_hist');
  const cv3=S.get('vix3m_hist');
  if(!cv)return; // no base cache to update
  try{
    // Use quote endpoint for reliable live index values -- 5-min bars
    // often return null closes for ^VIX and ^VIX3M index tickers.
    const _vt=Date.now();
    const[vQuote,v3Quote]=await Promise.all([
      fetch(`${WORKER_URL}/?ticker=${encodeURIComponent('^VIX')}&type=quote&_t=${_vt}`).then(r=>r.json()),
      fetch(`${WORKER_URL}/?ticker=${encodeURIComponent('^VIX3M')}&type=quote&_t=${_vt}`).then(r=>r.json())
    ]);
    const vLive=vQuote?.quoteResponse?.result?.[0]?.regularMarketPrice||null;
    const v3Live=v3Quote?.quoteResponse?.result?.[0]?.regularMarketPrice||null;
    let updated=false;
    const vixH={timestamps:cv.timestamps.map(d=>new Date(d)),closes:[...cv.closes]};
    const vix3H=cv3?{timestamps:cv3.timestamps.map(d=>new Date(d)),closes:[...cv3.closes]}:null;
    if(vLive&&vixH.closes.length){
      vixH.closes[vixH.closes.length-1]=Math.round(vLive*100)/100;
      updated=true;
    }
    if(v3Live&&vix3H?.closes.length){
      vix3H.closes[vix3H.closes.length-1]=Math.round(v3Live*100)/100;
      updated=true;
    }
    if(updated){
      S.set('vix_hist',{timestamps:vixH.timestamps.map(d=>d.toISOString()),closes:vixH.closes,ts:nowPT()});
      if(vix3H&&cv3)S.set('vix3m_hist',{timestamps:vix3H.timestamps.map(d=>d.toISOString()),closes:vix3H.closes,ts:nowPT()});
      renderVIXContent(vixH,vix3H,true,nowPT());
    }
  }catch(e){console.warn('VIX intraday refresh failed:',e.message);}
}

async function loadVIX(){
  if(!navigator.onLine&&!offlineMode){toast('Offline -- showing cached VIX',2500);restoreVIXFromCache();return;}
  if(offlineMode){restoreVIXFromCache();return;}
  const el=document.getElementById('vix-content');
  el.innerHTML='<div class="card"><div style="display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--text2)"><div class="spinner"></div>Loading VIX...</div></div>';
  try{
    let vixH,vix3H,isLive=true;
    try{[vixH,vix3H]=await Promise.all([yahooHistory('^VIX','1y','1d'),yahooHistory('^VIX3M','1y','1d')]);S.set('vix_hist',{timestamps:vixH.timestamps.map(d=>d.toISOString()),closes:vixH.closes,ts:nowPT()});S.set('vix3m_hist',{timestamps:vix3H.timestamps.map(d=>d.toISOString()),closes:vix3H.closes,ts:nowPT()});
      // Inject live VIX value via quote endpoint -- more reliable than
      // 5-minute bars which Yahoo sometimes returns as null for ^VIX index.
      // Also fetch ^VIX3M live quote for accurate term structure.
      try{
        const _vt=Date.now();
        const[vQuote,v3Quote]=await Promise.all([
          fetch(`${WORKER_URL}/?ticker=${encodeURIComponent('^VIX')}&type=quote&_t=${_vt}`).then(r=>r.json()),
          fetch(`${WORKER_URL}/?ticker=${encodeURIComponent('^VIX3M')}&type=quote&_t=${_vt}`).then(r=>r.json())
        ]);
        const vLive=vQuote?.quoteResponse?.result?.[0]?.regularMarketPrice||null;
        const v3Live=v3Quote?.quoteResponse?.result?.[0]?.regularMarketPrice||null;
        if(vLive){
          const last=vixH.closes.length-1;
          vixH.closes[last]=Math.round(vLive*100)/100;
          S.set('vix_hist',{timestamps:vixH.timestamps.map(d=>d.toISOString()),closes:vixH.closes,ts:nowPT()});
        }
        if(v3Live&&vix3H){
          const last3=vix3H.closes.length-1;
          vix3H.closes[last3]=Math.round(v3Live*100)/100;
          S.set('vix3m_hist',{timestamps:vix3H.timestamps.map(d=>d.toISOString()),closes:vix3H.closes,ts:nowPT()});
        }
      }catch{}}
    catch{const cv=S.get('vix_hist'),cv3=S.get('vix3m_hist');if(cv){vixH={timestamps:cv.timestamps.map(d=>new Date(d)),closes:cv.closes};vix3H=cv3?{timestamps:cv3.timestamps.map(d=>new Date(d)),closes:cv3.closes}:null;isLive=false;showOfflineBanner(cv.ts);}else throw new Error('No VIX data available');}
    renderVIXContent(vixH,vix3H,isLive,isLive?nowPT():(S.get('vix_hist')?.ts||''));
  }catch(err){document.getElementById('vix-content').innerHTML=`<div class="card"><div style="font-family:var(--mono);font-size:12px;color:var(--red)">Error: ${err.message}</div></div>`;}
}

function renderVIXContent(vixH,vix3H,isLive,ts){
  const el=document.getElementById('vix-content');
  const closes=vixH.closes.filter(c=>c!==null);const vixCurrent=closes[closes.length-1];
  const pct1y=closes.filter(c=>c<vixCurrent).length/closes.length*100;
  const vix3mCloses=vix3H?.closes?.filter(c=>c!==null)||[];const vix3mCurrent=vix3mCloses.length?vix3mCloses[vix3mCloses.length-1]:null;
  const tsRatio=vix3mCurrent?vixCurrent/vix3mCurrent:null;
  updateVIXIndicator(vixCurrent);
  let zoneClass,zoneLabel,zoneGuide;
  if(vixCurrent<15){zoneClass='vix-low';zoneLabel='LOW -- Thin Premiums';zoneGuide='Premiums compressed. Do not chase yield by going too close to current price. Wait for a VIX uptick before adding positions.';}
  else if(vixCurrent<20){zoneClass='vix-normal';zoneLabel='NORMAL -- Standard';zoneGuide='Standard put-selling conditions. Stick to your 12% target and 5-10% OTM buffer.';}
  else if(vixCurrent<30){zoneClass='vix-elevated';zoneLabel='ELEVATED -- Favorable';zoneGuide='Sweet spot for premium collection. IV elevated enough for good premiums without extreme stress. Consider widening OTM buffer slightly.';}
  else if(vixCurrent<40){zoneClass='vix-high';zoneLabel='HIGH -- Fear Spike';zoneGuide='Exceptional premium opportunity but elevated risk. VIX spikes above 30 are historically near peak fear. Use smaller sizes on highest-conviction names.';}
  else{zoneClass='vix-extreme';zoneLabel='EXTREME -- Crisis';zoneGuide='Extraordinary premiums. Sell puts only on strongest names at wider OTM. These conditions always normalize.';}
  let tsLabel='',tsGuide='';
  if(tsRatio!==null){if(tsRatio>1.05){tsLabel='BACKWARDATION';tsGuide='VIX above VIX3M: acute near-term fear, market expects vol to subside. Historically strong time to sell puts.';}else if(tsRatio>0.95){tsLabel='FLAT';tsGuide='Near-term and medium-term vol similar. Neutral signal.';}else{tsLabel='CONTANGO (normal)';tsGuide='VIX below VIX3M: normal structure. Standard conditions for put selling.';}}
  const vix6mo=closes.slice(-126);const sma20=vix6mo.map((_,i)=>i<19?null:avg(vix6mo.slice(i-19,i+1)));const std20=vix6mo.map((_,i)=>i<19?null:stdDev(vix6mo.slice(i-19,i+1)));const upper=sma20.map((s,i)=>s?s+2*std20[i]:null);const lower=sma20.map((s,i)=>s?s-2*std20[i]:null);const vix3m6mo=vix3mCloses.slice(-126);const ts6mo=vixH.timestamps.slice(-126);
  const bbUpper=upper[upper.length-1],bbLower=lower[lower.length-1],bbSMA=sma20[sma20.length-1];
  let bbComment='';if(bbUpper&&vixCurrent>=bbUpper*0.97)bbComment='VIX near upper Bollinger Band -- mean reversion likely. Good time to sell puts before premiums compress.';else if(bbLower&&vixCurrent<=bbLower*1.03)bbComment='VIX near lower Bollinger Band -- premiums compressed. Volatility expansion may be approaching.';else bbComment=`VIX within normal range (${bbLower?.toFixed(1)} - ${bbUpper?.toFixed(1)}, SMA ${bbSMA?.toFixed(1)}).`;
  const ageStr=relAge(ts);
  el.innerHTML=`<div class="${zoneClass} vix-banner"><div><div class="vix-banner-label">${zoneLabel}</div><div style="font-family:var(--mono);font-size:10px;opacity:0.7;margin-top:2px">${ordinal(pct1y)} percentile (1Y) -- alert threshold: ${vixThreshold}</div></div><div class="vix-banner-value">${vixCurrent.toFixed(2)}</div></div>
    ${tsChip(ts,isLive)}
    <div class="metrics-grid">
      <div class="metric-tile"><div class="metric-label">VIX</div><div class="metric-value">${vixCurrent.toFixed(2)}</div></div>
      <div class="metric-tile"><div class="metric-label">1Y Percentile</div><div class="metric-value">${ordinal(pct1y)}</div></div>
      ${vix3mCurrent?`<div class="metric-tile"><div class="metric-label">VIX3M</div><div class="metric-value">${vix3mCurrent.toFixed(2)}</div></div>`:''}
      ${tsRatio?`<div class="metric-tile"><div class="metric-label">VIX/VIX3M</div><div class="metric-value" style="font-size:13px">${tsRatio.toFixed(3)}</div><div class="metric-sub">${tsLabel}</div></div>`:''}
    </div>
    <div class="card"><div class="card-title"><span class="dot" style="background:var(--accent3)"></span>VIX Bollinger Bands (6mo)</div><div class="chart-wrap" style="height:200px"><canvas id="vix-bb-chart"></canvas></div><div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:6px">${bbComment}</div></div>
    <div class="card"><div class="card-title"><span class="dot" style="background:var(--accent3)"></span>VIX Commentary</div><div class="commentary">Zone: ${zoneLabel}
${zoneGuide}

${tsRatio?`Term Structure: ${tsLabel}
${tsGuide}

`:''}Bollinger: ${bbComment}

VIX alert threshold: ${vixThreshold} (configure in Settings). The colored dot on the VIX nav tab and the header banner appear whenever VIX is at or above this level.

Note: VIX reflects S&P 500 implied vol. Individual stock IV can differ substantially -- high-beta tech often carries IV well above VIX.</div></div>`;
  const labels6mo=ts6mo.map(d=>{if(!(d instanceof Date))d=new Date(d);return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});});
  const vixCtx=document.getElementById('vix-bb-chart')?.getContext('2d');
  if(vixCtx){if(window._vixBBChart)window._vixBBChart.destroy();window._vixBBChart=new Chart(vixCtx,{type:'line',data:{labels:labels6mo,datasets:[{data:vix6mo,borderColor:'#e8eaf0',borderWidth:2,pointRadius:0,tension:0.2,fill:false},{data:sma20,borderColor:'#7c6af7',borderWidth:1,pointRadius:0,borderDash:[4,3],fill:false},{data:upper,borderColor:'#ff4757',borderWidth:1,pointRadius:0,borderDash:[2,3],fill:false},{data:lower,borderColor:'#00c896',borderWidth:1,pointRadius:0,borderDash:[2,3],fill:false},...(vix3m6mo.length?[{data:vix3m6mo,borderColor:'#7c6af7',borderWidth:1,pointRadius:0,borderDash:[6,3],fill:false}]:[])],},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#555870',font:{size:9},maxTicksLimit:6},grid:{color:'#2a2e38'}},y:{ticks:{color:'#555870',font:{size:9}},grid:{color:'#2a2e38'}}}}});}
}
