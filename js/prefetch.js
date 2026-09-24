// Income Engine -- prefetch.js
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
  if(!FINNHUB_KEY&&!WORKER_URL){toast('Add a Finnhub key or set your Server Address in Settings');return;}
  if(!navigator.onLine&&!offlineMode){toast('Offline -- cached data unchanged',3000);return;}
  if(offlineMode){toast('Offline mode enabled -- disable in Settings to fetch',3000);return;}
  // Warn if fetching options outside market hours -- IV and OI may be synthetic
  const _pms=getMarketState().state;
  if(_pms!=='open'&&_pms!=='afterhours'){
    toast('Note: options data fetched outside market hours may have synthetic IV. Fetch again during market hours for accurate IVR.',6000);
  }
  const btn=document.getElementById('prefetch-btn');if(btn)btn.disabled=true;
  // Fetch ^GSPC, ^SP500TR, and ^IRX 2Y history once per prefetch run (shared across all tickers)
  // ^GSPC = price return; ^SP500TR = total return index (dividends reinvested, no expense ratio)
  // ^IRX = 13-week T-bill discount rate, quoted as a percent (e.g. 5.25) --
  // a real historical short-rate series for the wheel backtest's idle-cash
  // interest calculation, so it isn't stuck applying today's rate uniformly
  // across every historical window (same fetch mechanism already proven for
  // ^GSPC/^SP500TR, just one more index symbol through the same pipeline).
  try{
    const cacheAge=(Date.now()-(S.get('hist2y_sp500')?.ts||0))/3600000;
    const cacheAgeTR=(Date.now()-(S.get('hist2y_sp500tr')?.ts||0))/3600000;
    const cacheAgeIRX=(Date.now()-(S.get('hist2y_irx')?.ts||0))/3600000;
    const [_gspc,_sp500tr,_irx]=await Promise.all([
      cacheAge>4?_pfTimeout(yahooHistory('^GSPC','2y','1d'),15000,'GSPC').catch(()=>null):Promise.resolve(null),
      cacheAgeTR>4?_pfTimeout(yahooHistory('^SP500TR','2y','1d'),15000,'SP500TR').catch(()=>null):Promise.resolve(null),
      cacheAgeIRX>4?_pfTimeout(yahooHistory('^IRX','2y','1d'),15000,'IRX').catch(()=>null):Promise.resolve(null)
    ]);
    if(_gspc)S.set('hist2y_sp500',{timestamps:_gspc.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:_gspc.closes.map(v=>v!=null?Math.round(v*100)/100:null),ts:Date.now()});
    if(_sp500tr)S.set('hist2y_sp500tr',{timestamps:_sp500tr.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:_sp500tr.closes.map(v=>v!=null?Math.round(v*100)/100:null),ts:Date.now()});
    if(_irx)S.set('hist2y_irx',{timestamps:_irx.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:_irx.closes.map(v=>v!=null?Math.round(v*100)/100:null),ts:Date.now()});
  }catch{}
  const progressEl=document.getElementById('prefetch-progress');const barEl=document.getElementById('prefetch-progress-bar');const labelEl=document.getElementById('prefetch-label');
  if(progressEl)progressEl.style.display='block';
  // Initialize health record
  const _pfStartMs=Date.now();
  const _health={ts:nowPT(),tickers:{},global:{}};
  // Timing instrumentation -- temporary, for measuring whether news is
  // ALSO on Finnhub's slow backend tier (like earnings/upgrades) or its
  // fast tier (like quote/candle), before deciding whether throttling
  // news the same way earnings will be throttled is even worth doing.
  // Kept lightweight (just push a duration number per call) so it can
  // stay in place without meaningfully affecting the run it's measuring.
  const _timing={earnings:[],upgrades:[],news:[],yahooBatch:[],expiryChains:[]};
  const _pfSleepMs=parseInt(S.get('prefetch_sleep_ms'))||100;
  for(let i=0;i<watchlist.length;i++){
    const t=watchlist[i];if(barEl)barEl.style.width=Math.round((i/watchlist.length)*100)+'%';if(labelEl)labelEl.textContent=`Fetching ${t} (${i+1}/${watchlist.length})...`;
    _health.tickers[t]={snap:false,hist:false,options:false,finnhub:false};
    // earnings/_opts/_h2ok declared here (shared scope) rather than inside the try
    // below -- previously `earnings` was declared inside that try block and went
    // out of scope by the time the "Pending earnings" bookkeeping block further
    // down referenced it, silently throwing a ReferenceError that was swallowed
    // by that block's own catch{}. Declaring it here fixes that.
    let earnings=null,_opts=null,_h2ok=false;
    // See the health-flag reassignment further below (after the per-expiration
    // fetch block): these need to be readable there, outside the try block
    // where the ticker-level write itself happens.
    // Tri-state, not boolean -- a boolean can't distinguish "freshly
    // fetched and saved this run" from "the fetch failed/was rejected but a
    // genuinely good PRIOR cache still exists" from "nothing usable exists
    // at all (including a synthetic placeholder, which is not usable data
    // even though writing it can itself succeed)". Four builds in a row
    // (481, 485, 488, this one) each fixed a different way a plain boolean
    // let one of those three states get miscounted as another.
    let _pMainStatus='unavailable'; // 'fresh' | 'preserved' | 'unavailable'
    let _pExpFresh=0,_pExpPreserved=0,_pExpTotal=0;
    try{
      const _fetchUpgrades=S.get('fetch_upgrades_enabled')==='true';
      const _upgradesAge=_recAgeHrs(S.get('upgrades_'+t)); // Infinity when missing/unparseable => refetch
      const _needUpgrades=_fetchUpgrades&&_upgradesAge>=24;
      // Dividend history for the wheel backtest's buy-and-hold comparison --
      // changes at most quarterly, so a 24h gate (same convention as
      // upgrades above) avoids re-fetching this on every single prefetch
      // run for no benefit.
      const _divAge=_recAgeHrs(S.get('div_hist_'+t)); // Infinity when missing/unparseable => refetch
      const _needDiv=_divAge>=24;
      // Yahoo batch (quote, quoteSummary, hist2y, main options chain, intraday) fires
      // concurrently with the Finnhub sequence below -- independent providers, no
      // dependency between them. Within the Finnhub side, earnings and upgrades now
      // run one after another (not simultaneously) -- both endpoints share a much
      // slower backend resource at Finnhub (confirmed via their public status page:
      // ~5000ms latency vs 30-250ms for quote/candle endpoints), and firing them at
      // the same instant is the likely cause of the intermittent 403s seen during
      // prefetch, not inter-ticker timing (raising the inter-ticker sleep didn't
      // help, which pointed away from a rate-limit explanation).
      const _yahooBatchStart=Date.now();
      const _yahooBatch=Promise.all([
        _pfTimeout(fetchAfterHoursPrice(t),10000,t+' Yahoo quote').catch(()=>null),
        _pfTimeout(fetchQuoteSummary(t),10000,t+' quoteSummary').catch(()=>null),
        _pfTimeout(yahooHistory(t,'2y','1d'),15000,t+' hist2y').catch(e=>{console.warn('hist2y failed:',t,e?.message);return null;}),
        _pfTimeout(yahooOptionsViaProxy(t),15000,t+' options').catch(e=>{console.warn('options failed:',t,e?.message);return null;}),
        _pfTimeout(yahooHistory(t,'1d','5m'),10000,t+' intraday').catch(e=>{console.warn('intraday failed:',t,e?.message);return null;}),
        _needDiv?_pfTimeout(fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(t)}&type=dividends&range=3y`).then(r=>r.ok?r.json():null),10000,t+' dividends').catch(e=>{console.warn('dividends failed:',t,e?.message);return null;}):Promise.resolve(null)
      ]).then(r=>{_timing.yahooBatch.push(Date.now()-_yahooBatchStart);return r;});
      let _earningsErr=null,_upgradesErr=null;
      const _finnhubSeq=(async()=>{
        const _t0=Date.now();
        const _e=await _pfTimeout(fh(`/calendar/earnings?symbol=${t}&from=${fmtDate(addDays(new Date(),-740))}&to=${fmtDate(addDays(new Date(),180))}`),10000,t+' earnings').catch(e=>{_earningsErr=e?.message||'failed';return null;});
        _timing.earnings.push(Date.now()-_t0);
        const _t1=Date.now();
        const _u=_needUpgrades?await _pfTimeout(fh(`/stock/upgrade-downgrade?symbol=${t}&from=${fmtDate(addDays(new Date(),-90))}`),8000,t+' upgrades').catch(e=>{_upgradesErr=e?.message||'failed';return null;}):null;
        if(_needUpgrades)_timing.upgrades.push(Date.now()-_t1);
        return[_e,_u];
      })();
      const [[_ahQ,_qs,_h2res,_optsRes,_idRes,_divRes],[_earningsRes,upgrades2]]=await Promise.all([_yahooBatch,_finnhubSeq]);
      earnings=_earningsRes;
      // Finnhub health: earnings call must succeed; upgrades must succeed if it was
      // attempted (skipped calls due to <24h cache don't count against health)
      if(_earningsErr){
        console.warn('earnings failed:',t,_earningsErr);
        _health.tickers[t].finnhubDetail='earnings: '+_earningsErr.slice(0,90);
      }else if(_upgradesErr){
        console.warn('upgrades failed:',t,_upgradesErr);
        _health.tickers[t].finnhubDetail='upgrades: '+_upgradesErr.slice(0,90);
      }else{
        _health.tickers[t].finnhub=true;
      }
      if(_ahQ&&_ahQ.price){
        const _pf=_ahQ.price,_pp=_ahQ.prevClose||_ahQ.price;
        const _futE=(earnings?.earningsCalendar||[]).filter(e=>e.date>=_todayET()).sort((a,b)=>a.date.localeCompare(b.date));
        const _pfPrevSnap=S.get('snap_'+t);
        const _pfPmFields=_resolvePostMarketFields(_ahQ,_pfPrevSnap);
        const _sn2={ticker:t,name:_ahQ.name||_pfPrevSnap?.name||t,price:_pf,prevClose:_pp,
          change:_pf-_pp,changePct:((_pf-_pp)/_pp*100),
          high:_ahQ.high||null,low:_ahQ.low||null,
          marketCap:_ahQ.marketCap||null,
          peRatio:_ahQ.peRatio||null,peForward:_ahQ.forwardPE||null,
          epsTTM:_ahQ.trailingEps||null,
          dividendYield:_ahQ.dividendYield!=null?_ahQ.dividendYield*100:null,
          marketState:_pfPmFields.marketState,
          intradayVolume:_ahQ.intradayVolume||null,
          postMarketPrice:_pfPmFields.postMarketPrice,
          postMarketChange:_pfPmFields.postMarketChange,
          postMarketChangePct:_pfPmFields.postMarketChangePct,
          earningsDate:_futE[0]?.date||null,earningsHour:_futE[0]?.hour||null,
          // Same quoteSummary-preservation reasoning as loadTicker/refreshSingleTicker
          // in ticker.js -- seeded from the previous snap so a quoteSummary
          // failure this run doesn't wipe these fields via the unconditional save below.
          sector:_pfPrevSnap?.sector??null,industry:_pfPrevSnap?.industry??null,
          beta:_pfPrevSnap?.beta??null,pegRatio:_pfPrevSnap?.pegRatio??null,
          evToEbitda:_pfPrevSnap?.evToEbitda??null,totalAssets:_pfPrevSnap?.totalAssets??null,
          shortPctFloat:_pfPrevSnap?.shortPctFloat??null,shortRatioYahoo:_pfPrevSnap?.shortRatioYahoo??null,
          ptMean:_pfPrevSnap?.ptMean??null,ptHigh:_pfPrevSnap?.ptHigh??null,ptLow:_pfPrevSnap?.ptLow??null,ptAnalysts:_pfPrevSnap?.ptAnalysts??null,
          earningsTrend:_pfPrevSnap?.earningsTrend??null,recTrend:_pfPrevSnap?.recTrend??null,earningsHistoryYahoo:_pfPrevSnap?.earningsHistoryYahoo??null,
          revenueGrowthYahoo:_pfPrevSnap?.revenueGrowthYahoo??null,operatingMarginsYahoo:_pfPrevSnap?.operatingMarginsYahoo??null,fcfMarginYahoo:_pfPrevSnap?.fcfMarginYahoo??null,
          summaryDegraded:true,summaryTs:_pfPrevSnap?.summaryTs??null,summaryTsEpoch:_pfPrevSnap?.summaryTsEpoch??null,
          ts:nowPT(),tsEpoch:Date.now(),isLive:true};
        if(_qs){_sn2.summaryDegraded=false;_sn2.summaryTs=nowPT();_sn2.summaryTsEpoch=Date.now();if(_qs.sector!=null)_sn2.sector=_qs.sector;if(_qs.industry!=null)_sn2.industry=_qs.industry;if(_qs.beta!=null)_sn2.beta=_qs.beta;if(_qs.ptMean){_sn2.ptMean=_qs.ptMean;_sn2.ptHigh=_qs.ptHigh||null;_sn2.ptLow=_qs.ptLow||null;_sn2.ptAnalysts=_qs.ptAnalysts||null;}if(_qs.pegRatio!=null)_sn2.pegRatio=_qs.pegRatio;if(_qs.evToEbitda!=null)_sn2.evToEbitda=_qs.evToEbitda;if(_qs.shortPctFloat!=null){_sn2.shortPctFloat=_qs.shortPctFloat;_sn2.shortRatioYahoo=_qs.shortRatioYahoo;}if(_qs.totalAssets!=null)_sn2.totalAssets=_qs.totalAssets;if(_qs.earningsTrend&&_qs.earningsTrend.length)_sn2.earningsTrend=_qs.earningsTrend;if(_qs.recTrend&&_qs.recTrend.length)_sn2.recTrend=_qs.recTrend;if(_qs.earningsHistoryYahoo&&_qs.earningsHistoryYahoo.length)_sn2.earningsHistoryYahoo=_qs.earningsHistoryYahoo;if(_qs.revenueGrowthYahoo!=null)_sn2.revenueGrowthYahoo=_qs.revenueGrowthYahoo;if(_qs.operatingMarginsYahoo!=null)_sn2.operatingMarginsYahoo=_qs.operatingMarginsYahoo;if(_qs.freeCashflowYahoo!=null&&_qs.totalRevenueYahoo!=null&&_qs.totalRevenueYahoo!==0)_sn2.fcfMarginYahoo=_qs.freeCashflowYahoo/_qs.totalRevenueYahoo;}
        if(S.set('snap_'+t,_sn2))_health.tickers[t].snap=true; // only report success if it persisted
        _health.tickers[t].summaryDegraded=_sn2.summaryDegraded;
        if(_fetchUpgrades&&upgrades2!==null)S.set('upgrades_'+t,{data:upgrades2.slice(0,6),ts:nowPT(),tsEpoch:Date.now()});
      }
      // Process intraday sparkline data
      if(_idRes && _idRes.closes && _idRes.closes.length >= 2){
        const _idTs=_idRes.timestamps?_idRes.timestamps.map(d=>d instanceof Date?d.getTime():d):null;
        if(S.set('intraday_'+t,{closes:_idRes.closes,timestamps:_idTs,ts:nowPT(),tsEpoch:Date.now()}))_health.tickers[t].intraday=true;
      }
      // Process history
      if(_h2res){
        const _ts2=_h2res.timestamps.map(d=>Math.floor(d.getTime()/1000));
        const _cl2=_h2res.closes.map(v=>v!=null?Math.round(v*100)/100:null);
        const _vl2=_h2res.volumes?_h2res.volumes.map(v=>v||0):null;
        const _ac2=_h2res.adjcloses?_h2res.adjcloses.map(v=>v!=null?Math.round(v*100)/100:null):null;
        const _op2=_h2res.opens?_h2res.opens.map(v=>v!=null?Math.round(v*100)/100:null):null;
        const _hi2=_h2res.highs?_h2res.highs.map(v=>v!=null?Math.round(v*100)/100:null):null;
        const _lo2=_h2res.lows?_h2res.lows.map(v=>v!=null?Math.round(v*100)/100:null):null;
        const _now=nowPT();
        if(S.set('hist2y_'+t,{timestamps:_ts2,closes:_cl2,volumes:_vl2,adjcloses:_ac2,opens:_op2,highs:_hi2,lows:_lo2,ts:_now,tsEpoch:Date.now()})){_health.tickers[t].hist=true;_h2ok=true;}
      }
      // Process dividend history (used by the wheel backtest's
      // buy-and-hold comparison). Only overwrite the cache on an actual
      // fetch attempt this run -- on the 24h-gated skip (_needDiv=false),
      // _divRes is null by construction and the existing cache is left
      // alone, same preserve-on-no-fetch discipline as everything else
      // here, not a fetch failure being silently masked.
      if(_needDiv&&_divRes){
        const _divEvents=_divRes.chart?.result?.[0]?.events?.dividends;
        if(_divEvents){
          const _divList=Object.values(_divEvents).sort((a,b)=>b.date-a.date).slice(0,24)
            .map(d=>({date:new Date(d.date*1000).toISOString().split('T')[0],amount:d.amount}));
          S.set('div_hist_'+t,{distributions:_divList,ts:nowPT(),tsEpoch:Date.now()});
        }
      }
      // Process options
      if(_optsRes){
        _opts=_optsRes;
        const _pInWindow=_isOptionsLiveWindow();
        const _pHasSameDay=_hasGoodSameDayCache('options_'+t);
        const _pv=_validateOptionsData(_opts);
        if(_pv.valid){
          if(S.set('options_'+t,{data:slimOptionsData(_opts),ts:nowPT(),tsEpoch:Date.now()})){
            _pMainStatus='fresh';
          }else{
            // The write itself failed (e.g. storage quota) -- but fresh,
            // valid data existing in memory doesn't mean nothing usable
            // remains: if a good non-synthetic cache from an earlier run is
            // still sitting there untouched (a failed write never overwrites
            // it), the ticker is still 'preserved', not 'unavailable'. You
            // regularly run close to the storage quota, so this isn't
            // theoretical.
            const _ex=S.get('options_'+t);
            _pMainStatus=(_ex&&!_ex.synthetic)?'preserved':'unavailable';
          }
        }else if(!_pInWindow&&_pHasSameDay){
          console.log(t+': outside live window, fetch INVALID ('+_pv.reason+') -- preserving same-day options cache');
          _pMainStatus='preserved'; // _hasGoodSameDayCache already excludes synthetic entries
        }else if(!S.get('options_'+t)){
          S.set('options_'+t,{data:slimOptionsData(_opts),ts:nowPT(),tsEpoch:Date.now(),synthetic:true});
          // stays 'unavailable' -- a synthetic placeholder isn't usable data, even though writing it can itself succeed
        }else{
          const _ex=S.get('options_'+t);
          if(_ex&&!_ex.synthetic){console.warn(t+': rejecting options ('+_pv.reason+'), preserving cache');_pMainStatus='preserved';}
          else console.warn(t+': rejecting options ('+_pv.reason+'), no good prior cache to fall back on');
        }
      }
    }catch(e){console.warn('prefetch batch failed:',t,e?.message);}
    // Pending earnings: promote passed dates, save current future date
    try{
      promoteEarningsPending(t);
      const _pfFutE=(earnings?.earningsCalendar||[])
        .filter(e=>e.date>=_todayET()).sort((a,b)=>a.date.localeCompare(b.date));
      if(_pfFutE[0]?.date)saveEarningsPending(t,_pfFutE[0].date,_pfFutE[0].hour||null);
      // Supplement confirmed from past calendar entries -- see
      // _supplementConfirmedEarnings in helpers.js (shared with loadTicker
      // and refreshSingleTicker)
      _supplementConfirmedEarnings(t,earnings?.earningsCalendar);
    }catch{}
    // Compute and persist IVR now that hist2y and options are cached
    try{const _iSnap=S.get('snap_'+t);if(_iSnap){const _iv=computeIVR(t,_iSnap.week52High,_iSnap.week52Low,_iSnap.price);if(_iv!=null){_iSnap.ivrVal=_iv;S.set('snap_'+t,_iSnap);}}}catch{}
    // Historical earnings dates for the chart markers -- see _buildEarningsHistory
    // in helpers.js for the full algorithm (shared with ticker.js).
    _buildEarningsHistory(t);
    // Multiple History (TTM & forward P/E) -- same ordering requirement as
    // loadTicker/refreshSingleTicker in ticker.js: must run after both
    // hist2y_ and earnings_hist_ are current for this ticker.
    _updateMultipleHistory(t,S.get('snap_'+t),S.get('hist2y_'+t));
    _updateNextFYHistory(t,S.get('snap_'+t),S.get('hist2y_'+t));
    // Per-expiry options fetch (parallel -- skip only if main options fetch failed)
    // _pMainStatus/_pExpFresh/_pExpPreserved/_pExpTotal declared before the
    // try block above (see its declaration) so they survive across both
    // this block and the health-flag assignment further below. Note this
    // gate is _savedOpts (is there SOME ticker-level cache now, fresh or
    // preserved), not _pMainStatus -- expiration fetches still run even when
    // the main write only preserved existing data rather than writing fresh.
    const _savedOpts=S.get('options_'+t);
    if(_savedOpts&&_opts){
      _pruneExpiredOptionExpiries(t);
      const yr=_opts?.optionChain?.result?.[0];const rawTs2=yr?.expirationDates||[];
        const allExpPairs2=rawTs2.map(ts=>({ts,date:new Date(ts*1000).toISOString().split('T')[0]}));
        let monthlyPairs2=allExpPairs2.filter(p=>{const d=new Date(p.date+'T12:00:00Z');return(d.getUTCDay()===5||d.getUTCDay()===4)&&d.getUTCDate()>=15&&d.getUTCDate()<=21;}).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);
        if(monthlyPairs2.length===0){const tw=Date.now()+14*86400000;monthlyPairs2=allExpPairs2.filter(p=>p.ts*1000>=tw).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);}
        if(monthlyPairs2.length===0)monthlyPairs2=allExpPairs2.sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);
        // Parallel: fetch all monthly expiry chains simultaneously (independent Yahoo calls)
        const _expStart=Date.now();
        const _expResults=await Promise.all(monthlyPairs2.map(pair=>
          _pfTimeout(yahooOptionsViaProxy(t,String(pair.ts)),12000,t+' exp '+pair.date)
            .then(d=>({pair,data:d,err:null}))
            .catch(e=>({pair,data:null,err:e?.message||'failed'}))
        ));
        _timing.expiryChains.push(Date.now()-_expStart);
        _expResults.forEach(({pair,data,err})=>{
          // _pExpTotal now counts every REQUESTED expiration, including ones
          // whose fetch failed outright -- previously a fetch failure hit an
          // early return before _pExpTotal++ ran at all, so a ticker whose
          // every expiration failed to fetch showed as 0/0 ("fully healthy")
          // rather than 0/3.
          _pExpTotal++;
          const _pExpKey='options_exp_'+t+'_'+pair.date;
          if(err||!data){
            console.warn(t+' '+pair.date+': exp fetch failed:',err);
            // A fetch failure still leaves the user with usable data if a
            // genuinely good (non-synthetic) prior cache exists for this
            // expiration -- same "is there something real to fall back on"
            // question the validation-failure branches below already ask.
            const _ex=S.get(_pExpKey);
            if(_ex&&!_ex.synthetic)_pExpPreserved++;
            return;
          }
          const _pExpInWindow=_isOptionsLiveWindow();
          const _pExpHasSameDay=_hasGoodSameDayCache(_pExpKey);
          const _ev=_validateOptionsData(data);
          if(_ev.valid){
            const _ps=slimExpData(data);if(_ps&&S.set(_pExpKey,{..._ps,ts:nowPT(),tsEpoch:Date.now()}))_pExpFresh++;
          }else if(!_pExpInWindow&&_pExpHasSameDay){
            console.log(t+' '+pair.date+': outside live window, fetch INVALID ('+_ev.reason+') -- preserving same-day exp cache');
            _pExpPreserved++; // _hasGoodSameDayCache already excludes synthetic entries
          }else if(!S.get(_pExpKey)){
            const _ps=slimExpData(data);if(_ps)S.set(_pExpKey,{..._ps,ts:nowPT(),tsEpoch:Date.now(),synthetic:true});
            // neither fresh nor preserved -- a synthetic placeholder isn't usable data, even though writing it can itself succeed
          }else{
            // Falling back to whatever's already cached here -- but only
            // counts as "preserved" if that entry is real data, not a
            // synthetic placeholder from an earlier failed fetch.
            const _ex=S.get(_pExpKey);
            if(_ex&&!_ex.synthetic){console.warn(t+' '+pair.date+': exp rejected ('+_ev.reason+'), preserving cache from '+(_ex?.ts||'unknown ts'));_pExpPreserved++;}
            else console.warn(t+' '+pair.date+': exp rejected ('+_ev.reason+'), no good prior cache to fall back on');
          }
        });
    }
    // Options health now reflects BOTH the ticker-level metadata status AND
    // every attempted per-expiration outcome, not just the metadata alone
    // (see build 481's identical fix for the single-ticker refresh path --
    // this is the same gap in Prefetch's separate code path). Gated on
    // _pMainStatus!=='unavailable' (fresh OR preserved), not the old
    // fresh-only _pMainWriteOk -- previously a ticker whose main write only
    // preserved good existing data never got its options health set at all,
    // even when every expiration fetch that run had succeeded.
    // optionsExpDetail carries fresh/preserved/total for display -- a
    // "2/3 fresh, 1 preserved" ticker and a "0/3 fresh, 3 preserved" ticker
    // are both fully usable but meaningfully different, which a single ok
    // count couldn't distinguish.
    if(_pMainStatus!=='unavailable'){
      _health.tickers[t].options=(_pExpFresh+_pExpPreserved)===_pExpTotal;
      if(_pExpTotal>0)_health.tickers[t].optionsExpDetail={fresh:_pExpFresh,preserved:_pExpPreserved,total:_pExpTotal};
    }
    {const _tNews=Date.now();try{const news=await _pfTimeout(fetchNews(t),10000,t+' news');_timing.news.push(Date.now()-_tNews);S.set('news_'+t,{items:(news||[]).slice(0,10).map(n=>({headline:n.headline,summary:n.summary?n.summary.slice(0,200):null,url:n.url,source:n.source,datetime:n.datetime,sentiment:n.sentiment})),ts:nowPT(),tsEpoch:Date.now()});}catch{}}
    if(i<watchlist.length-1)await sleep(_pfSleepMs);
  }
  try{const[vh,v3h]=await Promise.all([_pfTimeout(yahooHistory('^VIX','1y','1d'),15000,'VIX'),_pfTimeout(yahooHistory('^VIX3M','1y','1d'),15000,'VIX3M')]);S.set('vix_hist',{timestamps:vh.timestamps.map(d=>d.toISOString()),closes:vh.closes,ts:nowPT(),tsEpoch:Date.now()});S.set('vix3m_hist',{timestamps:v3h.timestamps.map(d=>d.toISOString()),closes:v3h.closes,ts:nowPT(),tsEpoch:Date.now()});const vc=vh.closes.filter(c=>c!==null);updateVIXIndicator(vc[vc.length-1]);}catch{}
  if(barEl)barEl.style.width='100%';if(labelEl)labelEl.textContent='Prefetch complete!';
  setTimeout(()=>{if(progressEl)progressEl.style.display='none';},2000);
  // Refresh sandbox ETF data
  try{
    const _sbTs=S.get('etf_research_tickers')||[];
    for(const _sbT of _sbTs){
      try{
        const _sbQ=await fetchAfterHoursPrice(_sbT);
        if(!_sbQ||!_sbQ.price)throw new Error('no quote for '+_sbT);
        const _sbSnap={ticker:_sbT,price:_sbQ.price,change:_sbQ.price-(_sbQ.prevClose||_sbQ.price),changePct:((_sbQ.price-(_sbQ.prevClose||_sbQ.price))/(_sbQ.prevClose||_sbQ.price)*100),
          week52High:_sbQ.week52High||null,week52Low:_sbQ.week52Low||null,
          dividendYield:_sbQ.dividendYield!=null?_sbQ.dividendYield*100:null,ts:nowPT(),tsEpoch:Date.now()};
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
          distributions:_sbDivs,trailingYield:_sbYield,ts:nowPT(),tsEpoch:Date.now()
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
  // Options is now part of what "ok" means, not just snap/hist/finnhub --
  // this drives both this function's own "N tickers not fully cached" toast
  // and Full Refresh's, and for an app centered on options data, a ticker
  // whose price/earnings data came through but whose option chains didn't
  // isn't meaningfully "fully cached". A ticker with genuinely no options to
  // fetch (0 expirations requested) still reads as healthy here -- see the
  // options flag's own 0/0-is-ok convention.
  const _coreOk=v=>v?.snap&&v?.hist&&v?.finnhub&&v?.options===true;
  const _okT=Object.values(_health.tickers).filter(_coreOk).length;
  const _failedT=watchlist.filter(t=>!_coreOk(_health.tickers[t]));
  // Separate from ok/failed: a ticker fully succeeds (snap/hist/finnhub) but
  // its quoteSummary-derived fields (sector/beta/PEG/price targets/etc.)
  // came back from a previous fetch, not this one -- degraded, not failed.
  const _degradedT=watchlist.filter(t=>_coreOk(_health.tickers[t])&&_health.tickers[t]?.summaryDegraded);
  _health.summary={total:_totalT,ok:_okT,failed:_failedT,degraded:_degradedT};
  // Timing summary -- avg/min/max per endpoint category across this run,
  // not the raw per-call numbers (53+ raw timestamps isn't something
  // anyone needs to read; the shape of the distribution is). Temporary
  // instrumentation, kept lightweight and non-intrusive to the run itself.
  function _summarize(arr){
    if(!arr.length)return null;
    const sum=arr.reduce((a,b)=>a+b,0);
    return{avg:Math.round(sum/arr.length),min:Math.min(...arr),max:Math.max(...arr),n:arr.length};
  }
  _health.timingSummary={
    earnings:_summarize(_timing.earnings),
    upgrades:_summarize(_timing.upgrades),
    news:_summarize(_timing.news),
    yahooBatch:_summarize(_timing.yahooBatch),
    expiryChains:_summarize(_timing.expiryChains)
  };
  const _healthSaved=S.set('last_refresh_health',_health);
  _updateRefreshHealthBadge();
  if(btn)btn.disabled=false;renderWatchlist();
  // _failedT (computed just above, into _health.summary) is the real record of
  // which tickers didn't fully succeed this run -- the toast used to claim
  // success unconditionally regardless of it. If the record itself couldn't
  // be saved (storage full), say so instead -- otherwise the Settings health
  // modal and this same badge, on a later visit, would silently show a
  // STALE record from a previous run with no indication it isn't this one.
  if(!_healthSaved){
    toast('Refresh finished, but results could not be recorded (storage full)',4000);
  }else if(_failedT.length){
    toast(`Prefetch partially complete -- ${_failedT.length} ticker${_failedT.length===1?'':'s'} not fully cached`,4000);
  }else{
    toast('All data cached for offline use');
  }
  markWheelbtDataStale();
  return _health; // lets fullRefreshEverything() use this run's actual in-memory
  // result directly, instead of reading it back from storage -- which stays
  // correct even in the rare case where _healthSaved above was false.
}

async function fullRefreshEverything(){
  if(!FINNHUB_KEY&&!WORKER_URL){toast('Add a Finnhub key or set your Server Address in Settings');return;}
  const btn=document.getElementById('full-refresh-btn');btn.disabled=true;
  document.getElementById('full-refresh-progress').style.display='block';
  const bar=document.getElementById('full-refresh-bar'),label=document.getElementById('full-refresh-label');
  setRefreshSpinner(true);setTopBar(5);
  // Everything from here on is wrapped so an unexpected throw (prefetchAll is
  // the one call below with no local try/catch of its own) can't strand the
  // UI: button stuck disabled, spinner stuck spinning, progress bar stuck
  // visible. All cleanup lives in finally, so it runs whether this finished,
  // partially finished, or threw.
  try{
    label.textContent='Step 1/6: Fetching all ticker data...';
    const _prefetchHealth=await prefetchAll();bar.style.width='50%';setTopBar(50);
    // prefetchAll() doesn't throw on individual ticker failures -- it
    // catches those internally and just records them in _health, so this
    // try block always reaches here whether every ticker succeeded or not.
    // Using prefetchAll()'s own returned _health (the in-memory result of
    // THIS run) rather than reading it back from storage means this stays
    // correct even in the rare case where storage itself couldn't save it.
    const _frHealth=_prefetchHealth;
    const _frFailed=_frHealth?.summary?.failed?.length||0;
    label.textContent='Step 2/6: Running conviction dashboards...';
    try{runDashboards();}catch{}bar.style.width='65%';setTopBar(65);
    label.textContent='Step 3/6: Loading earnings calendar...';
    try{await loadEarningsTab();}catch{}bar.style.width='75%';setTopBar(75);
    label.textContent='Step 4/6: Refreshing VIX...';
    try{await loadVIX();}catch{}bar.style.width='85%';setTopBar(85);
    label.textContent='Step 5/6: Refreshing ETF data...';
    try{await loadETFTab();}catch{}bar.style.width='93%';setTopBar(93);
    label.textContent='Step 6/6: Refreshing market data...';
    try{await restoreMarketFromCache();}catch{}bar.style.width='100%';setTopBar(100);
    label.textContent='All done!';
    const frTs=nowPT();
    S.set('last_full_refresh_ts',frTs);
    S.set('last_full_refresh_ts_epoch',Date.now());
    const lbl2=document.getElementById('last-full-refresh-label');
    // "attempt" rather than "refresh" -- this timestamp gets written
    // whether the run fully succeeded or was only partial (see _frFailed
    // just below), so the label shouldn't imply success either way. Same
    // wording used on redisplay in ui.js, since one stored timestamp can't
    // otherwise distinguish which kind of run it was after the fact.
    if(lbl2)lbl2.textContent='Last full refresh attempt: '+frTs;
    toast(_frFailed?`Full refresh partially complete -- ${_frFailed} ticker${_frFailed===1?'':'s'} not fully cached`:'Full refresh complete',_frFailed?4000:3000);
    markWheelbtDataStale();
  }catch(e){
    console.warn('Full refresh failed:',e?.message||e);
    toast('Full refresh failed -- some data may not have updated',4000);
  }finally{
    setRefreshSpinner(false);
    setTimeout(()=>{const p=document.getElementById('full-refresh-progress');if(p)p.style.display='none';},2000);
    btn.disabled=false;renderWatchlist();
  }
}
