// PutSeller Pro -- prefetch.js
// Prefetch all tickers and full refresh everything.
// Globals used: watchlist, WORKER_URL, S
// Dependencies: helpers.js, api.js, ticker.js, options.js, storage.js

async function prefetchAll(){
  if(!FINNHUB_KEY){toast('Add Finnhub key in Settings');return;}
  if(!navigator.onLine&&!offlineMode){toast('Offline -- cached data unchanged',3000);return;}
  if(offlineMode){toast('Offline mode enabled -- disable in Settings to fetch',3000);return;}
  // Warn if fetching options outside market hours -- IV and OI may be synthetic
  const _pms=getMarketState().state;
  if(_pms!=='open'&&_pms!=='afterhours'){
    toast('Note: options data fetched outside market hours may have synthetic IV. Fetch again during market hours for accurate IVR.',6000);
  }
  const btn=document.getElementById('prefetch-btn');if(btn)btn.disabled=true;
  // Fetch ^GSPC 2Y history once per prefetch run (shared across all tickers)
  try{const cacheAge=(Date.now()-(S.get('hist2y_sp500')?.ts||0))/3600000;
    if(cacheAge>4){const sp2=await yahooHistory('^GSPC','2y','1d');S.set('hist2y_sp500',{timestamps:sp2.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:sp2.closes.map(v=>v!=null?Math.round(v*100)/100:null),ts:Date.now()});}
  }catch{}
  const progressEl=document.getElementById('prefetch-progress');const barEl=document.getElementById('prefetch-progress-bar');const labelEl=document.getElementById('prefetch-label');
  if(progressEl)progressEl.style.display='block';
  for(let i=0;i<watchlist.length;i++){
    const t=watchlist[i];if(barEl)barEl.style.width=Math.round((i/watchlist.length)*100)+'%';if(labelEl)labelEl.textContent=`Fetching ${t} (${i+1}/${watchlist.length})...`;
    try{const[quote,profile,metrics,earnings]=await Promise.all([fh(`/quote?symbol=${t}`),fh(`/stock/profile2?symbol=${t}`),fh(`/stock/metric?symbol=${t}&metric=all`),fh(`/calendar/earnings?symbol=${t}&from=${fmtDate(new Date())}&to=${fmtDate(addDays(new Date(),180))}`)]);
      // Fetch rec and upgrades sequentially to avoid rate limit (60/min on free tier)
      let rec2=null,upgrades2=null,priceTarget2=null;
      try{rec2=await fh(`/stock/recommendation?symbol=${t}`);}catch{}
      try{upgrades2=await fh(`/stock/upgrade-downgrade?symbol=${t}&from=${fmtDate(addDays(new Date(),-90))}`);}catch{}
      try{priceTarget2=await fh(`/stock/price-target?symbol=${t}`);}catch{}S.set('snap_'+t,{ticker:t,name:profile.name||t,price:quote.c,prevClose:quote.pc,change:quote.c-quote.pc,changePct:((quote.c-quote.pc)/quote.pc*100),high:quote.h,low:quote.l,week52High:metrics.metric?.['52WeekHigh']||null,week52Low:metrics.metric?.['52WeekLow']||null,marketCap:profile.marketCapitalization?profile.marketCapitalization*1e6:null,beta:metrics.metric?.beta||null,peRatio:metrics.metric?.peBasicExclExtraTTM||null,dividendYield:metrics.metric?.dividendYieldIndicatedAnnual||null,shortInterest:metrics.metric?.shortInterest||null,shortRatio:metrics.metric?.shortRatio||null,earningsDate:(()=>{const future=(earnings?.earningsCalendar||[]).filter(e=>e.date>=fmtDate(new Date())).sort((a,b)=>a.date.localeCompare(b.date));return future[0]?.date||null;})(),earningsHour:(()=>{const future=(earnings?.earningsCalendar||[]).filter(e=>e.date>=fmtDate(new Date())).sort((a,b)=>a.date.localeCompare(b.date));return future[0]?.hour||null;})(),ts:nowPT(),isLive:true});}catch{}
    try{const h6=await yahooHistory(t,'6mo','1d');S.set('hist_'+t,{timestamps:h6.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:h6.closes.map(v=>v!=null?Math.round(v*100)/100:null),volumes:h6.volumes.map(v=>v||0),ts:nowPT()});}catch{}
    try{const h2=await yahooHistory(t,'2y','1d');S.set('hist2y_'+t,{timestamps:h2.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:h2.closes.map(v=>v!=null?Math.round(v*100)/100:null),ts:nowPT()});}catch{}
    try{const eh=await fh('/stock/earnings?symbol='+t+'&limit=8');if(eh&&eh.length)S.set('earnings_hist_'+t,{data:eh,ts:nowPT()});}catch{}
    try{const h1=await yahooHistory(t,'1y','1d');S.set('hist1y_'+t,{timestamps:h1.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:h1.closes.map(v=>v!=null?Math.round(v*100)/100:null),volumes:h1.volumes.map(v=>v||0),ts:nowPT()});}catch{}
    try{const opts=await yahooOptionsViaProxy(t);
      // Validate before caching -- reject synthetic/after-hours data
      const _pInWindow=_isOptionsLiveWindow();
      const _pHasSameDay=_hasGoodSameDayCache('options_'+t);
      if(!_pInWindow&&_pHasSameDay){
        console.log(t+': prefetch outside live window, preserving same-day options cache');
      }else{
        const _pv=_validateOptionsData(opts);
        if(_pv.valid){
          S.set('options_'+t,{data:slimOptionsData(opts),ts:nowPT()});
        }else if(!S.get('options_'+t)){
          console.warn(t+': prefetch options quality issue ('+_pv.reason+'), saving as only available data');
          S.set('options_'+t,{data:slimOptionsData(opts),ts:nowPT(),synthetic:true});
        }else{
          console.warn(t+': prefetch rejecting options ('+_pv.reason+'), preserving existing cache');
        }
      }
      const _savedOpts=S.get('options_'+t);
      if(_savedOpts){
        const yr=opts?.optionChain?.result?.[0];const rawTs2=yr?.expirationDates||[];
        const allExpPairs2=rawTs2.map(ts=>({ts,date:new Date(ts*1000).toISOString().split('T')[0]}));
        let monthlyPairs2=allExpPairs2.filter(p=>{const d=new Date(p.date+'T12:00:00Z');return(d.getUTCDay()===5||d.getUTCDay()===4)&&d.getUTCDate()>=15&&d.getUTCDate()<=21;}).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);
        if(monthlyPairs2.length===0){const tw=Date.now()+14*86400000;monthlyPairs2=allExpPairs2.filter(p=>p.ts*1000>=tw).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);}
        if(monthlyPairs2.length===0)monthlyPairs2=allExpPairs2.sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);
        for(const pair of monthlyPairs2){
          try{
            const expData=await yahooOptionsViaProxy(t,String(pair.ts));
            const _pExpKey='options_exp_'+t+'_'+pair.date;
            const _pExpInWindow=_isOptionsLiveWindow();
            const _pExpHasSameDay=_hasGoodSameDayCache(_pExpKey);
            if(!_pExpInWindow&&_pExpHasSameDay){
              console.log(t+' '+pair.date+': prefetch outside live window, preserving same-day exp cache');
            }else{
              const _ev=_validateOptionsData(expData);
              if(_ev.valid){
                S.set(_pExpKey,expData);
              }else if(!S.get(_pExpKey)){
                console.warn(t+' '+pair.date+': prefetch exp options synthetic ('+_ev.reason+'), saving as fallback');
                S.set(_pExpKey,{...expData,synthetic:true});
              }else{
                console.warn(t+' '+pair.date+': prefetch exp rejected ('+_ev.reason+'), preserving cache');
              }
            }
          }catch{}
        }
      }
    }catch{}
    // Also fetch quote data for after-hours price and forwardPE
    try{const ah=await fetchAfterHoursPrice(t);if(ah){const snap=S.get('snap_'+t);if(snap){snap.postMarketPrice=ah.postMarketPrice||null;snap.postMarketChange=ah.postMarketChange||null;snap.postMarketChangePct=ah.postMarketChangePct||null;snap.marketState=ah.marketState||null;snap.peForward=ah.forwardPE||null;if(ah.trailingEps!==null)snap.epsTTM=ah.trailingEps;S.set('snap_'+t,snap);}}}catch{}
    try{const qs=await fetchQuoteSummary(t);if(qs){const sn=S.get('snap_'+t);if(sn){
      if(qs.ptMean){sn.ptMean=qs.ptMean;sn.ptHigh=qs.ptHigh||null;sn.ptLow=qs.ptLow||null;sn.ptAnalysts=qs.ptAnalysts||null;}
      if(qs.pegRatio!=null)sn.pegRatio=qs.pegRatio;
      if(qs.evToEbitda!=null)sn.evToEbitda=qs.evToEbitda;
      if(qs.shortPctFloat!=null){sn.shortPctFloat=qs.shortPctFloat;sn.shortRatioYahoo=qs.shortRatioYahoo;}
      if(qs.earningsTrend&&qs.earningsTrend.length)sn.earningsTrend=qs.earningsTrend;
      if(qs.recTrend&&qs.recTrend.length)sn.recTrend=qs.recTrend;
      S.set('snap_'+t,sn);}}}catch{}
    try{const news=await fetchNews(t);S.set('news_'+t,{items:(news||[]).slice(0,10).map(n=>({headline:n.headline,summary:n.summary?n.summary.slice(0,200):null,url:n.url,source:n.source,datetime:n.datetime,sentiment:n.sentiment})),ts:nowPT()});}catch{}
    if(i<watchlist.length-1)await sleep(1000);
  }
  try{const[vh,v3h]=await Promise.all([yahooHistory('^VIX','1y','1d'),yahooHistory('^VIX3M','1y','1d')]);S.set('vix_hist',{timestamps:vh.timestamps.map(d=>d.toISOString()),closes:vh.closes,ts:nowPT()});S.set('vix3m_hist',{timestamps:v3h.timestamps.map(d=>d.toISOString()),closes:v3h.closes,ts:nowPT()});const vc=vh.closes.filter(c=>c!==null);updateVIXIndicator(vc[vc.length-1]);}catch{}
  if(barEl)barEl.style.width='100%';if(labelEl)labelEl.textContent='Prefetch complete!';
  setTimeout(()=>{if(progressEl)progressEl.style.display='none';},2000);
  if(btn)btn.disabled=false;renderWatchlist();toast('All data cached for offline use');
}

async function fullRefreshEverything(){
  if(!FINNHUB_KEY){toast('Add Finnhub key in Settings');return;}
  const btn=document.getElementById('full-refresh-btn');btn.disabled=true;
  document.getElementById('full-refresh-progress').style.display='block';
  const bar=document.getElementById('full-refresh-bar'),label=document.getElementById('full-refresh-label');
  setRefreshSpinner(true);setTopBar(5);
  label.textContent='Step 1/6: Fetching all ticker data...';
  await prefetchAll();bar.style.width='50%';setTopBar(50);
  label.textContent='Step 2/6: Running conviction dashboards...';
  try{await runDashboards(true);}catch{}bar.style.width='65%';setTopBar(65);
  label.textContent='Step 3/6: Loading earnings calendar...';
  try{await loadEarningsTab();}catch{}bar.style.width='75%';setTopBar(75);
  label.textContent='Step 4/6: Refreshing VIX...';
  try{await loadVIX();}catch{}bar.style.width='85%';setTopBar(85);
  label.textContent='Step 5/6: Refreshing ETF data...';
  try{await loadETFTab();}catch{}bar.style.width='93%';setTopBar(93);
  label.textContent='Step 6/6: Refreshing market data...';
  try{await loadMarketTab();}catch{}bar.style.width='100%';setTopBar(100);
  label.textContent='All done!';
  const frTs=nowPT();
  S.set('last_full_refresh_ts',frTs);
  const lbl2=document.getElementById('last-full-refresh-label');
  if(lbl2)lbl2.textContent='Last full refresh: '+frTs;
  setRefreshSpinner(false);
  setTimeout(()=>{document.getElementById('full-refresh-progress').style.display='none';},2000);
  btn.disabled=false;renderWatchlist();toast('Full refresh complete',3000);
}
