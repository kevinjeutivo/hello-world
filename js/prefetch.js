// PutSeller Pro -- prefetch.js
// Prefetch all tickers and full refresh everything.
// Globals used: watchlist, WORKER_URL, S

// Timeout wrapper -- rejects if promise doesn't resolve within ms milliseconds
function _pfTimeout(promise, ms, label){
  return Promise.race([
    promise,
    new Promise((_,rej)=>setTimeout(()=>rej(new Error('Timeout: '+label)),ms))
  ]);
}
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
  // Fetch ^GSPC and ^SP500TR 2Y history once per prefetch run (shared across all tickers)
  // ^GSPC = price return; ^SP500TR = total return index (dividends reinvested, no expense ratio)
  try{
    const cacheAge=(Date.now()-(S.get('hist2y_sp500')?.ts||0))/3600000;
    const cacheAgeTR=(Date.now()-(S.get('hist2y_sp500tr')?.ts||0))/3600000;
    const [_gspc,_sp500tr]=await Promise.all([
      cacheAge>4?_pfTimeout(yahooHistory('^GSPC','2y','1d'),15000,'GSPC').catch(()=>null):Promise.resolve(null),
      cacheAgeTR>4?_pfTimeout(yahooHistory('^SP500TR','2y','1d'),15000,'SP500TR').catch(()=>null):Promise.resolve(null)
    ]);
    if(_gspc)S.set('hist2y_sp500',{timestamps:_gspc.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:_gspc.closes.map(v=>v!=null?Math.round(v*100)/100:null),ts:Date.now()});
    if(_sp500tr)S.set('hist2y_sp500tr',{timestamps:_sp500tr.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:_sp500tr.closes.map(v=>v!=null?Math.round(v*100)/100:null),ts:Date.now()});
  }catch{}
  const progressEl=document.getElementById('prefetch-progress');const barEl=document.getElementById('prefetch-progress-bar');const labelEl=document.getElementById('prefetch-label');
  if(progressEl)progressEl.style.display='block';
  // Initialize health record
  const _pfStartMs=Date.now();
  const _health={ts:nowPT(),tickers:{},global:{}};
  for(let i=0;i<watchlist.length;i++){
    const t=watchlist[i];if(barEl)barEl.style.width=Math.round((i/watchlist.length)*100)+'%';if(labelEl)labelEl.textContent=`Fetching ${t} (${i+1}/${watchlist.length})...`;
    _health.tickers[t]={snap:false,hist:false,options:false};
    try{
      // Yahoo /quote and quoteSummary in parallel -- replaces Finnhub quote+profile2+metric
      const [_ahQ,_qs]=await Promise.all([
        _pfTimeout(fetchAfterHoursPrice(t),10000,t+' Yahoo quote').catch(()=>null),
        _pfTimeout(fetchQuoteSummary(t),10000,t+' quoteSummary').catch(()=>null)
      ]);
      // Finnhub earnings calendar (BMO/AMC timing -- keep on Finnhub)
      const earnings=await _pfTimeout(fh(`/calendar/earnings?symbol=${t}&from=${fmtDate(addDays(new Date(),-740))}&to=${fmtDate(addDays(new Date(),180))}`),10000,t+' earnings').catch(()=>null);
      // Rec/upgrades (skip if cached <24h)
      let rec2=null,upgrades2=null;
      const _recAge=(Date.now()-(S.get('rec_'+t)?.ts?new Date(S.get('rec_'+t).ts).getTime():0))/3600000;
      if(_recAge>=24){
        try{rec2=await _pfTimeout(fh(`/stock/recommendation?symbol=${t}`),8000,t+' rec');}catch{}
        try{upgrades2=await _pfTimeout(fh(`/stock/upgrade-downgrade?symbol=${t}&from=${fmtDate(addDays(new Date(),-90))}`),8000,t+' upgrades');}catch{}
      }
      if(_ahQ&&_ahQ.price){
        const _pf=_ahQ.price,_pp=_ahQ.prevClose||_ahQ.price;
        const _futE=(earnings?.earningsCalendar||[]).filter(e=>e.date>=fmtDate(new Date())).sort((a,b)=>a.date.localeCompare(b.date));
        const _sn2={ticker:t,name:_ahQ.name||t,price:_pf,prevClose:_pp,
          change:_pf-_pp,changePct:((_pf-_pp)/_pp*100),
          high:_ahQ.high||null,low:_ahQ.low||null,
          marketCap:_ahQ.marketCap||null,
          peRatio:_ahQ.peRatio||null,peForward:_ahQ.forwardPE||null,
          epsTTM:_ahQ.trailingEps||null,
          dividendYield:_ahQ.dividendYield!=null?_ahQ.dividendYield*100:null,
          marketState:_ahQ.marketState||null,
          intradayVolume:_ahQ.intradayVolume||null,
          postMarketPrice:_ahQ.postMarketPrice||null,
          postMarketChange:_ahQ.postMarketChange||null,
          postMarketChangePct:_ahQ.postMarketChangePct||null,
          earningsDate:_futE[0]?.date||null,earningsHour:_futE[0]?.hour||null,
          ts:nowPT(),isLive:true};
        if(_qs){if(_qs.beta!=null)_sn2.beta=_qs.beta;if(_qs.ptMean){_sn2.ptMean=_qs.ptMean;_sn2.ptHigh=_qs.ptHigh||null;_sn2.ptLow=_qs.ptLow||null;_sn2.ptAnalysts=_qs.ptAnalysts||null;}if(_qs.pegRatio!=null)_sn2.pegRatio=_qs.pegRatio;if(_qs.evToEbitda!=null)_sn2.evToEbitda=_qs.evToEbitda;if(_qs.shortPctFloat!=null){_sn2.shortPctFloat=_qs.shortPctFloat;_sn2.shortRatioYahoo=_qs.shortRatioYahoo;}if(_qs.earningsTrend&&_qs.earningsTrend.length)_sn2.earningsTrend=_qs.earningsTrend;if(_qs.recTrend&&_qs.recTrend.length)_sn2.recTrend=_qs.recTrend;if(_qs.revenueGrowthYahoo!=null)_sn2.revenueGrowthYahoo=_qs.revenueGrowthYahoo;if(_qs.operatingMarginsYahoo!=null)_sn2.operatingMarginsYahoo=_qs.operatingMarginsYahoo;if(_qs.freeCashflowYahoo!=null&&_qs.totalRevenueYahoo!=null&&_qs.totalRevenueYahoo!==0)_sn2.fcfMarginYahoo=_qs.freeCashflowYahoo/_qs.totalRevenueYahoo;}
        S.set('snap_'+t,_sn2);_health.tickers[t].snap=true;
        if(rec2&&rec2.length)S.set('rec_'+t,{data:rec2[0],ts:nowPT()});
        if(upgrades2&&upgrades2.length)S.set('upgrades_'+t,{data:upgrades2.slice(0,6),ts:nowPT()});
      }
    }catch{}
    // Parallel: 2Y history + options main fetch + intraday (all Yahoo, independent)
    // Always fetch options fresh -- validation guards against writing bad data.
    let _h2ok=false,_opts=null;
    try{
      const [_h2res,_optsRes,_idRes]=await Promise.all([
        _pfTimeout(yahooHistory(t,'2y','1d'),15000,t+' hist2y').catch(e=>{console.warn('hist2y failed:',t,e?.message);return null;}),
        _pfTimeout(yahooOptionsViaProxy(t),15000,t+' options').catch(e=>{console.warn('options failed:',t,e?.message);return null;}),
        _pfTimeout(yahooHistory(t,'1d','5m'),10000,t+' intraday').catch(e=>{console.warn('intraday failed:',t,e?.message);return null;})
      ]);
      // Process intraday sparkline data
      if(_idRes && _idRes.closes && _idRes.closes.length >= 2){
        S.set('intraday_'+t,{closes:_idRes.closes,ts:nowPT()});
        _health.tickers[t].intraday=true;
      }
      // Process history
      if(_h2res){
        const _ts2=_h2res.timestamps.map(d=>Math.floor(d.getTime()/1000));
        const _cl2=_h2res.closes.map(v=>v!=null?Math.round(v*100)/100:null);
        const _vl2=_h2res.volumes?_h2res.volumes.map(v=>v||0):null;
        const _ac2=_h2res.adjcloses?_h2res.adjcloses.map(v=>v!=null?Math.round(v*100)/100:null):null;
        const _now=nowPT();
        S.set('hist2y_'+t,{timestamps:_ts2,closes:_cl2,volumes:_vl2,adjcloses:_ac2,ts:_now});
        _health.tickers[t].hist=true;_h2ok=true;
      }
      // Process options
      if(_optsRes){
        _opts=_optsRes;
        const _pInWindow=_isOptionsLiveWindow();
        const _pHasSameDay=_hasGoodSameDayCache('options_'+t);
        const _pv=_validateOptionsData(_opts);
        if(_pv.valid){
          S.set('options_'+t,{data:slimOptionsData(_opts),ts:nowPT()});_health.tickers[t].options=true;
        }else if(!_pInWindow&&_pHasSameDay){
          console.log(t+': outside live window, fetch INVALID ('+_pv.reason+') -- preserving same-day options cache');
        }else if(!S.get('options_'+t)){
          S.set('options_'+t,{data:slimOptionsData(_opts),ts:nowPT(),synthetic:true});
        }else{
          console.warn(t+': rejecting options ('+_pv.reason+'), preserving cache');
        }
      }
    }catch(e){console.warn('prefetch parallel hist/opts failed:',t,e?.message);}
    // Pending earnings: promote passed dates, save current future date
    try{
      promoteEarningsPending(t);
      const _pfFutE=(earnings?.earningsCalendar||[])
        .filter(e=>e.date>=fmtDate(new Date())).sort((a,b)=>a.date.localeCompare(b.date));
      if(_pfFutE[0]?.date)saveEarningsPending(t,_pfFutE[0].date,_pfFutE[0].hour||null);
      // Supplement confirmed from past calendar entries
      const _pfConf=S.get('earnings_confirmed_'+t)||[];
      const _pfCut=new Date();_pfCut.setDate(_pfCut.getDate()-_EARN_EVICT_DAYS);
      let _pfChg=false;
      (earnings?.earningsCalendar||[]).filter(e=>e.date&&e.date<fmtDate(new Date())).forEach(e=>{
        if(!e.date||new Date(e.date)<_pfCut)return;
        if(!_pfConf.some(c=>Math.abs(new Date(c.date)-new Date(e.date))<4*86400000)){
          _pfConf.push({date:e.date,hour:e.hour||null,addedTs:nowPT()});_pfChg=true;
        }
      });
      if(_pfChg)S.set('earnings_confirmed_'+t,_pfConf.filter(c=>new Date(c.date)>=_pfCut));
    }catch{}
    // Compute and persist IVR now that hist2y and options are cached
    try{const _iSnap=S.get('snap_'+t);if(_iSnap){const _iv=computeIVR(t,_iSnap.week52High,_iSnap.week52Low,_iSnap.price);if(_iv!=null){_iSnap.ivrVal=_iv;S.set('snap_'+t,_iSnap);}}}catch{}
    // Historical earnings: extrapolate backwards from confirmed next date + gap refinement
    try{
      const _h2r=S.get('hist2y_'+t);const _sn=S.get('snap_'+t);
      const _nextE=_sn?.earningsDate;
      if(_h2r?.closes?.length>=60&&_nextE){
        const _cl=_h2r.closes,_ts=_h2r.timestamps;
        const _cd=_ts.map(ts=>new Date(ts*1000).toISOString().split('T')[0]);
        const _today=fmtDate(new Date());
        // Build gap map
        const _gm={};
        for(let _gi=1;_gi<_cl.length;_gi++){
          const _p=_cl[_gi-1],_c=_cl[_gi];if(!_p||!_c)continue;
          const _gp=Math.abs((_c-_p)/_p*100);
          if(_gp>=2){const _d=_cd[_gi];if(!_gm[_d]||_gp>_gm[_d].gapPct)_gm[_d]={gapPct:_gp,direction:_c>_p?'up':'down'};}
        }
        // Step back 8 quarters from confirmed next earnings
        const _res=[];let _anch=new Date(_nextE+'T12:00:00Z');
        for(let _q=0;_q<8;_q++){
          _anch=new Date(_anch.getTime()-91*86400000);
          const _est=_anch.toISOString().split('T')[0];if(_est>=_today)continue;
          const _ei=_cd.reduce((b,d,i)=>Math.abs(new Date(d)-new Date(_est))<Math.abs(new Date(_cd[b])-new Date(_est))?i:b,0);
          const _ws=Math.max(1,_ei-10),_we=Math.min(_cd.length-1,_ei+10);
          let _bg=null;
          for(let _wi=_ws;_wi<=_we;_wi++){const _wd=_cd[_wi];if(_gm[_wd]&&(!_bg||_gm[_wd].gapPct>_bg.gapPct))_bg={date:_wd,..._gm[_wd]};}
          if(_bg&&_bg.gapPct>=3){_res.push({date:_bg.date,hour:null,gapPct:_bg.gapPct,direction:_bg.direction,source:'gap-confirmed'});}
          else{const _fd=_cd[_ei];if(_fd&&_fd<_today)_res.push({date:_fd,hour:null,gapPct:null,direction:null,source:'estimated'});}
        }
        const _sorted=_res.filter((r,i,a)=>a.findIndex(x=>x.date===r.date)===i).sort((a,b)=>a.date.localeCompare(b.date));
        if(_sorted.length){
          // Preserve manual overrides from prior cache
          const _prev=S.get('earnings_hist_'+t);
          const _prevData=_prev?.data||[];
          _sorted.forEach(entry=>{
            const match=_prevData.find(old=>old.override&&Math.abs(new Date(old.override.date)-new Date(entry.date))<26*86400000);
            if(match?.override)entry.override=match.override;
          });
          S.set('earnings_hist_'+t,{data:_sorted,ts:nowPT()});
        }
      }
    }catch{}
    // Per-expiry options fetch (parallel -- skip only if main options fetch failed)
    const _savedOpts=S.get('options_'+t);
    if(_savedOpts&&_opts){
      const yr=_opts?.optionChain?.result?.[0];const rawTs2=yr?.expirationDates||[];
        const allExpPairs2=rawTs2.map(ts=>({ts,date:new Date(ts*1000).toISOString().split('T')[0]}));
        let monthlyPairs2=allExpPairs2.filter(p=>{const d=new Date(p.date+'T12:00:00Z');return(d.getUTCDay()===5||d.getUTCDay()===4)&&d.getUTCDate()>=15&&d.getUTCDate()<=21;}).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);
        if(monthlyPairs2.length===0){const tw=Date.now()+14*86400000;monthlyPairs2=allExpPairs2.filter(p=>p.ts*1000>=tw).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);}
        if(monthlyPairs2.length===0)monthlyPairs2=allExpPairs2.sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);
        // Parallel: fetch all monthly expiry chains simultaneously (independent Yahoo calls)
        const _expResults=await Promise.all(monthlyPairs2.map(pair=>
          _pfTimeout(yahooOptionsViaProxy(t,String(pair.ts)),12000,t+' exp '+pair.date)
            .then(d=>({pair,data:d,err:null}))
            .catch(e=>({pair,data:null,err:e?.message||'failed'}))
        ));
        _expResults.forEach(({pair,data,err})=>{
          if(err||!data){console.warn(t+' '+pair.date+': exp fetch failed:',err);return;}
          const _pExpKey='options_exp_'+t+'_'+pair.date;
          const _pExpInWindow=_isOptionsLiveWindow();
          const _pExpHasSameDay=_hasGoodSameDayCache(_pExpKey);
          const _ev=_validateOptionsData(data);
          if(_ev.valid){
            const _ps=slimExpData(data);if(_ps)S.set(_pExpKey,{..._ps,ts:nowPT()});
          }else if(!_pExpInWindow&&_pExpHasSameDay){
            console.log(t+' '+pair.date+': outside live window, fetch INVALID ('+_ev.reason+') -- preserving same-day exp cache');
          }else if(!S.get(_pExpKey)){
            const _ps=slimExpData(data);if(_ps)S.set(_pExpKey,{..._ps,ts:nowPT(),synthetic:true});
          }else{
            const _ex=S.get(_pExpKey);console.warn(t+' '+pair.date+': exp rejected ('+_ev.reason+'), preserving cache from '+(_ex?.ts||'unknown ts'));
          }
        });
    }
    try{const news=await fetchNews(t);S.set('news_'+t,{items:(news||[]).slice(0,10).map(n=>({headline:n.headline,summary:n.summary?n.summary.slice(0,200):null,url:n.url,source:n.source,datetime:n.datetime,sentiment:n.sentiment})),ts:nowPT()});}catch{}
    if(i<watchlist.length-1)await sleep(1000);
  }
  try{const[vh,v3h]=await Promise.all([yahooHistory('^VIX','1y','1d'),yahooHistory('^VIX3M','1y','1d')]);S.set('vix_hist',{timestamps:vh.timestamps.map(d=>d.toISOString()),closes:vh.closes,ts:nowPT()});S.set('vix3m_hist',{timestamps:v3h.timestamps.map(d=>d.toISOString()),closes:v3h.closes,ts:nowPT()});const vc=vh.closes.filter(c=>c!==null);updateVIXIndicator(vc[vc.length-1]);}catch{}
  if(barEl)barEl.style.width='100%';if(labelEl)labelEl.textContent='Prefetch complete!';
  setTimeout(()=>{if(progressEl)progressEl.style.display='none';},2000);
  // Refresh sandbox ETF data
  try{
    const _sbTs=S.get('etf_research_tickers')||[];
    for(const _sbT of _sbTs){
      try{
        const[_sbQ,_sbM]=await Promise.all([fh(`/quote?symbol=${_sbT}`),fh(`/stock/metric?symbol=${_sbT}&metric=all`)]);
        const _sbSnap={ticker:_sbT,price:_sbQ.c,change:_sbQ.c-_sbQ.pc,changePct:((_sbQ.c-_sbQ.pc)/_sbQ.pc*100),
          week52High:_sbM.metric?.['52WeekHigh']||null,week52Low:_sbM.metric?.['52WeekLow']||null,
          dividendYield:_sbM.metric?.dividendYieldIndicatedAnnual||null,ts:nowPT()};
        const _sbH=await yahooHistory(_sbT,'1y','1d');
        const _sbR=await fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(_sbT)}&type=dividends&range=3y`);
        let _sbDivs=[],_sbYield=null;
        if(_sbR.ok){const _sbJ=await _sbR.json();const _sbEv=_sbJ.chart?.result?.[0]?.events?.dividends;
          if(_sbEv){_sbDivs=Object.values(_sbEv).sort((a,b)=>b.date-a.date).slice(0,24).map(d=>({date:new Date(d.date*1000).toISOString().split('T')[0],amount:d.amount}));
            const _sbTotal=_sbDivs.slice(0,12).reduce((s,d)=>s+(d.amount||0),0);
            if(_sbSnap.price&&_sbTotal>0)_sbYield=(_sbTotal/_sbSnap.price*100).toFixed(2);}}
        // Read existing cache to preserve fundName/fundDesc
        const _sbExCache=S.get('etf_research_'+_sbT)||{};
        S.set('etf_research_'+_sbT,{
          snap:_sbSnap,fundName:_sbExCache.fundName||_sbT,fundDesc:_sbExCache.fundDesc||'',
          hist:_sbH?{timestamps:_sbH.timestamps.map(d=>d.toISOString()),closes:_sbH.closes}:null,
          distributions:_sbDivs,trailingYield:_sbYield,ts:nowPT()
        });
      }catch(e){console.warn('Sandbox prefetch failed for',_sbT,e);}
      await sleep(300);
    }
  }catch{}
  // Save health record
  const _pfElapsedMs=Date.now()-_pfStartMs;
  const _pfMins=Math.floor(_pfElapsedMs/60000);
  const _pfSecs=Math.round((_pfElapsedMs%60000)/1000);
  _health.completedTs=nowPT();
  _health.elapsedMs=_pfElapsedMs;
  _health.elapsedLabel=(_pfMins>0?_pfMins+'m ':'')+_pfSecs+'s';
  const _totalT=watchlist.length;
  const _okT=Object.values(_health.tickers).filter(v=>v.snap&&v.hist).length;
  const _failedT=watchlist.filter(t=>!(_health.tickers[t]?.snap&&_health.tickers[t]?.hist));
  _health.summary={total:_totalT,ok:_okT,failed:_failedT};
  S.set('last_refresh_health',_health);
  _updateRefreshHealthBadge();
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
  try{runDashboards();}catch{}bar.style.width='65%';setTopBar(65);
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
