// PutSeller Pro -- ticker.js
// currentBBSpan declared as global in index.html
function _tkTimeout(p,ms,label){return Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error('Timeout: '+label)),ms))]);}
// Ticker tab: load, render, restore from cache, chart functions.
// Globals used: currentTicker, WORKER_URL, S, offlineMode
// Dependencies: helpers.js, api.js, storage.js

async function loadTicker(){
  const t=document.getElementById('ticker-select').value;if(!t)return;
  if(t!==currentTicker){currentTicker=t;S.set('last_ticker',t);document.getElementById('options-ticker-select').value=t;clearOptionsState();currentBBSpan='6m';currentRPSpan='2y';}
  // Cache-freshness gate: if we already have a snap fetched within the last 2
  // minutes, serve from cache instead of doing a redundant live fetch. This
  // avoids re-fetching every time you navigate to the Ticker tab from the
  // watchlist/dashboard or switch tickers in the dropdown -- the same data
  // would just come back from Yahoo/Finnhub seconds or minutes later anyway.
  // Force Refresh / the ticker-level refresh button bypass this entirely since
  // they call refreshSingleTicker() directly, not loadTicker().
  // Uses tsEpoch (a true Date.now() value) rather than parsing the locale-
  // formatted `ts` display string, which has no timezone offset and cannot
  // be reliably reconstructed into an absolute time.
  const _cachedSnap=S.get('snap_'+t);
  if(_cachedSnap?.tsEpoch){
    const _ageMs=Date.now()-_cachedSnap.tsEpoch;
    if(_ageMs>=0&&_ageMs<120000){
      restoreTickerFromCache(t);
      return;
    }
  }
  document.getElementById('ticker-content').innerHTML=`<div class="card"><div style="display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--text2)"><div class="spinner"></div>Loading ${t}...</div></div>`;
  try{
    let snap,hist6mo,hist1y,news,recData,isLive=true;
    try{
      // Only fetch /stock/earnings history if confirmed cache is sparse (<4 entries)
      const _confCacheCount=(S.get('earnings_confirmed_'+t)||[]).length;
      const _needEarningsHist=_confCacheCount<4;
      // Finnhub retained only for earnings calendar (BMO/AMC timing most reliable there)
      // and news/upgrades/recommendations. All price/fundamental fields now from Yahoo.
      const[earnings,earningsHist]=await Promise.all([
        fh(`/calendar/earnings?symbol=${t}&from=${fmtDate(addDays(new Date(),-740))}&to=${fmtDate(addDays(new Date(),180))}`),
        _needEarningsHist?fh(`/stock/earnings?symbol=${t}&limit=8`):Promise.resolve(null)
      ]);
      let rec=null,upgrades=null;
      try{rec=await fh(`/stock/recommendation?symbol=${t}`);}catch{}
      try{upgrades=await fh(`/stock/upgrade-downgrade?symbol=${t}&from=${fmtDate(addDays(new Date(),-90))}`);}catch{}

      // Build snap from Yahoo /quote (via fetchAfterHoursPrice which now returns full quote fields)
      const ah=await fetchAfterHoursPrice(t);
      if(!ah||!ah.price)throw new Error('Yahoo quote failed for '+t);
      const _price=ah.price;
      const _prev=ah.prevClose||_price;
      snap={
        ticker:t,
        name:ah.name||t,
        price:_price,
        prevClose:_prev,
        change:_price-_prev,
        changePct:((_price-_prev)/_prev*100),
        high:ah.high||null,
        low:ah.low||null,
        marketCap:ah.marketCap||null,
        peRatio:ah.peRatio||null,
        peForward:ah.forwardPE||null,
        epsTTM:ah.trailingEps||null,
        dividendYield:ah.dividendYield!=null?ah.dividendYield*100:null, // convert decimal→%
        marketState:ah.marketState||null,
        intradayVolume:ah.intradayVolume||null,
        postMarketPrice:ah.postMarketPrice||null,
        postMarketChange:ah.postMarketChange||null,
        postMarketChangePct:ah.postMarketChangePct||null,
        // Earnings from Finnhub calendar (BMO/AMC timing)
        earningsDate:(()=>{const future=(earnings?.earningsCalendar||[]).filter(e=>e.date>=fmtDate(new Date())).sort((a,b)=>a.date.localeCompare(b.date));return future[0]?.date||null;})(),
        earningsHour:(()=>{const future=(earnings?.earningsCalendar||[]).filter(e=>e.date>=fmtDate(new Date())).sort((a,b)=>a.date.localeCompare(b.date));return future[0]?.hour||null;})(),
        ts:nowPT(),tsEpoch:Date.now(),isLive:true
      };
      recData=rec&&rec.length?rec[0]:null;
      const upgradeData=upgrades&&upgrades.length?upgrades.slice(0,6):[];
      S.set('snap_'+t,snap);S.set('rec_'+t,{data:recData||null,ts:nowPT()});S.set('upgrades_'+t,{data:upgradeData||[],ts:nowPT()});

      // Enrich with Yahoo quoteSummary (beta, short interest, R40 inputs, price targets, trends)
      try{
        const qs=await fetchQuoteSummary(t);
        if(qs){
          if(qs.beta!=null)snap.beta=qs.beta;
          if(qs.ptMean){snap.ptMean=qs.ptMean;snap.ptHigh=qs.ptHigh||null;snap.ptLow=qs.ptLow||null;snap.ptAnalysts=qs.ptAnalysts||null;}
          if(qs.pegRatio!=null)snap.pegRatio=qs.pegRatio;
          if(qs.evToEbitda!=null)snap.evToEbitda=qs.evToEbitda;
          if(qs.shortPctFloat!=null){snap.shortPctFloat=qs.shortPctFloat;snap.shortRatioYahoo=qs.shortRatioYahoo;}
          if(qs.earningsTrend&&qs.earningsTrend.length)snap.earningsTrend=qs.earningsTrend;
          if(qs.recTrend&&qs.recTrend.length)snap.recTrend=qs.recTrend;
          if(qs.revenueGrowthYahoo!=null)snap.revenueGrowthYahoo=qs.revenueGrowthYahoo;
          if(qs.operatingMarginsYahoo!=null)snap.operatingMarginsYahoo=qs.operatingMarginsYahoo;
          if(qs.freeCashflowYahoo!=null&&qs.totalRevenueYahoo!=null&&qs.totalRevenueYahoo!==0)
            snap.fcfMarginYahoo=qs.freeCashflowYahoo/qs.totalRevenueYahoo;
          S.set('snap_'+t,snap);
        }
      }catch{}
    }catch{
      const cached=S.get('snap_'+t);if(cached){snap=cached;isLive=false;showOfflineBanner(cached.ts);}else throw new Error('No data available');
      const cr=S.get('rec_'+t);if(cr)recData=cr.data;
    }
    // Single 2Y fetch populates all three history cache keys
    try{
      const h2=await _tkTimeout(yahooHistory(t,'2y','1d'),15000,'hist2y');
      const _ts2=h2.timestamps.map(d=>Math.floor(d.getTime()/1000));
      const _cl2=h2.closes.map(v=>v!=null?Math.round(v*100)/100:null);
      const _vl2=h2.volumes?h2.volumes.map(v=>v||0):null;
      const _ac2=h2.adjcloses?h2.adjcloses.map(v=>v!=null?Math.round(v*100)/100:null):null;
      const _now=nowPT();
      S.set('hist2y_'+t,{timestamps:_ts2,closes:_cl2,volumes:_vl2,adjcloses:_ac2,ts:_now});
      // Build live hist objects for rendering (sliced from 2Y data -- no separate keys stored)
      hist6mo={timestamps:h2.timestamps.slice(-126),closes:h2.closes.slice(-126),volumes:h2.volumes?h2.volumes.slice(-126):[]};
      hist1y={timestamps:h2.timestamps.slice(-252),closes:h2.closes.slice(-252),volumes:h2.volumes?h2.volumes.slice(-252):[]};
    }catch{
      // Fallback to hist2y_ cache -- slice for the spans needed
      const ch2=S.get('hist2y_'+t);
      if(ch2){
        const _ts=ch2.timestamps.map(d=>new Date(typeof d==='number'?d*1000:d));
        const _cl=ch2.closes,_vl=ch2.volumes||[];
        hist6mo={timestamps:_ts.slice(-126),closes:_cl.slice(-126),volumes:_vl.slice(-126)};
        hist1y={timestamps:_ts.slice(-252),closes:_cl.slice(-252),volumes:_vl.slice(-252)};
        if(!isLive)showOfflineBanner(ch2.ts);
      }
    }
    // ── Save pending earnings date + promote passed dates to confirmed ────────
    try{
      // Promote any pending dates that have now passed
      promoteEarningsPending(t);
      // Save current future earnings date to pending cache
      const _futE=(earnings?.earningsCalendar||[])
        .filter(e=>e.date>=fmtDate(new Date())).sort((a,b)=>a.date.localeCompare(b.date));
      if(_futE[0]?.date)saveEarningsPending(t,_futE[0].date,_futE[0].hour||null);
      // Supplement confirmed from past calendar/hist entries (opportunistic)
      const _confSupp=S.get('earnings_confirmed_'+t)||[];
      const _suppCut=new Date();_suppCut.setDate(_suppCut.getDate()-_EARN_EVICT_DAYS);
      let _suppChg=false;
      [...(earnings?.earningsCalendar||[]).filter(e=>e.date&&e.date<fmtDate(new Date())),
       ...(earningsHist||[]).filter(e=>e.date&&new Date(e.date)<new Date())].forEach(e=>{
        if(!e.date||new Date(e.date)<_suppCut)return;
        if(!_confSupp.some(c=>Math.abs(new Date(c.date)-new Date(e.date))<4*86400000)){
          _confSupp.push({date:e.date,hour:e.hour||null,addedTs:nowPT()});_suppChg=true;
        }
      });
      if(_suppChg)S.set('earnings_confirmed_'+t,_confSupp.filter(c=>new Date(c.date)>=_suppCut));
    }catch{}

    // hist2y_ already populated by single 2Y fetch above
    // ^GSPC + ^SP500TR 2Y history for relative performance chart (shared across tickers)
    try{
      const cacheAge=(Date.now()-(S.get('hist2y_sp500')?.ts||0))/3600000;
      const cacheAgeTR=(Date.now()-(S.get('hist2y_sp500tr')?.ts||0))/3600000;
      const [_gspc,_sp500tr]=await Promise.all([
        cacheAge>4?_tkTimeout(yahooHistory('^GSPC','2y','1d'),15000,'GSPC').catch(()=>null):Promise.resolve(null),
        cacheAgeTR>4?_tkTimeout(yahooHistory('^SP500TR','2y','1d'),15000,'SP500TR').catch(()=>null):Promise.resolve(null)
      ]);
      if(_gspc)S.set('hist2y_sp500',{timestamps:_gspc.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:_gspc.closes.map(v=>v!=null?Math.round(v*100)/100:null),ts:Date.now()});
      if(_sp500tr)S.set('hist2y_sp500tr',{timestamps:_sp500tr.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:_sp500tr.closes.map(v=>v!=null?Math.round(v*100)/100:null),ts:Date.now()});
    }catch{}
    // Historical earnings dates: extrapolate backwards from confirmed next earnings date
    // using ~91-day quarterly cadence, then refine each estimate by finding the
    // largest price gap within a ±10 trading day window around each estimate.
    try{
      const h2raw=S.get('hist2y_'+t);
      const nextEarnings=snap.earningsDate; // confirmed future date from Finnhub
      if(h2raw?.closes?.length>=60&&nextEarnings){
        const closes=h2raw.closes;
        const timestamps=h2raw.timestamps;
        const closeDates=timestamps.map(ts=>new Date(ts*1000).toISOString().split('T')[0]);
        const today=fmtDate(new Date());

        // Build gap map: date -> {gapPct, direction}
        const gapMap={};
        for(let gi=1;gi<closes.length;gi++){
          const prev=closes[gi-1],curr=closes[gi];
          if(!prev||!curr)continue;
          const gapPct=Math.abs((curr-prev)/prev*100);
          if(gapPct>=2){
            const d=closeDates[gi];
            if(!gapMap[d]||gapPct>gapMap[d].gapPct)
              gapMap[d]={gapPct,direction:curr>prev?'up':'down',idx:gi};
          }
        }

        // Step backwards from next earnings in 91-day increments for 8 quarters
        const results=[];
        let anchor=new Date(nextEarnings+'T12:00:00Z');
        for(let q=0;q<8;q++){
          anchor=new Date(anchor.getTime()-91*86400000);
          const est=anchor.toISOString().split('T')[0];
          if(est>=today)continue; // skip if still in future

          // Find the closest trading date to our estimate
          const estIdx=closeDates.reduce((best,d,i)=>
            Math.abs(new Date(d)-new Date(est))<Math.abs(new Date(closeDates[best])-new Date(est))?i:best,0);

          // Search ±10 trading days around estimate for largest gap
          const winStart=Math.max(1,estIdx-10);
          const winEnd=Math.min(closeDates.length-1,estIdx+10);
          let bestGap=null;
          for(let wi=winStart;wi<=winEnd;wi++){
            const wd=closeDates[wi];
            if(gapMap[wd]&&(!bestGap||gapMap[wd].gapPct>bestGap.gapPct)){
              bestGap={date:wd,...gapMap[wd]};
            }
          }

          // Priority 1: check confirmed cache for a real date within ±25 days of estimate
          const _confCacheSlot=(S.get('earnings_confirmed_'+t)||[])
            .find(c=>Math.abs(new Date(c.date)-new Date(est))<26*86400000);

          if(_confCacheSlot){
            // Ground truth from Finnhub earnings surprises -- use directly, no gap detection needed
            results.push({date:_confCacheSlot.date,hour:_confCacheSlot.hour||null,gapPct:null,direction:null,source:'auto-confirmed'});
          }else if(bestGap&&bestGap.gapPct>=3){
            // Gap found within window -- use actual gap date (confirmed)
            results.push({date:bestGap.date,hour:null,gapPct:bestGap.gapPct,direction:bestGap.direction,source:'gap-confirmed'});
          }else{
            // No significant gap found -- use the closest trading date to estimate
            const fallbackDate=closeDates[estIdx];
            if(fallbackDate&&fallbackDate<today){
              results.push({date:fallbackDate,hour:null,gapPct:null,direction:null,source:'estimated'});
            }
          }
        }

        // Apply confirmed cache entries (priority 2 — above gap estimate, below manual override)
        const _confirmed=S.get('earnings_confirmed_'+t)||[];
        results.forEach(entry=>{
          if(entry.override)return; // manual override takes absolute precedence
          const _cmatch=_confirmed.find(c=>Math.abs(new Date(c.date)-new Date(entry.date))<26*86400000);
          if(_cmatch){
            entry.date=_cmatch.date;
            entry.hour=_cmatch.hour||null;
            entry.source='auto-confirmed';
          }
        });

        const sorted=results
          .filter((r,i,a)=>a.findIndex(x=>x.date===r.date)===i) // dedupe
          .sort((a,b)=>a.date.localeCompare(b.date));
        if(sorted.length){
          // Preserve any existing manual overrides before overwriting
          const _existing=S.get('earnings_hist_'+t);
          const _existingData=_existing?.data||[];
          sorted.forEach(entry=>{
            const match=_existingData.find(old=>old.override&&Math.abs(new Date(old.override.date)-new Date(entry.date))<26*86400000);
            if(match?.override)entry.override=match.override;
          });
          S.set('earnings_hist_'+t,{data:sorted,ts:nowPT()});
        }
      }
    }catch{}
    try{news=await fetchNews(t);S.set('news_'+t,{items:(news||[]).slice(0,10).map(n=>({headline:n.headline,summary:n.summary?n.summary.slice(0,200):null,url:n.url,source:n.source,datetime:n.datetime,sentiment:n.sentiment})),ts:nowPT()});}
    catch{const cn=S.get('news_'+t);if(cn)news=cn.items;}
    const upgradesData=S.get('upgrades_'+t)?.data||[];
    // Re-read snap from localStorage to pick up fetchQuoteSummary enrichment
    // (ptMean, pegRatio, earningsTrend etc. are saved there by fetchQuoteSummary)
    const snapFinal=S.get('snap_'+t)||snap;
    const _h2=S.get('hist2y_'+t);
    const _useTR=getRPTotalReturn();
    const _tkCl=_useTR&&_h2?.adjcloses?_h2.adjcloses:_h2?.closes;
    const _hist2y=_h2?{timestamps:_h2.timestamps.map(d=>new Date(d*1000)),closes:_tkCl}:null;
    const _spKey=_useTR?'hist2y_sp500tr':'hist2y_sp500';
    const _sp2=S.get(_spKey)||((_useTR)?S.get('hist2y_sp500'):null);
    const _hist2ySP=_sp2?{timestamps:_sp2.timestamps.map(d=>new Date(d*1000)),closes:_sp2.closes}:null;
    const _ehc=S.get('earnings_hist_'+t);const _earningsHistory=_ehc?.data||null;
    renderTickerContent(snapFinal,hist6mo,hist1y,news,recData,upgradesData,isLive,_hist2y,_hist2ySP,_earningsHistory);renderWatchlist();
  }catch(err){document.getElementById('ticker-content').innerHTML=`<div class="card"><div style="font-family:var(--mono);font-size:12px;color:var(--red)">Error: ${err.message}</div></div>`;}
}

function restoreTickerFromCache(t){
  if(!t)return;
  // Skip restore if a live render just happened for this ticker (within 5 seconds)
  if(_lastLiveRenderTicker===t&&Date.now()-_lastLiveRenderTime<5000)return;
  // Always read the latest snap -- may be enriched by fetchQuoteSummary since last render
  const snap=S.get('snap_'+t);if(!snap)return;
  const ch2=S.get('hist2y_'+t);
  // Derive 6M and 1Y slices from hist2y_ -- no separate hist_ or hist1y_ keys stored
  let hist6mo=null,hist1y=null;
  if(ch2){
    const _ts=ch2.timestamps.map(d=>new Date(d));
    const _cl=ch2.closes,_vl=ch2.volumes||[];
    hist6mo={timestamps:_ts.slice(-126),closes:_cl.slice(-126),volumes:_vl.slice(-126)};
    hist1y={timestamps:_ts.slice(-252),closes:_cl.slice(-252),volumes:_vl.slice(-252)};
  }
  const _rUseTR=getRPTotalReturn();
  const _rTkCl=_rUseTR&&ch2?.adjcloses?ch2.adjcloses:ch2?.closes;
  const hist2y=ch2?{timestamps:ch2.timestamps.map(d=>new Date(d*1000)),closes:_rTkCl,volumes:ch2.volumes||null}:null;
  const _rSpKey=_rUseTR?'hist2y_sp500tr':'hist2y_sp500';
  const sp2c=S.get(_rSpKey)||((_rUseTR)?S.get('hist2y_sp500'):null);
  const hist2ySP=sp2c?{timestamps:sp2c.timestamps.map(d=>new Date(d*1000)),closes:sp2c.closes}:null;
  const ehc=S.get('earnings_hist_'+t);const earningsHistory=ehc?.data||null;
  const cn=S.get('news_'+t);const cr=S.get('rec_'+t);
  const cu=S.get('upgrades_'+t);
  renderTickerContent(snap,hist6mo,hist1y,cn?cn.items:null,cr?cr.data:null,cu?cu.data:[],false,hist2y,hist2ySP,earningsHistory);
  setTimeout(refreshTsChipAges,50);
}

function buildPriceTargetCard(snap){
  const pct=((snap.ptMean-snap.price)/snap.price*100);
  const col=snap.ptMean>snap.price?'var(--green)':'var(--red)';
  const spread=snap.ptLow&&snap.ptHigh?(snap.ptHigh-snap.ptLow).toFixed(2):null;
  const spreadPct=snap.ptLow&&snap.ptHigh?((snap.ptHigh-snap.ptLow)/snap.ptMean*100).toFixed(0):null;
  return '<div class="card"><div class="card-title"><span class="dot" style="background:var(--accent3)"></span>Analyst Price Target</div>'
    +'<div class="metrics-grid">'
    +'<div class="metric-tile"><div class="metric-label">Consensus Target</div>'
    +'<div class="metric-value" style="color:'+col+'">$'+snap.ptMean.toFixed(2)+'</div>'
    +'<div class="metric-sub">'+(pct>=0?'+':'')+pct.toFixed(1)+'% from current'+(snap.ptAnalysts?' &middot; '+snap.ptAnalysts+' analysts':'')+'</div></div>'
    +(snap.ptLow?'<div class="metric-tile"><div class="metric-label">Low Target</div><div class="metric-value">$'+snap.ptLow.toFixed(2)+'</div><div class="metric-sub">'+(((snap.ptLow-snap.price)/snap.price*100)).toFixed(1)+'% from current</div></div>':'')
    +(snap.ptHigh?'<div class="metric-tile"><div class="metric-label">High Target</div><div class="metric-value">$'+snap.ptHigh.toFixed(2)+'</div><div class="metric-sub">'+(((snap.ptHigh-snap.price)/snap.price*100)).toFixed(1)+'% from current</div></div>':'')
    +(spread?'<div class="metric-tile"><div class="metric-label">Analyst Range</div><div class="metric-value" style="font-size:14px">$'+spread+'</div><div class="metric-sub">'+spreadPct+'% spread -- '+( parseFloat(spreadPct)<30?'High consensus':'Wide disagreement')+'</div></div>':'')
    +'</div></div>';
}

function buildEarningsTrendCard(trend){
  const periodLabel=p=>{
    if(p==='0q')return'This Qtr';if(p==='+1q')return'Next Qtr';
    if(p==='0y')return'This Year';if(p==='+1y')return'Next Year';return p;
  };
  const rows=trend.map(p=>{
    const epsStr=p.epsMean!=null?'$'+p.epsMean.toFixed(2):'--';
    const revStr=p.revenueAvg!=null?(p.revenueAvg>=1e9?(p.revenueAvg/1e9).toFixed(1)+'B':(p.revenueAvg/1e6).toFixed(0)+'M'):'--';
    const growthStr=p.growth!=null?((p.growth>=0?'+':'')+( p.growth*100).toFixed(1)+'%'):'--';
    const growthCol=p.growth!=null?(p.growth>0?'var(--green)':'var(--red)'):'var(--text3)';
    return '<tr>'
      +'<td style="color:var(--text2)">'+periodLabel(p.period)+'</td>'
      +'<td>'+epsStr+'</td>'
      +'<td>'+revStr+'</td>'
      +'<td style="color:'+growthCol+'">'+growthStr+'</td>'
      +'</tr>';
  }).join('');
  return '<div class="card"><div class="card-title"><span class="dot" style="background:var(--warn)"></span>Earnings Estimates</div>'
    +'<div class="options-table-wrap"><table class="options-table">'
    +'<thead><tr><th style="text-align:left">Period</th><th style="text-align:left">EPS Est</th><th style="text-align:left">Revenue</th><th style="text-align:left">Growth</th></tr></thead>'
    +'<tbody>'+rows+'</tbody></table></div></div>';
}

function buildRecTrendCard(trend){
  const months=trend.slice(0,3);
  const cols=['#00d4aa','#4fc3f7','#555870'];
  const rows=months.map((m,i)=>{
    const total=(m.strongBuy||0)+(m.buy||0)+(m.hold||0)+(m.sell||0)+(m.strongSell||0);
    const buyPct=total?Math.round(((m.strongBuy||0)+(m.buy||0))/total*100):0;
    const holdPct=total?Math.round((m.hold||0)/total*100):0;
    const sellPct=total?Math.round(((m.sell||0)+(m.strongSell||0))/total*100):0;
    return '<tr>'
      +'<td style="color:var(--text3);font-size:10px">'+m.period+'</td>'
      +'<td style="color:var(--green)">'+buyPct+'% buy</td>'
      +'<td style="color:var(--text2)">'+holdPct+'% hold</td>'
      +'<td style="color:var(--red)">'+sellPct+'% sell</td>'
      +'<td style="color:var(--text3)">'+total+'</td>'
      +'</tr>';
  }).join('');
  return '<div class="card"><div class="card-title"><span class="dot" style="background:var(--accent2)"></span>Recommendation Trend (Monthly)</div>'
    +'<div class="options-table-wrap"><table class="options-table">'
    +'<thead><tr><th style="text-align:left">Month</th><th>Buy%</th><th>Hold%</th><th>Sell%</th><th>Total</th></tr></thead>'
    +'<tbody>'+rows+'</tbody></table></div></div>';
}

function buildUpgradeTable(upgrades){
  if(!upgrades||!upgrades.length)return'';
  const actionColor=a=>a==='upgrade'||a==='init'?'var(--green)':a==='downgrade'?'var(--red)':'var(--text3)';
  const actionLabel=a=>a==='upgrade'?'Upgrade':a==='downgrade'?'Downgrade':a==='init'?'Initiate':'Reiterate';
  const rows=upgrades.map(u=>{
    const date=u.gradeDate?u.gradeDate.slice(0,10):'';
    const from=u.fromGrade||'';
    const to=u.toGrade||'';
    const grade=from&&to?from+' → '+to:to||from;
    const color=actionColor(u.action||'');
    return '<tr>'
      +'<td style="color:var(--text3)">'+date+'</td>'
      +'<td style="color:var(--text)">'+( u.company||'')+'</td>'
      +'<td style="color:'+color+';font-weight:500">'+actionLabel(u.action||'')+'</td>'
      +'<td style="color:var(--text2)">'+grade+'</td>'
      +'</tr>';
  }).join('');
  return '<div class="card"><div class="card-title"><span class="dot" style="background:var(--accent3)"></span>Recent Analyst Actions (90 days)</div>'
    +'<div class="options-table-wrap"><table class="options-table">'
    +'<thead><tr><th style="text-align:left">Date</th><th style="text-align:left">Firm</th><th style="text-align:left">Action</th><th style="text-align:left">Grade</th></tr></thead>'
    +'<tbody>'+rows+'</tbody></table></div></div>';
}

function toggleBBSpan(span){
  currentBBSpan=span; // persist selected span globally
  const btn6=document.getElementById('bb-btn-6m');
  const btn1=document.getElementById('bb-btn-1y');
  const btn2=document.getElementById('bb-btn-2y');
  if(btn6)btn6.style.opacity=span==='6m'?'1':'0.4';
  if(btn1)btn1.style.opacity=span==='1y'?'1':'0.4';
  if(btn2)btn2.style.opacity=span==='2y'?'1':'0.4';
  const t=document.getElementById('ticker-select').value;
  if(!t)return;
  const h2=S.get('hist2y_'+t);
  if(!h2){toast('History not cached -- run full refresh',2500);return;}
  const sliceN=span==='6m'?126:span==='1y'?252:h2.timestamps.length;
  const h={
    timestamps:h2.timestamps.slice(-sliceN).map(d=>new Date(typeof d==='number'?d*1000:d)),
    closes:h2.closes.slice(-sliceN),
    volumes:(h2.volumes||[]).slice(-sliceN)
  };
  // Recompute Bollinger Band data from history (same logic as renderTickerContent)
  let bbData=null;
  if(h.closes&&h.closes.length>20){
    const closes=h.closes.filter(c=>c!==null);
    const sma20=closes.map((_,i)=>i<19?null:avg(closes.slice(i-19,i+1)));
    const stdDev=closes.map((_,i)=>{if(i<19)return null;const sl=closes.slice(i-19,i+1);const m=avg(sl);return Math.sqrt(sl.reduce((s,v)=>s+(v-m)**2,0)/20);});
    const upper=sma20.map((m,i)=>m?m+2*stdDev[i]:null);
    const lower=sma20.map((m,i)=>m?m-2*stdDev[i]:null);
    // Align with timestamps (filter nulls from front)
    const fullCloses=h.closes;
    bbData={timestamps:h.timestamps,closes:fullCloses,sma20,upper,lower};
  }
  if(bbData)renderBBChart(bbData,h);
  // Re-render volume chart for new span
  const _vt=currentTicker;
  const _vh2=S.get('hist2y_'+_vt);
  const _vh2y=_vh2?{timestamps:_vh2.timestamps,closes:_vh2.closes,volumes:_vh2.volumes||null}:null;
  let _vh6m=null,_vh1y=null;
  if(_vh2){
    const _vts=_vh2.timestamps;const _vcl=_vh2.closes;const _vvl=_vh2.volumes||[];
    _vh6m={timestamps:_vts.slice(-126).map(d=>new Date(typeof d==='number'?d*1000:d)),closes:_vcl.slice(-126),volumes:_vvl.slice(-126)};
    _vh1y={timestamps:_vts.slice(-252).map(d=>new Date(d*1000)),closes:_vcl.slice(-252),volumes:_vvl.slice(-252)};
  }
  const _vSnap=S.get('snap_'+_vt);const _avg20=_vSnap?.avgVol20||null;
  renderVolChart(_vh6m,_vh1y,_vh2y,span,_avg20);
  renderHVRChart(_vt,span);
}

function buildR40Tile(snap){
  // Prefer Yahoo financialData fields -- clean decimals, no normalization needed.
  // Fall back to Finnhub fields with normalization if Yahoo not yet cached.
  const hasYahoo=snap.revenueGrowthYahoo!=null&&(snap.fcfMarginYahoo!=null||snap.operatingMarginsYahoo!=null);

  let growthPct,marginPct,marginLabel;

  if(hasYahoo){
    // Yahoo: all fields are clean decimals (0.09 = 9%, 0.15 = 15%)
    growthPct=(snap.revenueGrowthYahoo*100).toFixed(1);
    const margin=snap.fcfMarginYahoo??snap.operatingMarginsYahoo;
    marginPct=(margin*100).toFixed(1);
    marginLabel=snap.fcfMarginYahoo!=null?'FCF':'Operating';
  }else{
    // Finnhub fallback with normalization
    const revGrowth=snap.revenueGrowthTTM;
    const margin=snap.fcfMargin||snap.operatingMargin;
    if(revGrowth===null||revGrowth===undefined||margin===null||margin===undefined)return'';
    let marginNorm=margin;
    if(Math.abs(marginNorm)>200)marginNorm=marginNorm/100;
    else if(Math.abs(marginNorm)<=1&&marginNorm!==0)marginNorm=marginNorm*100;
    marginNorm=Math.max(-100,Math.min(100,marginNorm));
    let growthNorm=revGrowth;
    if(Math.abs(growthNorm)>200)growthNorm=growthNorm/100;
    else if(Math.abs(growthNorm)<=2&&growthNorm!==0)growthNorm=growthNorm*100;
    growthNorm=Math.max(-100,Math.min(500,growthNorm));
    growthPct=growthNorm.toFixed(1);
    marginPct=marginNorm.toFixed(1);
    marginLabel=snap.fcfMargin?'FCF':'Operating';
  }

  if(growthPct===undefined||marginPct===undefined)return'';
  const score=parseFloat(growthPct)+parseFloat(marginPct);
  const scoreStr=score.toFixed(1);
  const scoreColor=score>=40?'var(--green)':score>=20?'var(--warn)':'var(--red)';
  const scoreLabel=score>=40?'Healthy (above 40)':score>=20?'Below threshold (20-40)':'Weak (below 20)';
  const src=hasYahoo?'Yahoo':'Finnhub';
  return '<div class="metric-tile" style="grid-column:span 2">'
    +'<div class="metric-label">Rule of 40 (software/SaaS)</div>'
    +'<div style="display:flex;align-items:baseline;gap:8px;margin-top:4px">'
    +'<div style="font-family:var(--mono);font-size:22px;font-weight:600;color:'+scoreColor+'">'+scoreStr+'</div>'
    +'<div style="font-family:var(--mono);font-size:11px;color:'+scoreColor+'">'+scoreLabel+'</div>'
    +'</div>'
    +'<div class="metric-sub" style="margin-top:4px">Revenue growth '+growthPct+'% + '+marginLabel+' margin '+marginPct+'% = '+scoreStr+' ('+src+').'
    +' Applies primarily to software and SaaS companies. Score above 40 indicates healthy growth-profitability balance.</div>'
    +'</div>';
}

function fmtVol(v){if(v==null)return'N/A';if(v>=1e9)return(v/1e9).toFixed(2)+'B';if(v>=1e6)return(v/1e6).toFixed(2)+'M';if(v>=1e3)return(v/1e3).toFixed(0)+'K';return v.toFixed(0);}

// Compute 52W high and low with dates from Yahoo hist2y_ cache.
// Returns {high, highDate, low, lowDate} or null if insufficient data.
// Uses unadjusted closes (not adjcloses) to match market convention.
function _compute52W(ticker){
  try{
    const h=S.get('hist2y_'+ticker);
    if(!h||!h.closes||!h.timestamps||h.closes.length<2)return null;
    // Slice to last 252 trading days (~1 year)
    const n=Math.min(252,h.closes.length);
    const closes=h.closes.slice(-n);
    const timestamps=h.timestamps.slice(-n);
    let hiIdx=0,loIdx=0;
    for(let i=1;i<closes.length;i++){
      if(closes[i]!=null&&(closes[hiIdx]==null||closes[i]>closes[hiIdx]))hiIdx=i;
      if(closes[i]!=null&&(closes[loIdx]==null||closes[i]<closes[loIdx]))loIdx=i;
    }
    if(closes[hiIdx]==null||closes[loIdx]==null)return null;
    const toDate=ts=>{
      const d=new Date(typeof ts==='number'?ts*1000:ts);
      return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    };
    return{
      high:closes[hiIdx],
      highDate:toDate(timestamps[hiIdx]),
      low:closes[loIdx],
      lowDate:toDate(timestamps[loIdx])
    };
  }catch{return null;}
}

function renderTickerContent(snap,hist,hist1y,news,recData,upgradesData,isLive,hist2y,hist2ySP,earningsHistory){
  if(isLive){_lastLiveRenderTicker=snap.ticker;_lastLiveRenderTime=Date.now();}
  const el=document.getElementById('ticker-content');
  const chgColor=snap.change>=0?'var(--green)':'var(--red)';const chgSign=snap.change>=0?'+':'';
  let rsiStr='N/A',bbStr='',bbData=null;
  if(hist&&hist.closes&&hist.closes.length>20){
    const closes=hist.closes.filter(c=>c!==null);const rsi=computeRSI(closes);
    rsiStr=rsi.length?rsi[rsi.length-1].toFixed(1):'N/A';
    const sma20=closes.map((_,i)=>i<19?null:avg(closes.slice(i-19,i+1)));
    const std20=closes.map((_,i)=>i<19?null:stdDev(closes.slice(i-19,i+1)));
    const upper=sma20.map((s,i)=>s?s+2*std20[i]:null);const lower=sma20.map((s,i)=>s?s-2*std20[i]:null);
    const last=closes.length-1;
    bbStr=`SMA20 $${sma20[last]?.toFixed(2)} | Upper $${upper[last]?.toFixed(2)} | Lower $${lower[last]?.toFixed(2)}`;
    bbData={timestamps:hist.timestamps,closes,sma20,upper,lower};
  }
  const rsiVal=parseFloat(rsiStr);
  const rsiColor=rsiVal>=70?'var(--red)':rsiVal<=30?'var(--green)':'var(--text)';
  const rsiLabel=rsiVal>=70?'Overbought -- consider covered calls':rsiVal<=30?'Oversold -- favorable for put selling':'Neutral';

  // ── Volume computation ────────────────────────────────────────────────────
  const _volMs=typeof getMarketState==='function'?getMarketState().state:'closed';
  const _volIsOpen=_volMs==='open';
  // During market hours, prefer hist1y's last entry for today's volume --
  // it accumulates throughout the day and is refreshed on every full refresh.
  // snap.intradayVolume is a fallback for when hist1y isn't available.
  let todayVol=null;
  if(hist1y?.volumes?.length){
    const _lastVol=hist1y.volumes[hist1y.volumes.length-1];
    if(_lastVol>0)todayVol=_lastVol;
  }
  if(!todayVol)todayVol=snap.intradayVolume||null;
  let avgVol20=null;
  if(hist1y?.volumes?.length>=21){
    const vols=hist1y.volumes.filter(v=>v>0);
    // Exclude last entry if market is open (partial day would skew the average)
    const sliceEnd=_volIsOpen?vols.length-1:vols.length;
    const slice=vols.slice(Math.max(0,sliceEnd-20),sliceEnd);
    if(slice.length>=10)avgVol20=slice.reduce((s,v)=>s+v,0)/slice.length;
  }
  const volRatio=todayVol&&avgVol20?todayVol/avgVol20:null;
  const volRatioLabel=volRatio==null?'':volRatio>=2?'🔥 Unusual':volRatio>=1.5?'🔥 High':volRatio>=1.2?'Elevated':'Normal';
  const volRatioColor=volRatio==null?'var(--text3)':volRatio>=2?'var(--red)':volRatio>=1.5?'rgba(255,165,2,1)':volRatio>=1.2?'var(--warn)':'var(--text2)';
  const earningsTiming=snap.earningsHour==='bmo'?' (before open)':snap.earningsHour==='amc'?' (after close)':'';
  const earningsStr=snap.earningsDate?`<div class="earnings-warn" style="margin-top:10px">Earnings: ${snap.earningsDate}${earningsTiming}</div>`:'';
  const _52wForIVR=_compute52W(snap.ticker);
  const _w52h=_52wForIVR?.high??snap.week52High??null;
  const _w52l=_52wForIVR?.low??snap.week52Low??null;
  const ivrVal=computeIVR(snap.ticker,_w52h,_w52l,snap.price);
  const ivr=ivrInfo(ivrVal);
  // Persist IVR back to snap so watchlist/dashboard can read it without recomputing
  if(ivrVal!=null){snap.ivrVal=ivrVal;S.set('snap_'+snap.ticker,snap);}
  let impliedMoveStr='N/A';
  try{const oc=S.get('options_'+snap.ticker);const res=oc?.data?.optionChain?.result?.[0];if(res&&snap.price){const opts=res.options?.[0];if(opts){const atmP=(opts.puts||[]).filter(p=>Math.abs(p.strike-snap.price)/snap.price<0.03);const atmC=(opts.calls||[]).filter(c=>Math.abs(c.strike-snap.price)/snap.price<0.03);if(atmP.length&&atmC.length){const straddle=((atmP[0].bid+atmP[0].ask)/2)+((atmC[0].bid+atmC[0].ask)/2);impliedMoveStr=`+/-${(straddle/snap.price*100).toFixed(1)}% ($${straddle.toFixed(2)} straddle)`;}}}}catch{}
  // Short interest: prefer Yahoo quoteSummary (reliable on free tier)
  // Fall back to Finnhub fields if Yahoo not yet fetched
  let shortStr='N/A (not reported)';
  if(snap.shortPctFloat!=null&&snap.shortPctFloat>0){
    shortStr=`${(snap.shortPctFloat*100).toFixed(2)}% of float`;
    if(snap.shortRatioYahoo)shortStr+=` (${snap.shortRatioYahoo.toFixed(1)}d to cover)`;
  }else if(snap.shortInterest&&snap.shortInterest>0){
    shortStr=`${(snap.shortInterest/1e6).toFixed(1)}M shares`;
    if(snap.shortRatio)shortStr+=` (${snap.shortRatio.toFixed(1)}d to cover)`;
  }else if(snap.shortInterestPct&&snap.shortInterestPct>0){
    shortStr=`${snap.shortInterestPct.toFixed(1)}% of float`;
  }
  // Analyst recommendation display
  let analystHtml='';
  if(recData){
    const total=(recData.strongBuy||0)+(recData.buy||0)+(recData.hold||0)+(recData.sell||0)+(recData.strongSell||0);
    const bullPct=total>0?Math.round(((recData.strongBuy||0)+(recData.buy||0))/total*100):0;
    const bearPct=total>0?Math.round(((recData.sell||0)+(recData.strongSell||0))/total*100):0;
    const holdPct=100-bullPct-bearPct;
    analystHtml=`<div class="metric-tile" style="grid-column:span 2">
      <div class="metric-label">Analyst Coverage</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
        <div style="font-family:var(--mono);font-size:15px;font-weight:600;color:var(--accent)">${recData.strongBuy+recData.buy>recData.sell+recData.strongSell?'BUY':'HOLD'}</div>
        <div style="font-family:var(--mono);font-size:11px;color:var(--text3)">${total} analysts</div>
      </div>
      <div style="display:flex;height:6px;border-radius:3px;overflow:hidden;margin:6px 0;gap:1px">
        <div style="width:${bullPct}%;background:var(--green);border-radius:3px 0 0 3px"></div>
        <div style="width:${holdPct}%;background:var(--warn)"></div>
        <div style="width:${bearPct}%;background:var(--red);border-radius:0 3px 3px 0"></div>
      </div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--text3)">
        Buy ${(recData.strongBuy||0)+(recData.buy||0)} &nbsp;|&nbsp; Hold ${recData.hold||0} &nbsp;|&nbsp; Sell ${(recData.sell||0)+(recData.strongSell||0)}
        (Strong Buy: ${recData.strongBuy||0}, Strong Sell: ${recData.strongSell||0})
      </div>
    </div>`;
  }
  el.innerHTML=`<div class="card">
    <div class="card-title"><span class="dot"></span>${snap.ticker} -- ${snap.name}</div>
    ${tsChip(snap.ts,isLive)}
    <div style="font-family:var(--mono);font-size:28px;font-weight:500;margin-bottom:4px">$${snap.price?.toFixed(2)||'N/A'}</div>
    <div style="font-family:var(--mono);font-size:13px;color:${chgColor};margin-bottom:6px">${chgSign}${snap.change?.toFixed(2)} (${chgSign}${snap.changePct?.toFixed(2)}%)</div>
    ${(()=>{const _ms=getMarketState().state;const _isPre=_ms==='premarket';const _isOpen=_ms==='open';if(_isOpen||_isPre)return''; // suppress during open session and premarket
if(!snap.postMarketPrice||snap.postMarketPrice===snap.price)return'';
const _label=snap.marketState==='PRE'?'Pre-market':'After-hours';
return`<div style="font-family:var(--mono);font-size:12px;color:${snap.postMarketPrice>snap.price?'var(--green)':'var(--red)'};margin-bottom:8px">${_label}: $${snap.postMarketPrice.toFixed(2)}${snap.postMarketChange?` <span style="font-size:11px">${snap.postMarketChange>=0?'+':''}${snap.postMarketChange.toFixed(2)} (${snap.postMarketChange>=0?'+':''}${snap.postMarketChangePct?.toFixed(2)||'0.00'}%)</span>`:''} <span style="font-size:10px;color:var(--text3)">(${snap.marketState||'extended'})</span></div>`;})()}
    <div class="metrics-grid">
      ${(()=>{const _52w=_compute52W(snap.ticker);
        const hi=_52w?.high??snap.week52High;const hiDate=_52w?.highDate||null;
        const lo=_52w?.low??snap.week52Low;const loDate=_52w?.lowDate||null;
        const hiPct=hi&&snap.price?((snap.price-hi)/hi*100).toFixed(1):null;
        const loPct=lo&&snap.price?((snap.price-lo)/lo*100).toFixed(1):null;
        return`<div class="metric-tile"><div class="metric-label">52W High</div><div class="metric-value" style="font-size:13px">$${hi?.toFixed(2)||'N/A'}</div>${hiDate?`<div class="metric-sub">${hiDate}${hiPct?` · ${hiPct}% from high`:''}</div>`:hiPct?`<div class="metric-sub">${hiPct}% from high</div>`:''}</div>`+
        `<div class="metric-tile"><div class="metric-label">52W Low</div><div class="metric-value" style="font-size:13px">$${lo?.toFixed(2)||'N/A'}</div>${loDate?`<div class="metric-sub">${loDate}${loPct?` · +${loPct}% from low`:''}</div>`:loPct?`<div class="metric-sub">+${loPct}% from low</div>`:''}</div>`;
      })()}
      <div class="metric-tile"><div class="metric-label">Market Cap</div><div class="metric-value" style="font-size:12px">${fmtCap(snap.marketCap)}</div></div>
      <div class="metric-tile"><div class="metric-label">Beta</div><div class="metric-value">${snap.beta?.toFixed(2)||'N/A'}</div></div>
      <div class="metric-tile"><div class="metric-label">P/E (TTM)</div><div class="metric-value">${snap.peRatio?.toFixed(1)||'N/A'}</div></div>
      <div class="metric-tile"><div class="metric-label">P/E (Forward)</div><div class="metric-value">${snap.peForward?.toFixed(1)||'N/A'}</div><div class="metric-sub">${snap.peRatio&&snap.peForward?(snap.peForward<snap.peRatio?'Earnings growth expected':'Earnings shrinkage expected'):'Estimated next 12m earnings'}</div></div>
      <div class="metric-tile"><div class="metric-label">PEG Ratio</div><div class="metric-value" style="color:${snap.pegRatio!=null?(snap.pegRatio<1?'var(--green)':snap.pegRatio<2?'var(--text)':'var(--red)'):'var(--text3)'}">${snap.pegRatio!=null?snap.pegRatio.toFixed(2):'N/A'}</div><div class="metric-sub">${snap.pegRatio!=null?(snap.pegRatio<1?'Undervalued vs growth':snap.pegRatio<2?'Fair value':snap.pegRatio<3?'Expensive':'Very expensive'):'Forward P/E divided by growth rate'}</div></div>
      <div class="metric-tile"><div class="metric-label">EV/EBITDA</div><div class="metric-value">${snap.evToEbitda!=null?snap.evToEbitda.toFixed(1)+'x':'N/A'}</div><div class="metric-sub">${snap.evToEbitda!=null?(snap.evToEbitda<10?'Low (value territory)':snap.evToEbitda<20?'Moderate':snap.evToEbitda<30?'Elevated':'High multiple'):'Enterprise value vs EBITDA'}</div></div>
      <div class="metric-tile"><div class="metric-label">EPS (TTM)</div><div class="metric-value" style="color:${snap.epsTTM>0?'var(--green)':snap.epsTTM<0?'var(--red)':'var(--text)'}">${snap.epsTTM!=null?'$'+snap.epsTTM.toFixed(2):'N/A'}</div><div class="metric-sub">${snap.epsTTM>0?'Profitable':snap.epsTTM<0?'Not profitable (TTM)':''}${snap.epsGrowth!=null?' | YoY '+(snap.epsGrowth>=0?'+':'')+(snap.epsGrowth*100).toFixed(1)+'%':''}</div></div>
      <div class="metric-tile"><div class="metric-label">Div Yield</div><div class="metric-value">${snap.dividendYield?snap.dividendYield.toFixed(2)+'%':'N/A'}</div></div>
      <div class="metric-tile"><div class="metric-label">RSI (14)</div><div class="metric-value" style="color:${rsiColor}">${rsiStr}</div><div class="metric-sub">${rsiLabel}</div></div>
      <div class="metric-tile"><div class="metric-label">Short Interest</div><div class="metric-value" style="font-size:11px">${shortStr}</div></div>

      ${buildR40Tile(snap)}
      ${analystHtml}
      <div class="metric-tile" style="grid-column:span 2">
        <div class="metric-label">Volume</div>
        <div style="display:flex;gap:16px;align-items:baseline;margin-top:4px;flex-wrap:wrap">
          <div>
            <div style="font-family:var(--mono);font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px">Today</div>
            <div style="font-family:var(--mono);font-size:16px;font-weight:600;color:var(--text)">${fmtVol(todayVol)}</div>
          </div>
          <div>
            <div style="font-family:var(--mono);font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px">20D Avg</div>
            <div style="font-family:var(--mono);font-size:16px;font-weight:600;color:var(--text2)">${fmtVol(avgVol20)}</div>
          </div>
          ${volRatio!=null?`<div>
            <div style="font-family:var(--mono);font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px">Ratio</div>
            <div style="font-family:var(--mono);font-size:16px;font-weight:700;color:${volRatioColor}">${volRatio.toFixed(2)}× <span style="font-size:11px">${volRatioLabel}</span></div>
          </div>`:''}
        </div>
        ${todayVol==null?'<div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:4px">Refresh ticker to load today&#39;s volume</div>':''}
      </div>
      <div class="metric-tile" style="grid-column:span 2"><div class="metric-label">Volatility Rank (HVR)</div><div style="margin-top:4px">${ivr.badge||'N/A'}</div><div class="metric-sub" style="margin-top:4px;font-size:10px;line-height:1.4">${ivr.guidance}</div></div>
      ${impliedMoveStr!=='N/A'?`<div class="metric-tile" style="grid-column:span 2"><div class="metric-label">Implied Move (from options)</div><div class="metric-value" style="font-size:13px">${impliedMoveStr}</div><div class="metric-sub">ATM straddle-implied move. Use to gauge how far OTM your strike should be.</div></div>`:''}
    </div>
    ${earningsStr}
  </div>
  ${hist?`<div class="card"><div class="card-title"><span class="dot"></span>Bollinger Bands + RSI</div><div style="display:flex;gap:6px;margin-bottom:4px"><button class="btn btn-secondary" style="font-size:10px;padding:2px 8px" id="bb-btn-6m" onclick="toggleBBSpan(\'6m\')">6M</button><button class="btn btn-secondary" style="font-size:10px;padding:2px 8px;opacity:0.4" id="bb-btn-1y" onclick="toggleBBSpan(\'1y\')">1Y</button><button class="btn btn-secondary" style="font-size:10px;padding:2px 8px;opacity:0.4" id="bb-btn-2y" onclick="toggleBBSpan(\'2y\')">2Y</button></div><div class="chart-wrap" style="height:180px"><canvas id="bb-chart"></canvas></div><div class="chart-wrap" style="height:90px"><canvas id="rsi-chart"></canvas></div><div class="chart-wrap" style="height:70px;margin-top:4px"><canvas id="vol-chart"></canvas></div><div class="chart-wrap" style="height:60px;margin-top:4px"><canvas id="hvr-chart"></canvas></div><div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:6px">${bbStr}</div><div class="commentary" style="margin-top:10px">Bollinger Bands: upper band touch = statistically extended, overbought. Lower band touch = oversold. Narrow bands signal compressed volatility.

RSI (14): below 30 (green shading) = oversold, favorable for puts. Above 70 (red shading) = overbought, favorable for covered calls.</div></div>`:''}
  ${(hist2y&&hist2ySP)?renderRelPerfCard(snap.ticker,hist2y,hist2ySP,earningsHistory):''}  ${hist1y?`<div class="card"><div class="card-title"><span class="dot" style="background:teal"></span>Volume Profile -- Support / Resistance (1Y)</div><div class="chart-wrap" style="height:300px"><canvas id="vp-chart"></canvas></div><div id="vp-analysis"></div></div>`:''}
  <div class="card"><div class="card-title"><span class="dot" style="background:var(--accent2)"></span>Recent News (7 days)</div><div id="news-section">${renderNewsItems(news)}</div></div>
  ${upgradesData&&upgradesData.length?buildUpgradeTable(upgradesData):''}
  ${snap.ptMean?buildPriceTargetCard(snap):''}
  ${snap.earningsTrend&&snap.earningsTrend.length?buildEarningsTrendCard(snap.earningsTrend):''}
  ${snap.recTrend&&snap.recTrend.length?buildRecTrendCard(snap.recTrend):''}`;
  if(bbData)renderBBChart(bbData,hist);
  renderVolChart(hist,hist1y,hist2y,currentBBSpan||'6m',avgVol20);
  renderHVRChart(snap.ticker,currentBBSpan||'6m');
  if(hist1y)renderVPChart(hist1y,snap.price,_w52h,_w52l);
  if(hist2y&&hist2ySP)_initRelPerfChart(snap.ticker,hist2y,hist2ySP,earningsHistory,currentRPSpan||'2y');
}

function renderBBChart(bbData,hist){
  const labels=bbData.timestamps.map(d=>{if(!(d instanceof Date))d=new Date(d);return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});});
  const rsiVals=computeRSI(hist.closes.filter(c=>c!==null));
  const bbCtx=document.getElementById('bb-chart')?.getContext('2d');
  if(bbCtx){if(window._bbChart)window._bbChart.destroy();window._bbChart=new Chart(bbCtx,{type:'line',data:{labels,datasets:[{data:bbData.closes,borderColor:'#e8eaf0',borderWidth:1.5,pointRadius:0,tension:0.2,fill:false},{data:bbData.sma20,borderColor:'#7c6af7',borderWidth:1,pointRadius:0,borderDash:[4,3],fill:false},{data:bbData.upper,borderColor:'#ff4757',borderWidth:1,pointRadius:0,borderDash:[2,3],fill:false},{data:bbData.lower,borderColor:'#00c896',borderWidth:1,pointRadius:0,borderDash:[2,3],fill:false}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#555870',font:{size:9},maxTicksLimit:6},grid:{color:'#2a2e38'}},y:{ticks:{color:'#555870',font:{size:9}},grid:{color:'#2a2e38'}}}}});}
  const rsiCtx=document.getElementById('rsi-chart')?.getContext('2d');
  if(rsiCtx&&rsiVals.length>0){
    const rsiLabels=labels.slice(labels.length-rsiVals.length);
    const ob=rsiVals.map(v=>v>=70?v:null),os=rsiVals.map(v=>v<=30?v:null);
    if(window._rsiChart)window._rsiChart.destroy();
    window._rsiChart=new Chart(rsiCtx,{type:'line',data:{labels:rsiLabels,datasets:[{data:ob,borderColor:'transparent',backgroundColor:'rgba(255,71,87,0.25)',fill:{target:{value:70},above:'rgba(255,71,87,0.25)',below:'transparent'},pointRadius:0,tension:0.2,spanGaps:false},{data:os,borderColor:'transparent',backgroundColor:'rgba(0,200,150,0.25)',fill:{target:{value:30},above:'transparent',below:'rgba(0,200,150,0.25)'},pointRadius:0,tension:0.2,spanGaps:false},{label:'RSI',data:rsiVals,borderColor:'#7c6af7',borderWidth:1.5,pointRadius:0,tension:0.2,fill:false}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{display:false},grid:{color:'#2a2e38'}},y:{min:0,max:100,ticks:{color:'#555870',font:{size:9},stepSize:30},grid:{color:'#2a2e38'}}}},plugins:[{id:'rsiLines',afterDraw(chart){const c=chart.ctx,x=chart.scales.x,y=chart.scales.y;const y70=y.getPixelForValue(70),y30=y.getPixelForValue(30);c.save();c.setLineDash([4,3]);c.lineWidth=1;c.strokeStyle='rgba(255,71,87,0.7)';c.beginPath();c.moveTo(x.left,y70);c.lineTo(x.right,y70);c.stroke();c.strokeStyle='rgba(0,200,150,0.7)';c.beginPath();c.moveTo(x.left,y30);c.lineTo(x.right,y30);c.stroke();c.setLineDash([]);c.font='9px DM Mono,monospace';c.fillStyle='rgba(255,71,87,0.9)';c.fillText('70',x.right+3,y70+3);c.fillStyle='rgba(0,200,150,0.9)';c.fillText('30',x.right+3,y30+3);c.restore();}}]});
  }
}

// ── Relative Performance Chart vs S&P 500 ────────────────────────────────────

// State for earnings overlay toggle -- persisted to localStorage
function getRelPerfEarningsToggle(){return S.get('rp_earnings_toggle')!=='off';}

// State for total return toggle -- persisted to localStorage
function getRPTotalReturn(){return S.get('rp_total_return')==='on';}

function toggleRPTotalReturn(){
  const newVal=!getRPTotalReturn();
  S.set('rp_total_return',newVal?'on':'off');
  const btn=document.getElementById('rp-tr-btn');
  if(btn)btn.style.opacity=newVal?'1':'0.4';
  _triggerRelPerfRedraw();
}

let _rpCmpMenuOpen=false;

function _closeRPCompareMenu(){
  _rpCmpMenuOpen=false;
  const el=document.getElementById('rp-cmp-menu');
  if(el)el.remove();
}

function _openRPCompareMenu(btnEl){
  _closeRPCompareMenu();
  _rpCmpMenuOpen=true;
  const t=currentTicker;
  const cmpTicker=S.get('rp_compare_'+t)||'';
  const opts=(watchlist||[]).filter(x=>x!==t).sort();

  // Full-screen backdrop + centered list -- same proven pattern as modal-overlay
  // elsewhere in the app, rather than a custom positioned popover with manual
  // dismissal listeners (which was unreliable on iOS for this element).
  const backdrop=document.createElement('div');
  backdrop.id='rp-cmp-menu';
  backdrop.style.cssText=
    'position:fixed;inset:0;z-index:500;background:rgba(0,0,0,0.5);'+
    'display:flex;align-items:center;justify-content:center;padding:20px';

  const box=document.createElement('div');
  box.style.cssText=
    'background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);'+
    'max-width:280px;width:100%;max-height:70vh;overflow-y:auto;padding:8px 0';

  const rows=opts.map(x=>
    `<div data-rp-cmp-opt="${x}" style="padding:10px 16px;cursor:pointer;font-family:var(--mono);font-size:13px;color:${x===cmpTicker?'var(--accent)':'var(--text2)'}">${x}${x===cmpTicker?' ✓':''}</div>`
  ).join('');

  box.innerHTML=
    '<div style="font-family:var(--sans);font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--text3);padding:8px 16px 10px;border-bottom:1px solid var(--border)">Compare with</div>'+
    `<div data-rp-cmp-opt="" style="padding:10px 16px;cursor:pointer;font-family:var(--mono);font-size:13px;color:var(--text3);border-bottom:1px solid var(--border)">— None —</div>`+
    rows;

  box.addEventListener('click',e=>{
    const optEl=e.target.closest('[data-rp-cmp-opt]');
    if(optEl){
      setRPCompareTicker(optEl.dataset.rpCmpOpt);
      _closeRPCompareMenu();
    }
  });
  // Tapping the backdrop itself (outside the box) closes the menu
  backdrop.addEventListener('click',e=>{
    if(e.target===backdrop)_closeRPCompareMenu();
  });

  backdrop.appendChild(box);
  document.body.appendChild(backdrop);
}

function setRPCompareTicker(cmp){
  const t=currentTicker;
  if(!t)return;
  if(cmp) S.set('rp_compare_'+t,cmp);
  else S.del('rp_compare_'+t);
  // Update trigger button label
  const btn=document.getElementById('rp-cmp-btn');
  if(btn)btn.textContent=cmp?'Compare: '+cmp+' ▾':'+ Compare ▾';
  // Update legend visibility
  const cmpLegend=document.getElementById('rp-cmp-legend');
  if(cmpLegend){
    cmpLegend.style.display=cmp?'flex':'none';
    const cmpSpan=cmpLegend.querySelector('[data-rp-label="compare"]');
    if(cmpSpan)cmpSpan.textContent=cmp+(getRPTotalReturn()?' (TR)':'');
  }
  _triggerRelPerfRedraw();
}

function _triggerRelPerfRedraw(){
  const t=currentTicker;
  const useTR=getRPTotalReturn();
  const h2c=S.get('hist2y_'+t);
  const tkCloses=useTR&&h2c?.adjcloses?h2c.adjcloses:h2c?.closes;
  if(!h2c||!tkCloses)return;
  const spKey=useTR?'hist2y_sp500tr':'hist2y_sp500';
  const spc=S.get(spKey)||(useTR?S.get('hist2y_sp500'):null);
  if(!spc)return;

  // Comparison ticker (optional third series)
  const cmpTicker=S.get('rp_compare_'+t)||'';
  let cmpData=null;
  if(cmpTicker){
    const cmpC=S.get('hist2y_'+cmpTicker);
    if(cmpC&&cmpC.closes&&cmpC.closes.length>=2){
      const cmpCloses=useTR&&cmpC.adjcloses?cmpC.adjcloses:cmpC.closes;
      cmpData={timestamps:cmpC.timestamps,closes:cmpCloses};
      // Note if TR was requested but adjcloses unavailable
      if(useTR&&!cmpC.adjcloses){
        const cmpSpan=document.querySelector('[data-rp-label="compare"]');
        if(cmpSpan)cmpSpan.textContent=cmpTicker+' (price only)';
      }
    }
  }

  renderRelPerfChart(t,
    {timestamps:h2c.timestamps,closes:tkCloses},
    {timestamps:spc.timestamps,closes:spc.closes},
    _getEarningsWithOverrides(t),currentRPSpan||'2y',
    cmpData?{ticker:cmpTicker,...cmpData}:null);

  // Update legend labels to reflect current TR state
  const trSuffix=useTR?' (TR)':'';
  const legend=document.getElementById('rp-legend');
  if(legend){
    const spans=legend.querySelectorAll('span[data-rp-label]');
    spans.forEach(s=>{
      if(s.dataset.rpLabel==='ticker') s.textContent=t+trSuffix;
      if(s.dataset.rpLabel==='sp500') s.textContent='S&P 500'+trSuffix;
      if(s.dataset.rpLabel==='compare'&&cmpTicker){
        const hasTRData=!!(S.get('hist2y_'+cmpTicker)?.adjcloses);
        s.textContent=cmpTicker+(useTR?(hasTRData?' (TR)':' (price only)'):'');
      }
    });
    const cmpLegend=document.getElementById('rp-cmp-legend');
    if(cmpLegend)cmpLegend.style.display=cmpTicker?'flex':'none';
  }
  // Update subtitle
  const sub=document.getElementById('rp-subtitle');
  if(sub) sub.textContent='Both lines indexed to 100 at start of window. Stock line above S&P line = outperforming.'+(useTR?' Dividends reinvested (total return.)':'');
}

function toggleRPSpan(span){
  currentRPSpan=span;
  ['6m','1y','2y'].forEach(s=>{
    const btn=document.getElementById('rp-btn-'+s);
    if(btn)btn.style.opacity=s===span?'1':'0.4';
  });
  _triggerRelPerfRedraw();
  const titleEl=document.getElementById('rp-title-span');
  if(titleEl){
    const label=span==='6m'?'6 Months':span==='1y'?'1 Year':'2 Years';
    titleEl.textContent='Relative Performance vs S\u0026P 500 ('+label+')';
  }
}

function toggleRelPerfEarnings(){
  S.set('rp_earnings_toggle',getRelPerfEarningsToggle()?'off':'on');
  _triggerRelPerfRedraw();
  const btn=document.getElementById('rp-earn-btn');
  if(btn)btn.style.opacity=getRelPerfEarningsToggle()?'1':'0.4';
}

// ── Earnings date manual overrides ───────────────────────────────────────────
// Each estimated earnings entry can have an optional user override:
//   {date:'YYYY-MM-DD', hour:'bmo'|'amc'|null, addedTs:string}
// Overrides are stored inside each entry's .override field in earnings_hist_TICKER.
// Auto-purge: entries older than 730 days are removed on read.

function _getEarningsWithOverrides(ticker){
  const cache=S.get('earnings_hist_'+ticker);
  if(!cache?.data)return[];
  const cutoff=new Date();cutoff.setDate(cutoff.getDate()-730);
  const cutoffStr=cutoff.toISOString().split('T')[0];
  // Purge old entries
  const fresh=cache.data.filter(e=>{
    const d=e.override?.date||e.date;
    return d>=cutoffStr;
  });
  if(fresh.length!==cache.data.length)
    S.set('earnings_hist_'+ticker,{...cache,data:fresh});
  return fresh;
}

function _effectiveEarningsDate(e){
  // Returns the date and hour to actually use for chart/analysis
  return{
    date:e.override?.date||e.date,
    hour:e.override?.hour!=null?e.override.hour:e.hour,
    isOverride:!!e.override,
    source:e.source
  };
}

let _overrideModalTicker=null;
let _overrideModalIdx=null;

function openEarningsOverrideModal(ticker,idx){
  _overrideModalTicker=ticker;
  _overrideModalIdx=idx;
  const entries=_getEarningsWithOverrides(ticker);
  const entry=entries[idx];
  if(!entry)return;

  const eff=_effectiveEarningsDate(entry);
  const existingOverride=entry.override;

  let el=document.getElementById('earn-override-modal');
  if(!el){
    el=document.createElement('div');
    el.className='modal-overlay';
    el.id='earn-override-modal';
    document.body.appendChild(el);
    el.addEventListener('click',e=>{if(e.target===el)_closeEarningsOverrideModal();});
  }

  // Look up confirmed cache entry for this slot (±25 days)
  const _confCache=S.get('earnings_confirmed_'+ticker)||[];
  const _confEntry=_confCache.find(c=>Math.abs(new Date(c.date)-new Date(entry.date))<26*86400000)||null;
  const _confDateStr=_confEntry?_confEntry.date:null;
  const _confHour=_confEntry?(_confEntry.hour||null):null;
  const _confHourLabel=_confHour==='bmo'?' BMO':_confHour==='amc'?' AMC':'';

  el.innerHTML=
    '<div class="modal-box" style="max-width:360px">'+
      '<div class="modal-title">Override Earnings Date</div>'+
      '<div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:12px;line-height:1.6">'+
        'Enter the actual US Eastern date of the earnings announcement.<br>'+
        'Use the date shown on financial sites such as Earnings Whispers or Yahoo Finance — '+
        'this should be the ET calendar date, which may differ from your local date for late-evening announcements.'+
      '</div>'+
      // Algorithm estimate
      '<div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:6px">'+
        'Algorithm estimate: <span style="color:var(--text2)">'+entry.date+'</span>'+
        (entry.source==='gap-confirmed'?' <span style="color:var(--warn)">(gap-confirmed)</span>':entry.source==='auto-confirmed'?' <span style="color:var(--accent)">(auto-confirmed)</span>':' (estimated)')+
      '</div>'+
      // Confirmed cache entry (if available)
      (_confDateStr?
        '<div style="background:rgba(0,212,170,0.08);border:1px solid rgba(0,212,170,0.3);border-radius:6px;padding:8px;margin-bottom:10px">'+
          '<div style="font-family:var(--mono);font-size:9px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Confirmed from prior fetch</div>'+
          '<div style="font-family:var(--mono);font-size:13px;font-weight:600;color:var(--text)">'+_confDateStr+_confHourLabel+'</div>'+
          (existingOverride?.date===_confDateStr?
            '<div style="font-family:var(--mono);font-size:9px;color:var(--accent);margin-top:4px">&#x2713; Already matches your override</div>':
            '<button class="btn btn-secondary" style="margin-top:8px;font-size:11px;width:100%" onclick="_acceptConfirmedDate()">&#x2713; Accept this date</button>')+
        '</div>':'')+
      '<div class="input-group" style="margin-bottom:10px">'+
        '<label class="input-label">Actual earnings date (ET)</label>'+
        '<input class="input" type="date" id="earn-override-date" value="'+(existingOverride?.date||entry.date)+'">'+
      '</div>'+
      '<div class="input-group" style="margin-bottom:14px">'+
        '<label class="input-label">Announcement timing (optional)</label>'+
        '<div style="display:flex;gap:6px;margin-top:4px">'+
          '<button id="earn-hour-bmo" class="btn btn-secondary" style="flex:1;font-size:11px;'+(eff.hour==='bmo'?'opacity:1':'opacity:0.4')+'" onclick="_setEarnHourBtn(&quot;bmo&quot;)">BMO</button>'+
          '<button id="earn-hour-amc" class="btn btn-secondary" style="flex:1;font-size:11px;'+(eff.hour==='amc'?'opacity:1':'opacity:0.4')+'" onclick="_setEarnHourBtn(&quot;amc&quot;)">AMC</button>'+
          '<button id="earn-hour-unk" class="btn btn-secondary" style="flex:1;font-size:11px;'+(eff.hour==null?'opacity:1':'opacity:0.4')+'" onclick="_setEarnHourBtn(null)">Unknown</button>'+
        '</div>'+
        '<div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-top:4px">BMO = Before Market Open &nbsp;·&nbsp; AMC = After Market Close</div>'+
      '</div>'+
      (existingOverride?
        '<div style="margin-bottom:10px">'+
          '<button class="btn btn-secondary" style="font-size:10px;color:var(--warn)" onclick="_clearEarningsOverride()">Clear override — revert to estimate</button>'+
        '</div>':'')+
      '<div style="display:flex;gap:8px">'+
        '<button class="btn btn-secondary btn-sm" onclick="_closeEarningsOverrideModal()">Cancel</button>'+
        '<button class="btn btn-primary btn-sm" onclick="_saveEarningsOverride()">Save Override</button>'+
      '</div>'+
    '</div>';

  // Store selected hour in a data attr on the modal for easy retrieval
  el.dataset.hour=(_confHour!=null?_confHour:(eff.hour!=null?eff.hour:''));
  // Pre-fill date input: confirmed > existing override > estimate
  const _preFillDate=existingOverride?.date||_confDateStr||entry.date;
  const _preFillHour=existingOverride?.hour||_confHour||eff.hour;
  const _dateInput=el.querySelector('#earn-override-date');
  if(_dateInput)_dateInput.value=_preFillDate;
  if(_preFillHour){
    setTimeout(()=>_setEarnHourBtn(_preFillHour),50);
  }
  el.classList.add('open');
}

function _acceptConfirmedDate(){
  // Accept the auto-confirmed date and hour as the override
  const ticker=_overrideModalTicker;const idx=_overrideModalIdx;
  if(!ticker||idx==null)return;
  const _confCache=S.get('earnings_confirmed_'+ticker)||[];
  const entries=_getEarningsWithOverrides(ticker);
  const entry=entries[idx];
  if(!entry)return;
  const _confEntry=_confCache.find(c=>Math.abs(new Date(c.date)-new Date(entry.date))<26*86400000);
  if(!_confEntry){toast('No confirmed date found');return;}
  const cache=S.get('earnings_hist_'+ticker);
  if(!cache?.data){_closeEarningsOverrideModal();return;}
  const data=[...cache.data];
  data[idx]={...data[idx],override:{date:_confEntry.date,hour:_confEntry.hour||null,addedTs:nowPT(),acceptedFromConfirmed:true}};
  S.set('earnings_hist_'+ticker,{...cache,data});
  _closeEarningsOverrideModal();
  toast('Confirmed date accepted: '+_confEntry.date+(_confEntry.hour?' '+_confEntry.hour.toUpperCase():''));
  if(currentTicker===ticker)restoreTickerFromCache(ticker);
}

function _setEarnHourBtn(val){
  const el=document.getElementById('earn-override-modal');
  if(!el)return;
  el.dataset.hour=val!=null?val:'';
  ['bmo','amc','unk'].forEach(k=>{
    const btn=document.getElementById('earn-hour-'+k);
    if(btn)btn.style.opacity=(
      (k==='bmo'&&val==='bmo')||(k==='amc'&&val==='amc')||(k==='unk'&&val==null)
    )?'1':'0.4';
  });
}

function _closeEarningsOverrideModal(){
  _overrideModalTicker=null;_overrideModalIdx=null;
  document.getElementById('earn-override-modal')?.classList.remove('open');
}

function _saveEarningsOverride(){
  const ticker=_overrideModalTicker;const idx=_overrideModalIdx;
  if(!ticker||idx==null){_closeEarningsOverrideModal();return;}
  const dateEl=document.getElementById('earn-override-date');
  const el=document.getElementById('earn-override-modal');
  const dateVal=dateEl?.value;
  if(!dateVal){toast('Please enter a date');return;}
  const hourRaw=el?.dataset.hour||'';
  const hour=hourRaw==='bmo'?'bmo':hourRaw==='amc'?'amc':null;

  const cache=S.get('earnings_hist_'+ticker);
  if(!cache?.data){_closeEarningsOverrideModal();return;}
  const data=[...cache.data];
  data[idx]={...data[idx],override:{date:dateVal,hour,addedTs:nowPT()}};
  S.set('earnings_hist_'+ticker,{...cache,data});
  _closeEarningsOverrideModal();
  toast('Earnings date override saved');
  // Re-render ticker to pick up new override
  if(currentTicker===ticker)restoreTickerFromCache(ticker);
}

function _clearEarningsOverride(){
  const ticker=_overrideModalTicker;const idx=_overrideModalIdx;
  if(!ticker||idx==null){_closeEarningsOverrideModal();return;}
  const cache=S.get('earnings_hist_'+ticker);
  if(!cache?.data){_closeEarningsOverrideModal();return;}
  const data=[...cache.data];
  const {override,...rest}=data[idx];
  data[idx]=rest;
  S.set('earnings_hist_'+ticker,{...cache,data});
  _closeEarningsOverrideModal();
  toast('Override cleared — reverted to estimate');
  if(currentTicker===ticker)restoreTickerFromCache(ticker);
}

function _computeEarningsPatternSummary(ticker,hist2y,hist2ySP,earningsHistory){
  if(!earningsHistory?.length||!hist2y?.closes?.length)return null;

  // Build date-keyed price maps for stock and S&P
  const _toDate=d=>d instanceof Date?d:new Date(d*1000);
  const stockMap={},spMap={};
  hist2y.timestamps.forEach((d,i)=>{
    if(hist2y.closes[i]!=null)stockMap[_toDate(d).toISOString().split('T')[0]]=hist2y.closes[i];
  });
  if(hist2ySP){
    hist2ySP.timestamps.forEach((d,i)=>{
      if(hist2ySP.closes[i]!=null)spMap[_toDate(d).toISOString().split('T')[0]]=hist2ySP.closes[i];
    });
  }
  const allDates=Object.keys(stockMap).sort();

  // For each past earnings date, compute moves
  const events=[];
  earningsHistory.forEach(e=>{
    const eDate=e.date;
    if(!eDate||!stockMap[eDate])return;
    const idx=allDates.indexOf(eDate);
    if(idx<5)return; // not enough prior data

    const hour=e.hour||'';
    const isAMC=hour==='amc';

    // Daily return helper: pct change from closeA to closeB
    const dr=(a,b)=>(a&&b&&a>0)?((b-a)/a*100):null;

    // Price lookups around earnings date
    const p_m2=stockMap[allDates[idx-2]]; const sp_m2=spMap[allDates[idx-2]];
    const p_m1=stockMap[allDates[idx-1]]; const sp_m1=spMap[allDates[idx-1]];
    const p_0=stockMap[eDate];            const sp_0=spMap[eDate];
    const p_p1=stockMap[allDates[idx+1]]; const sp_p1=spMap[allDates[idx+1]];
    const p_p2=stockMap[allDates[idx+2]]; const sp_p2=spMap[allDates[idx+2]];

    if(!p_m1)return;

    // ── AMC (announced after close on D) ─────────────────────────────────────
    // Pre-session:  D return   (trading on announcement day before news released)
    // Reaction:     D+1 return (market digests earnings -- primary reaction day)
    // Post:         D+2 return (follow-through)
    //
    // ── BMO (announced before open on D) ─────────────────────────────────────
    // Pre-session:  D-1 return (pre-earnings drift day)
    // Reaction:     D return   (market opens knowing results -- primary reaction day)
    // Post:         D+1 return (follow-through)

    let preDayRet,preDaySPRet,reactionPct,spReactionPct,postDayRet,postDaySPRet;

    if(isAMC){
      preDayRet=dr(p_m1,p_0);    preDaySPRet=dr(sp_m1,sp_0);
      reactionPct=dr(p_0,p_p1);  spReactionPct=dr(sp_0,sp_p1);
      postDayRet=dr(p_p1,p_p2);  postDaySPRet=dr(sp_p1,sp_p2);
    }else{
      // BMO or unknown -- reaction on D
      preDayRet=dr(p_m2,p_m1);   preDaySPRet=dr(sp_m2,sp_m1);
      reactionPct=dr(p_m1,p_0);  spReactionPct=dr(sp_m1,sp_0);
      postDayRet=dr(p_0,p_p1);   postDaySPRet=dr(sp_0,sp_p1);
    }

    const excessReaction=reactionPct!=null&&spReactionPct!=null?reactionPct-spReactionPct:null;
    const excessPre=preDayRet!=null&&preDaySPRet!=null?preDayRet-preDaySPRet:null;
    const excessPost=postDayRet!=null&&postDaySPRet!=null?postDayRet-postDaySPRet:null;

    events.push({
      date:eDate,hour,
      reactionPct,spReactionPct,excessReaction,
      preDayRet,excessPre,
      postDayRet,excessPost,
      beat:e.epsActual!=null&&e.epsEstimate!=null?e.epsActual>e.epsEstimate:null,
      isOverride:e.isOverride||false,
      source:e.source||null
    });
  });

  if(!events.length)return null;

  // Aggregate
  const validReaction=events.filter(e=>e.reactionPct!=null);
  const validExcess=events.filter(e=>e.excessReaction!=null);
  const validPre=events.filter(e=>e.preDayRet!=null);
  const validPost=events.filter(e=>e.postDayRet!=null);

  if(!validReaction.length)return null;

  const avg=arr=>arr.reduce((s,v)=>s+v,0)/arr.length;
  const avgReaction=avg(validReaction.map(e=>e.reactionPct));
  const avgAbsReaction=avg(validReaction.map(e=>Math.abs(e.reactionPct)));
  const avgExcess=validExcess.length?avg(validExcess.map(e=>e.excessReaction)):null;
  const avgPre=validPre.length>=2?avg(validPre.map(e=>e.preDayRet)):null;
  const avgPost=validPost.length>=2?avg(validPost.map(e=>e.postDayRet)):null;
  const upCount=validReaction.filter(e=>e.reactionPct>0).length;
  const n=validReaction.length;

  const fmtPct=v=>(v>=0?'+':'')+v.toFixed(1)+'%';
  const dirText=avgReaction>1?'tends to rally':avgReaction<-1?'tends to fall':'shows mixed reaction';
  const excessText=avgExcess!=null?(avgExcess>1?', outperforming S&P by avg '+fmtPct(avgExcess):avgExcess<-1?', underperforming S&P by avg '+fmtPct(Math.abs(avgExcess)):''):'';
  const preText=avgPre!=null?(avgPre>0.5?' Pre-session typically drifts +'+avgPre.toFixed(1)+'%.':avgPre<-0.5?' Pre-session typically drifts '+avgPre.toFixed(1)+'%.':' Pre-session typically flat.'):'';
  const postText=avgPost!=null?(avgPost>0.5?' Follow-through day avg +'+avgPost.toFixed(1)+'%.':avgPost<-0.5?' Follow-through day avg '+avgPost.toFixed(1)+'%.':''):'';

  // Show all events newest-first in a scrollable area
  const rows=events.slice().reverse().map(e=>{
    const rxCol=e.reactionPct==null?'var(--text3)':e.reactionPct>0?'var(--green)':'var(--red)';
    const preCol=e.preDayRet==null?'var(--text3)':e.preDayRet>0?'var(--green)':'var(--red)';
    const rxStr=e.reactionPct!=null?fmtPct(e.reactionPct):'N/A';
    const exStr=e.excessReaction!=null?' exc '+fmtPct(e.excessReaction):'';
    const preStr=e.preDayRet!=null?fmtPct(e.preDayRet):'';
    const postStr=e.postDayRet!=null?fmtPct(e.postDayRet):'';
    const srcLabel=e.isOverride?'':
      e.source==='gap-confirmed'?'':
      e.source==='auto-confirmed'?'<span style="color:var(--accent);font-size:8px"> auto</span>':
      '<span style="color:var(--text3);font-size:8px"> ~est</span>';
    const hourLabel=e.hour?' '+e.hour.toUpperCase():'';
    return `<div style="font-family:var(--mono);font-size:10px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
      <div style="display:flex;justify-content:space-between">
        <span style="color:var(--text3)">${e.date}${hourLabel}${srcLabel}</span>
        <span style="color:${rxCol};font-weight:600">${rxStr}<span style="font-size:9px;font-weight:400;color:var(--text3)">${exStr}</span></span>
      </div>
      ${preStr||postStr?`<div style="display:flex;gap:16px;padding-left:8px">
        ${preStr?`<span style="color:${preCol};font-size:9px">pre: ${preStr}</span>`:''}
        ${postStr?`<span style="color:var(--text3);font-size:9px">post: ${postStr}</span>`:''}
      </div>`:''}
    </div>`;
  }).join('');

  return `<div style="font-family:var(--mono);font-size:10px;color:var(--text2);line-height:1.6;margin-bottom:8px">
    <strong style="color:var(--text)">${ticker} earnings pattern (${n} events):</strong>
    ${dirText} on reaction day — avg ${fmtPct(avgReaction)} (±${avgAbsReaction.toFixed(1)}% typical)${excessText}. Up ${upCount}/${n} times.${preText}${postText}
  </div>
  <div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-bottom:4px">Reaction day · pre-session · follow-through (&#x25CF;=confirmed, ~est=estimated):</div>
  <div style="max-height:180px;overflow-y:auto;">${rows}</div>
  <div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-top:4px">Based on ${n} quarters of daily price data. BMO=reaction on announcement day, AMC=reaction day after. Small sample — use as context, not prediction.</div>`;
}

function renderRelPerfCard(ticker,hist2y,hist2ySP,earningsHistory){
  const earnToggleOpacity=getRelPerfEarningsToggle()?'1':'0.4';
  // Compute earnings pattern summary
  const earningsWithOvr=_getEarningsWithOverrides(ticker);
  const effectiveHistory=earningsWithOvr.map(e=>({..._effectiveEarningsDate(e),gapPct:e.gapPct,direction:e.direction,_idx:earningsWithOvr.indexOf(e)}));
  const earnSummary=_computeEarningsPatternSummary(ticker,hist2y,hist2ySP,effectiveHistory);

  const _rpSpan=currentRPSpan||'2y';
  const _rpSpanLabel=_rpSpan==='6m'?'6 Months':_rpSpan==='1y'?'1 Year':'2 Years';
  const _rpBtn=(s,lbl)=>'<button class="btn btn-secondary" id="rp-btn-'+s+'" onclick="toggleRPSpan(\''+s+'\')" style="font-size:10px;padding:2px 8px;opacity:'+(s===_rpSpan?'1':'0.4')+'">'+lbl+'</button>';
  const _trActive=getRPTotalReturn();
  const _sp500trAvail=!!S.get('hist2y_sp500tr');
  const _cmpTicker=S.get('rp_compare_'+ticker)||'';
  return `<div class="card">
    <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
      <span id="rp-title-span"><span class="dot" style="background:var(--accent)"></span>Relative Performance vs S&P 500 (${_rpSpanLabel})</span>
      <button id="rp-earn-btn" class="btn btn-secondary" style="font-size:10px;padding:2px 8px;opacity:${earnToggleOpacity}" onclick="toggleRelPerfEarnings()">Earnings</button>
    </div>
    <div style="display:flex;gap:4px;margin-bottom:4px">
      ${_rpBtn('6m','6M')+_rpBtn('1y','1Y')+_rpBtn('2y','2Y')}
    </div>
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;width:100%">
      <button id="rp-tr-btn" onclick="toggleRPTotalReturn()" style="font-family:var(--mono);font-size:10px;padding:2px 8px;opacity:${_trActive?'1':'0.4'};white-space:nowrap;flex-shrink:0;background:var(--surface3);color:var(--text);border:1px solid var(--border);border-radius:var(--radius);cursor:pointer" title="${_sp500trAvail?'Toggle total return (dividends reinvested)':'Total return data loads on next refresh'}">Total Return</button>
      <button id="rp-cmp-btn" onclick="_openRPCompareMenu(this)" style="font-family:var(--mono);font-size:10px;background:var(--surface2);color:var(--text2);border:1px solid var(--border);border-radius:4px;padding:2px 8px;flex:1;width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer">${_cmpTicker?'Compare: '+_cmpTicker+' ▾':'+ Compare ▾'}</button>
    </div>
    <div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-bottom:6px" id="rp-subtitle">Both lines indexed to 100 at start of window. Stock line above S&amp;P line = outperforming.${_trActive?' Dividends reinvested (total return).':''}</div>
    <div class="chart-wrap" style="height:200px"><canvas id="rp-chart"></canvas></div>
    <div id="rp-legend" style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px">
      <div style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:2px;background:var(--accent)"></span><span data-rp-label="ticker" style="font-family:var(--mono);font-size:9px;color:var(--text3)">${ticker}${_trActive?' (TR)':''}</span></div>
      <div style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:2px;background:#8b8fa8"></span><span data-rp-label="sp500" style="font-family:var(--mono);font-size:9px;color:var(--text3)">S&P 500${_trActive?' (TR)':''}</span></div>
      <div id="rp-cmp-legend" style="display:${_cmpTicker?'flex':'none'};align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:2px;background:#ffd32a"></span><span data-rp-label="compare" style="font-family:var(--mono);font-size:9px;color:var(--text3)">${_cmpTicker}${_trActive?' (TR)':''}</span></div>
      ${earningsWithOvr?.length?'<div style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:2px;height:12px;background:rgba(255,165,2,0.75)"></span><span style="font-family:var(--mono);font-size:9px;color:var(--text3)">Solid=confirmed · Dashed=estimated · Teal=overridden</span></div>':''}
    </div>
    ${earnSummary?`<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:8px">${earnSummary}</div>`:''}
    ${earningsWithOvr.length?`<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">
      <div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-bottom:6px">EARNINGS DATES — tap to override any estimated date with the actual date</div>
      <div style="max-height:200px;overflow-y:auto">
        ${earningsWithOvr.slice().reverse().map((e,ri)=>{
          const idx=earningsWithOvr.length-1-ri;
          const eff=_effectiveEarningsDate(e);
          const hasOvr=!!e.override;
          const srcLabel=hasOvr?'<span style="color:var(--accent);font-size:8px">overridden</span>':
            e.source==='gap-confirmed'?'<span style="color:var(--warn);font-size:8px">gap-confirmed</span>':
            e.source==='auto-confirmed'?'<span style="color:var(--accent);font-size:8px">auto-confirmed</span>':
            '<span style="color:var(--text3);font-size:8px">estimated</span>';
          const hourLabel=eff.hour==='bmo'?' BMO':eff.hour==='amc'?' AMC':'';
          const estRef=hasOvr?'<span style="color:var(--text3);font-size:8px;text-decoration:line-through">'+e.date+'</span> ':'';
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04)">'+
            '<div style="font-family:var(--mono);font-size:10px">'+
              estRef+'<span style="color:'+(hasOvr?'var(--accent)':'var(--text2)')+'">'+eff.date+hourLabel+'</span> '+srcLabel+
            '</div>'+
            '<button onclick="openEarningsOverrideModal(&quot;'+ticker+'&quot;,'+idx+')" style="font-family:var(--mono);font-size:9px;background:none;border:1px solid var(--border);border-radius:4px;color:var(--text3);padding:2px 6px;cursor:pointer">'+
              (hasOvr?'Edit':'Override')+
            '</button>'+
          '</div>';
        }).join('')}
      </div>
    </div>`:''}
  </div>`;
}

function renderRelPerfChart(ticker,hist2y,hist2ySP,earningsHistory,span,cmpSeries){
  const ctx=document.getElementById('rp-chart')?.getContext('2d');
  if(!ctx)return;

  // Compute cutoff date from span param (default 2Y)
  const _span=span||currentRPSpan||'2y';
  const cutoffDays=_span==='6m'?183:_span==='1y'?365:730;
  const cutoff=new Date(Date.now()-cutoffDays*86400000);

  // Align series by date -- find common date range
  const _toDateStr=d=>{
    if(d instanceof Date)return d.toISOString().split('T')[0];
    return new Date(d*1000).toISOString().split('T')[0];
  };
  const stockDates=hist2y.timestamps
    .map((d,i)=>({d:_toDateStr(d),i}))
    .filter(({d})=>new Date(d+'T00:00:00Z')>=cutoff)
    .map(({d})=>d);
  const spDates=hist2ySP.timestamps
    .map((d,i)=>({d:_toDateStr(d),i}))
    .filter(({d})=>new Date(d+'T00:00:00Z')>=cutoff)
    .map(({d})=>d);
  const _stockFiltered=hist2y.timestamps
    .map((d,i)=>({d:_toDateStr(d),c:hist2y.closes[i]}))
    .filter(({d})=>new Date(d+'T00:00:00Z')>=cutoff);
  const _spFiltered=hist2ySP.timestamps
    .map((d,i)=>({d:_toDateStr(d),c:hist2ySP.closes[i]}))
    .filter(({d})=>new Date(d+'T00:00:00Z')>=cutoff);

  const stockMap={};_stockFiltered.forEach(({d,c})=>{if(c!=null)stockMap[d]=c;});
  const spMap={};_spFiltered.forEach(({d,c})=>{if(c!=null)spMap[d]=c;});

  // Build comparison ticker map if provided
  let cmpMap=null;
  if(cmpSeries&&cmpSeries.timestamps&&cmpSeries.closes){
    cmpMap={};
    cmpSeries.timestamps
      .map((d,i)=>({d:_toDateStr(d),c:cmpSeries.closes[i]}))
      .filter(({d})=>new Date(d+'T00:00:00Z')>=cutoff)
      .forEach(({d,c})=>{if(c!=null)cmpMap[d]=c;});
  }

  const _spanDays={'6m':183,'1y':365,'2y':730}[span||'2y']||730;
  const _cutoff=new Date(Date.now()-_spanDays*86400000).toISOString().split('T')[0];

  // Common dates: stock + S&P required; comparison allowed to have gaps
  const commonDates=stockDates.filter(d=>stockMap[d]!=null&&spMap[d]!=null&&d>=_cutoff).sort();
  if(commonDates.length<10)return;

  const base=commonDates[0];
  const stockBase=stockMap[base];
  const spBase=spMap[base];
  // For comparison, find first date where both stock and comparison have data
  const cmpBase=cmpMap?commonDates.find(d=>cmpMap[d]!=null):null;
  const cmpBaseVal=cmpBase?cmpMap[cmpBase]:null;

  const stockNorm=commonDates.map(d=>Math.round(stockMap[d]/stockBase*10000)/100);
  const spNorm=commonDates.map(d=>Math.round(spMap[d]/spBase*10000)/100);
  // Comparison: normalize to 100 at same base date as stock; null where data missing
  const cmpNorm=cmpMap&&cmpBaseVal
    ?commonDates.map(d=>cmpMap[d]!=null?Math.round(cmpMap[d]/cmpBaseVal*10000)/100:null)
    :null;

  const labels=commonDates.map(d=>{
    const dt=new Date(d+'T12:00:00Z');
    return dt.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  });

  // Earnings vertical line annotations
  const showEarnings=getRelPerfEarningsToggle();
  // Build effective earnings map using overrides where available
  const earningsDateMap=new Map();
  if(showEarnings&&earningsHistory?.length){
    const _withOvr=_getEarningsWithOverrides(ticker);
    (_withOvr.length?_withOvr:earningsHistory).forEach(e=>{
      const eff=_withOvr.length?_effectiveEarningsDate(e):e;
      if(eff.date)earningsDateMap.set(eff.date,eff);
    });
  }

  if(window._rpChart)window._rpChart.destroy();

  // Custom plugin for vertical earnings lines and baseline
  const earningsPlugin={
    id:'rpAnnotations',
    afterDraw(chart){
      const c=chart.ctx,xs=chart.scales.x,ys=chart.scales.y;
      // Baseline at 100
      const y100=ys.getPixelForValue(100);
      c.save();
      c.setLineDash([4,3]);
      c.lineWidth=1;
      c.strokeStyle='rgba(255,255,255,0.15)';
      c.beginPath();c.moveTo(xs.left,y100);c.lineTo(xs.right,y100);c.stroke();
      c.setLineDash([]);
      // Earnings vertical lines: solid amber = gap-confirmed, dashed = estimated
      if(earningsDateMap.size>0){
        commonDates.forEach((d,i)=>{
          if(!earningsDateMap.has(d))return;
          const ev=earningsDateMap.get(d);
          const xPx=xs.getPixelForValue(i);
          const isOverride=!!ev.isOverride;
          const confirmed=ev.source==='gap-confirmed'||ev.source==='auto-confirmed'||(ev.gapPct!=null&&ev.gapPct>=3);
          c.strokeStyle=isOverride?'rgba(0,212,170,0.85)':confirmed?'rgba(255,165,2,0.75)':'rgba(255,165,2,0.35)';
          c.lineWidth=isOverride?2:confirmed?1.5:1;
          c.setLineDash(isOverride?[]:(confirmed?[]:[3,3]));
          c.beginPath();c.moveTo(xPx,ys.top);c.lineTo(xPx,ys.bottom);c.stroke();
          c.setLineDash([]);
        });
      }
      c.restore();
    }
  };

  window._rpChart=new Chart(ctx,{
    type:'line',
    data:{
      labels,
      datasets:[
        {label:ticker,data:stockNorm,borderColor:'#00d4aa',borderWidth:2,pointRadius:0,tension:0.2,fill:false},
        {label:'S&P 500',data:spNorm,borderColor:'#8b8fa8',borderWidth:1.5,pointRadius:0,tension:0.2,fill:false,borderDash:[3,2]},
        ...(cmpNorm?[{label:cmpSeries.ticker,data:cmpNorm,borderColor:'#ffd32a',borderWidth:1.5,pointRadius:0,tension:0.2,fill:false,spanGaps:false}]:[])
      ]
    },
    options:{
      responsive:true,maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{display:false},
        tooltip:{
          callbacks:{
            label:ctx=>`${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} (${(ctx.parsed.y-100).toFixed(1)}%)`
          }
        }
      },
      scales:{
        x:{ticks:{color:'#555870',font:{size:9},maxTicksLimit:8},grid:{color:'#2a2e38'}},
        y:{ticks:{color:'#555870',font:{size:9},callback:v=>v.toFixed(0)},grid:{color:'#2a2e38'}}
      }
    },
    plugins:[earningsPlugin]
  });
}

function _initRelPerfChart(ticker,hist2y,hist2ySP,earningsHistory,span){
  if(!hist2y||!hist2ySP)return;
  // Load comparison series from cache if a comparison ticker is saved
  const cmpTicker=S.get('rp_compare_'+ticker)||'';
  let cmpData=null;
  if(cmpTicker){
    const cmpC=S.get('hist2y_'+cmpTicker);
    if(cmpC&&cmpC.closes&&cmpC.closes.length>=2){
      const useTR=getRPTotalReturn();
      const cmpCloses=useTR&&cmpC.adjcloses?cmpC.adjcloses:cmpC.closes;
      cmpData={ticker:cmpTicker,timestamps:cmpC.timestamps,closes:cmpCloses};
    }
  }
  renderRelPerfChart(ticker,hist2y,hist2ySP,earningsHistory,span||'2y',cmpData);
}

function renderVolChart(hist6m,hist1y,hist2y,span,avgVol20){
  const ctx=document.getElementById('vol-chart')?.getContext('2d');
  if(!ctx)return;

  // Select the right data source based on span
  let vols=null,labels=null;
  if(span==='2y'&&hist2y?.volumes?.length){
    vols=hist2y.volumes;
    labels=hist2y.timestamps.map(d=>{
      if(!(d instanceof Date))d=new Date(d*1000);
      return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    });
  }else if(span==='1y'&&hist1y?.volumes?.length){
    vols=hist1y.volumes;
    labels=hist1y.timestamps.map(d=>{
      if(!(d instanceof Date))d=new Date(d);
      return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    });
  }else if(hist6m?.volumes?.length){
    // 6M -- use last 126 bars
    vols=hist6m.volumes.slice(-126);
    labels=hist6m.timestamps.slice(-126).map(d=>{
      // timestamps may be Date objects (live fetch) or Unix seconds (from cache)
      if(d instanceof Date)return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
      const ms=typeof d==='number'&&d<1e10?d*1000:d; // seconds vs ms detection
      return new Date(ms).toLocaleDateString('en-US',{month:'short',day:'numeric'});
    });
  }
  if(!vols||!vols.length)return;

  // Compute 20-day rolling average for overlay
  const avgLine=vols.map((_,i)=>{
    if(i<1)return null;
    const win=vols.slice(Math.max(0,i-19),i+1).filter(v=>v>0);
    return win.length?win.reduce((s,v)=>s+v,0)/win.length:null;
  });

  // Color bars: high volume (>1.5× avg) = teal accent, normal = muted
  const volThreshold=avgVol20||avgLine[avgLine.length-1]||0;
  const barColors=vols.map((v,i)=>{
    const localAvg=avgLine[i]||volThreshold;
    return v>localAvg*1.5?'rgba(0,212,170,0.7)':'rgba(139,143,168,0.35)';
  });

  if(window._volChart)window._volChart.destroy();
  window._volChart=new Chart(ctx,{
    type:'bar',
    data:{
      labels,
      datasets:[
        {label:'Volume',data:vols,backgroundColor:barColors,borderWidth:0,barPercentage:0.8,categoryPercentage:1},
        {label:'20D Avg',data:avgLine,type:'line',borderColor:'rgba(255,165,2,0.6)',borderWidth:1.5,pointRadius:0,tension:0.2,fill:false}
      ]
    },
    options:{
      responsive:true,maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{display:false},
        tooltip:{callbacks:{
          label:c=>c.dataset.label+': '+fmtVol(c.parsed.y)
        }}
      },
      scales:{
        x:{ticks:{color:'#555870',font:{size:8},maxTicksLimit:6},grid:{display:false}},
        y:{ticks:{color:'#555870',font:{size:8},callback:v=>fmtVol(v)},grid:{color:'#2a2e38'}}
      }
    }
  });
}

function renderHVRChart(ticker,span){
  const ctx=document.getElementById('hvr-chart')?.getContext('2d');
  if(!ctx)return;
  if(window._hvrChart){window._hvrChart.destroy();window._hvrChart=null;}

  const series=computeHVRSeries(ticker);
  if(!series||!series.values.length)return;

  // Slice to match span
  const n=span==='2y'?series.values.length:span==='1y'?252:126;
  const start=Math.max(0,series.values.length-n);
  const vals=series.values.slice(start);
  const tss=series.timestamps.slice(start);

  if(!vals.length)return;

  const labels=tss.map(d=>{
    const ms=typeof d==='number'&&d<1e10?d*1000:d;
    return new Date(ms).toLocaleDateString('en-US',{month:'short',day:'numeric'});
  });

  // Color each point by zone
  const pointColors=vals.map(v=>v>=70?'rgba(255,82,82,0.8)':v>=50?'rgba(255,165,2,0.8)':v>=30?'rgba(255,165,2,0.4)':'rgba(0,212,170,0.6)');

  // Zone fill plugin -- colored background bands
  const zoneFillPlugin={
    id:'hvrZones',
    beforeDraw(chart){
      const{ctx:c,chartArea:{top,bottom,left,right},scales:{y}}=chart;
      const zones=[
        {from:70,to:100,color:'rgba(255,82,82,0.08)'},
        {from:50,to:70,color:'rgba(255,165,2,0.07)'},
        {from:30,to:50,color:'rgba(255,165,2,0.04)'},
        {from:0,to:30,color:'rgba(0,212,170,0.07)'},
      ];
      zones.forEach(z=>{
        const yTop=y.getPixelForValue(z.to);
        const yBot=y.getPixelForValue(z.from);
        c.fillStyle=z.color;
        c.fillRect(left,yTop,right-left,yBot-yTop);
      });
    }
  };

  window._hvrChart=new Chart(ctx,{
    type:'line',
    plugins:[zoneFillPlugin],
    data:{
      labels,
      datasets:[{
        label:'HVR',
        data:vals,
        borderColor:'rgba(139,143,168,0.9)',
        borderWidth:1.5,
        pointRadius:0,
        tension:0.2,
        fill:false,
        segment:{borderColor:ctx2=>vals[ctx2.p1DataIndex]>=70?'rgba(255,82,82,0.9)':vals[ctx2.p1DataIndex]>=50?'rgba(255,165,2,0.9)':'rgba(139,143,168,0.7)'}
      }]
    },
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{
        legend:{display:false},
        tooltip:{callbacks:{label:c=>'HVR: '+c.parsed.y}}
      },
      scales:{
        x:{ticks:{color:'#555870',font:{size:8},maxTicksLimit:6},grid:{display:false}},
        y:{
          min:0,max:100,
          ticks:{color:'#555870',font:{size:8},stepSize:25,callback:v=>v===0||v===50||v===100?v:''},
          grid:{color:'rgba(255,255,255,0.05)'}
        }
      }
    }
  });
}

function renderVPChart(hist1y,currentPrice,w52h,w52l){
  const closes=hist1y.closes.filter(c=>c!==null);
  const volumes=hist1y.volumes.filter((_,i)=>hist1y.closes[i]!==null);
  const{levels:vpLevels,centers,vols:bucketVols}=computeVolumeProfile(closes,volumes,40,5);
  const roundNums=getRoundNumbers(currentPrice);
  const ma50=closes.map((_,i)=>i<49?null:avg(closes.slice(i-49,i+1)));
  const ma200=closes.map((_,i)=>i<199?null:avg(closes.slice(i-199,i+1)));
  const labels=hist1y.timestamps.map(d=>{
    if(!(d instanceof Date))d=new Date(d);
    return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  });
  const topVpIdxs=new Set(vpLevels.map(l=>
    centers.reduce((bi,c,i)=>Math.abs(c-l)<Math.abs(centers[bi]-l)?i:bi,0)
  ));
  const maxVol=Math.max(...bucketVols);

  const ctx=document.getElementById('vp-chart')?.getContext('2d');
  if(!ctx)return;
  if(window._vpChart)window._vpChart.destroy();
  if(window._vpVolChart){window._vpVolChart.destroy();window._vpVolChart=null;}

  window._vpChart=new Chart(ctx,{
    type:'line',
    data:{labels,datasets:[
      {data:closes,borderColor:'#4fc3f7',borderWidth:1.5,pointRadius:0,tension:0.2,fill:false},
      {data:ma50,borderColor:'#ff9800',borderWidth:1,pointRadius:0,borderDash:[4,3],fill:false},
      {data:ma200,borderColor:'#7c6af7',borderWidth:1,pointRadius:0,borderDash:[4,3],fill:false}
    ]},
    options:{
      responsive:true,maintainAspectRatio:false,
      // Reserve right side for VP bar overlay + labels
      layout:{padding:{top:14,right:10,left:0,bottom:0}},
      plugins:{legend:{display:false}},
      scales:{
        x:{ticks:{color:'#555870',font:{size:9},maxTicksLimit:6},grid:{color:'#2a2e38'}},
        y:{ticks:{color:'#555870',font:{size:9}},grid:{color:'#2a2e38'}}
      }
    },
    plugins:[{
      id:'vpOverlay',
      afterDraw(chart){
        const c=chart.ctx,xA=chart.scales.x,yA=chart.scales.y;
        const xL=xA.left,xR=xA.right,yT=yA.top,yB=yA.bottom;
        const chartW=xR-xL;
        // VP bars drawn in right 22% of chart area so they don't obscure price data
        const vpBarMaxW=chartW*0.22;
        const vpBarX=xR-vpBarMaxW; // left edge of VP bar zone

        function clampY(y,pad=9){return Math.max(yT+pad,Math.min(yB-pad,y));}
        c.save();

        // ── Draw VP volume bars (aligned to price axis) ──
        // Each bucket is drawn as a horizontal rectangle at the exact pixel
        // position of its center price using yA.getPixelForValue().
        // This guarantees perfect alignment with the left price chart.
        const nBuckets=centers.length;
        if(nBuckets>0&&maxVol>0){
          // Bucket pixel height: distance between adjacent centers in pixels
          const bucketH=nBuckets>1
            ?Math.abs(yA.getPixelForValue(centers[1])-yA.getPixelForValue(centers[0]))
            :8;
          centers.forEach((price,i)=>{
            if(price<yA.min||price>yA.max)return;
            const barW=(bucketVols[i]/maxVol)*vpBarMaxW;
            const barY=yA.getPixelForValue(price)-bucketH/2;
            const isTop=topVpIdxs.has(i);
            c.fillStyle=isTop?'rgba(0,212,170,0.55)':'rgba(60,90,100,0.35)';
            c.fillRect(vpBarX,barY,barW,Math.max(bucketH-1,1));
          });
          // Thin vertical separator line between price chart and VP bars
          c.strokeStyle='rgba(42,46,56,0.8)';c.lineWidth=1;c.setLineDash([]);
          c.beginPath();c.moveTo(vpBarX,yT);c.lineTo(vpBarX,yB);c.stroke();
          // "VOL" label at top of VP bar zone
          c.font='8px DM Mono,monospace';c.fillStyle='rgba(85,88,112,0.9)';
          c.textAlign='center';c.fillText('VOL',vpBarX+vpBarMaxW/2,yT+9);
        }

        // ── VP level lines + labels ──
        c.font='bold 9px DM Mono,monospace';c.textAlign='left';
        vpLevels.forEach(lvl=>{
          if(lvl<yA.min||lvl>yA.max)return;
          const y=yA.getPixelForValue(lvl);
          c.setLineDash([4,4]);c.lineWidth=1.5;c.strokeStyle='rgba(0,212,170,0.8)';
          c.beginPath();c.moveTo(xL,y);c.lineTo(vpBarX-2,y);c.stroke();c.setLineDash([]);
          c.fillStyle='rgba(0,212,170,0.9)';
          c.fillText('S/R $'+lvl.toFixed(0),xL+2,clampY(y-3));
        });

        // ── 52W high/low ──
        if(w52h&&w52h>=yA.min&&w52h<=yA.max){
          const y=yA.getPixelForValue(w52h);
          c.setLineDash([6,3]);c.lineWidth=1.2;c.strokeStyle='rgba(255,71,87,0.7)';
          c.beginPath();c.moveTo(xL,y);c.lineTo(vpBarX-2,y);c.stroke();c.setLineDash([]);
          c.fillStyle='rgba(255,71,87,0.9)';c.font='bold 9px DM Mono,monospace';
          c.fillText('52H $'+w52h.toFixed(0),xL+2,clampY(y-3));
        }
        if(w52l&&w52l>=yA.min&&w52l<=yA.max){
          const y=yA.getPixelForValue(w52l);
          c.setLineDash([6,3]);c.lineWidth=1.2;c.strokeStyle='rgba(0,200,150,0.7)';
          c.beginPath();c.moveTo(xL,y);c.lineTo(vpBarX-2,y);c.stroke();c.setLineDash([]);
          c.fillStyle='rgba(0,200,150,0.9)';c.font='bold 9px DM Mono,monospace';
          c.fillText('52L $'+w52l.toFixed(0),xL+2,clampY(y+10));
        }

        // ── Round numbers (subtle) ──
        c.setLineDash([2,4]);c.lineWidth=0.8;c.strokeStyle='rgba(100,100,120,0.4)';
        roundNums.forEach(rn=>{
          if(rn<yA.min||rn>yA.max)return;
          const y=yA.getPixelForValue(rn);
          c.beginPath();c.moveTo(xL,y);c.lineTo(vpBarX-2,y);c.stroke();
        });
        c.setLineDash([]);

        // ── Current price line (solid blue, clamped label) ──
        if(currentPrice>=yA.min&&currentPrice<=yA.max){
          const y=yA.getPixelForValue(currentPrice);
          c.lineWidth=2;c.strokeStyle='#4fc3f7';
          c.beginPath();c.moveTo(xL,y);c.lineTo(vpBarX-2,y);c.stroke();
          // Label on left side, clamped inside chart
          c.font='bold 9px DM Mono,monospace';c.fillStyle='#4fc3f7';c.textAlign='left';
          c.fillText('NOW $'+currentPrice.toFixed(2),xL+2,clampY(y-3));
        }

        c.restore();
      }
    }]
  });
  const vpBelow=vpLevels.filter(l=>l<=currentPrice);const vpAbove=vpLevels.filter(l=>l>currentPrice);
  const ns=vpBelow.length?Math.max(...vpBelow):null;const nr=vpAbove.length?Math.min(...vpAbove):null;
  let analysis='Volume Profile shows where the most shares traded over the past year. High-volume zones act as support (from above) and resistance (from below).\n';
  if(ns){const pct=((currentPrice-ns)/currentPrice*100).toFixed(1);analysis+=`\nNearest VP support: $${ns.toFixed(0)} (${pct}% below). Selling puts above this level aligns with natural market maker buying.\n`;}
  if(nr){const pct=((nr-currentPrice)/currentPrice*100).toFixed(1);analysis+=`\nNearest VP resistance: $${nr.toFixed(0)} (${pct}% above). For covered calls, selling just below this uses natural resistance as a buffer.\n`;}
  analysis+='\nBlue line = current price. Teal = VP levels. Orange dashed = 50d MA. Purple dashed = 200d MA.\nRight panel: horizontal volume bars. Teal = highest-volume zones (strongest S/R).';
  const vpEl=document.getElementById('vp-analysis');if(vpEl)vpEl.innerHTML=`<div class="commentary" style="margin-top:8px">${analysis}</div>`;
}

async function refreshSingleTicker(){
  const t=document.getElementById('ticker-select').value;
  if(!t){toast('Select a ticker first');return;}
  if(!navigator.onLine&&!offlineMode){toast('Offline -- cached data unchanged',3000);return;}
  if(offlineMode){toast('Offline mode -- disable in Settings to fetch',3000);return;}
  if(!FINNHUB_KEY){toast('Add Finnhub key in Settings');return;}
  const btn=document.getElementById('single-refresh-btn');
  const bar=document.getElementById('single-refresh-bar');
  const label=document.getElementById('single-refresh-label');
  const prog=document.getElementById('single-refresh-progress');
  btn.disabled=true;prog.style.display='block';
  const setP=(pct,msg)=>{bar.style.width=pct+'%';label.textContent=msg;};
  try{
    // Step 1: Core ticker data
    setP(10,'Fetching '+t+' quote & metrics...');
    const _rConfCount=(S.get('earnings_confirmed_'+t)||[]).length;
    const _rNeedEarningsHist=_rConfCount<4;
    // Finnhub: only earnings calendar + news/upgrades/recs. All price/fundamentals from Yahoo.
    const[earnings,earningsHist]=await Promise.all([
      fh(`/calendar/earnings?symbol=${t}&from=${fmtDate(addDays(new Date(),-740))}&to=${fmtDate(addDays(new Date(),180))}`),
      _rNeedEarningsHist?fh(`/stock/earnings?symbol=${t}&limit=8`):Promise.resolve(null)
    ]);
    let rec=null,upgrades=null,priceTargetS=null;
    try{rec=await fh(`/stock/recommendation?symbol=${t}`);}catch{}
    try{upgrades=await fh(`/stock/upgrade-downgrade?symbol=${t}&from=${fmtDate(addDays(new Date(),-90))}`);}catch{}
    // Build snap from Yahoo /quote
    setP(20,'Fetching '+t+' Yahoo quote...');
    const ah=await fetchAfterHoursPrice(t);
    if(!ah||!ah.price)throw new Error('Yahoo quote failed for '+t);
    const _rPrice=ah.price,_rPrev=ah.prevClose||ah.price;
    const futE=(earnings?.earningsCalendar||[]).filter(e=>e.date>=fmtDate(new Date())).sort((a,b)=>a.date.localeCompare(b.date));
    const snap={
      ticker:t,name:ah.name||t,
      price:_rPrice,prevClose:_rPrev,
      change:_rPrice-_rPrev,changePct:((_rPrice-_rPrev)/_rPrev*100),
      high:ah.high||null,low:ah.low||null,
      marketCap:ah.marketCap||null,
      peRatio:ah.peRatio||null,
      peForward:ah.forwardPE||null,
      epsTTM:ah.trailingEps||null,
      dividendYield:ah.dividendYield!=null?ah.dividendYield*100:null,
      marketState:ah.marketState||null,
      intradayVolume:ah.intradayVolume||null,
      postMarketPrice:ah.postMarketPrice||null,
      postMarketChange:ah.postMarketChange||null,
      postMarketChangePct:ah.postMarketChangePct||null,
      earningsDate:futE[0]?.date||null,earningsHour:futE[0]?.hour||null,
      ts:nowPT(),tsEpoch:Date.now(),isLive:true
    };
    // Save pending earnings date + promote passed dates to confirmed
    try{
      promoteEarningsPending(t);
      const _rFutE=(earnings?.earningsCalendar||[])
        .filter(e=>e.date>=fmtDate(new Date())).sort((a,b)=>a.date.localeCompare(b.date));
      if(_rFutE[0]?.date)saveEarningsPending(t,_rFutE[0].date,_rFutE[0].hour||null);
      // Supplement from calendar past entries
      const _rConf=S.get('earnings_confirmed_'+t)||[];
      const _rCut=new Date();_rCut.setDate(_rCut.getDate()-_EARN_EVICT_DAYS);
      let _rChg=false;
      [...(earnings?.earningsCalendar||[]).filter(e=>e.date&&e.date<fmtDate(new Date())),
       ...(earningsHist||[]).filter(e=>e.date&&new Date(e.date)<new Date())].forEach(e=>{
        if(new Date(e.date)<_rCut)return;
        if(!_rConf.some(c=>Math.abs(new Date(c.date)-new Date(e.date))<4*86400000)){
          _rConf.push({date:e.date,hour:e.hour||null,addedTs:nowPT()});_rChg=true;
        }
      });
      if(_rChg)S.set('earnings_confirmed_'+t,_rConf.filter(c=>new Date(c.date)>=_rCut));
    }catch{}
    // Step 2: Yahoo quoteSummary (beta, short interest, R40 inputs, price targets, trends)
    setP(20,'Fetching '+t+' extended data...');
      try{const qs=await fetchQuoteSummary(t);if(qs){
        if(qs.beta!=null)snap.beta=qs.beta;
        if(qs.ptMean){snap.ptMean=qs.ptMean;snap.ptHigh=qs.ptHigh||null;snap.ptLow=qs.ptLow||null;snap.ptAnalysts=qs.ptAnalysts||null;}
        if(qs.pegRatio!=null)snap.pegRatio=qs.pegRatio;
        if(qs.evToEbitda!=null)snap.evToEbitda=qs.evToEbitda;
        if(qs.shortPctFloat!=null){snap.shortPctFloat=qs.shortPctFloat;snap.shortRatioYahoo=qs.shortRatioYahoo;}
        if(qs.earningsTrend&&qs.earningsTrend.length)snap.earningsTrend=qs.earningsTrend;
        if(qs.recTrend&&qs.recTrend.length)snap.recTrend=qs.recTrend;
        if(qs.revenueGrowthYahoo!=null)snap.revenueGrowthYahoo=qs.revenueGrowthYahoo;
        if(qs.operatingMarginsYahoo!=null)snap.operatingMarginsYahoo=qs.operatingMarginsYahoo;
        if(qs.freeCashflowYahoo!=null&&qs.totalRevenueYahoo!=null&&qs.totalRevenueYahoo!==0)
          snap.fcfMarginYahoo=qs.freeCashflowYahoo/qs.totalRevenueYahoo;
      }}catch{}
      if(priceTargetS&&priceTargetS.targetMean){snap.ptMean=priceTargetS.targetMean||null;snap.ptHigh=priceTargetS.targetHigh||null;snap.ptLow=priceTargetS.targetLow||null;}
    S.set('snap_'+t,snap);
    S.set('rec_'+t,{data:rec&&rec.length?rec[0]:null,ts:nowPT()});
    S.set('upgrades_'+t,{data:upgrades&&upgrades.length?upgrades.slice(0,6):[],ts:nowPT()});
    // Step 3: Price history
    setP(35,'Fetching '+t+' price history...');
    // Single 2Y fetch populates all three history cache keys; intraday in parallel
    try{
      const [_rh2,_idRes]=await Promise.all([
        _tkTimeout(yahooHistory(t,'2y','1d'),15000,'hist2y'),
        _tkTimeout(yahooHistory(t,'1d','5m'),10000,'intraday').catch(e=>{console.warn('intraday failed:',t,e?.message);return null;})
      ]);
      const _rts=_rh2.timestamps.map(d=>Math.floor(d.getTime()/1000));
      const _rcl=_rh2.closes.map(v=>v!=null?Math.round(v*100)/100:null);
      const _rvl=_rh2.volumes?_rh2.volumes.map(v=>v||0):null;
      const _rac=_rh2.adjcloses?_rh2.adjcloses.map(v=>v!=null?Math.round(v*100)/100:null):null;
      const _rn=nowPT();
      S.set('hist2y_'+t,{timestamps:_rts,closes:_rcl,volumes:_rvl,adjcloses:_rac,ts:_rn});
      if(_idRes&&_idRes.closes&&_idRes.closes.length>=2){
        const _idTs=_idRes.timestamps?_idRes.timestamps.map(d=>d instanceof Date?d.getTime():d):null;
        S.set('intraday_'+t,{closes:_idRes.closes,timestamps:_idTs,ts:_rn});
      }
    }catch(e){console.warn('refreshSingle hist2y failed:',t,e?.message);}
    // Step 4: News
    setP(50,'Fetching '+t+' news...');
    try{const newsData=await fetchNews(t);S.set('news_'+t,{items:(newsData||[]).slice(0,10).map(n=>({headline:n.headline,summary:n.summary?n.summary.slice(0,200):null,url:n.url,source:n.source,datetime:n.datetime,sentiment:n.sentiment})),ts:nowPT()});}catch{}
    // Step 5: Options chain top-level
    setP(65,'Fetching '+t+' options chain...');
    let optionsLoaded=false;
    // Manual refresh always fetches options -- user explicitly requested fresh data.
    // Validation still guards against writing synthetic/zeroed data over good cache.
    const _rtInWindow=_isOptionsLiveWindow();
    {
      try{
        const opts=await _tkTimeout(yahooOptionsViaProxy(t),15000,'options');
        // Validate before writing -- reject synthetic/zeroed post-cutoff data
        const _rtv=_validateOptionsData(opts);
        if(_rtv.valid){
          S.set('options_'+t,{data:slimOptionsData(opts),ts:nowPT()});
        }else if(!S.get('options_'+t)){
          S.set('options_'+t,{data:slimOptionsData(opts),ts:nowPT(),synthetic:true});
        }
        // else preserve existing good cache
        // Only fetch per-expiry chains if main chain fetch was valid AND we're in live window
        // Outside live window: use _shouldSkipOptionsFetch to correctly honor
        // "Friday cache is still good on Monday pre-market" without re-fetching synthetic data
        const _savedOpts=S.get('options_'+t);
        if(_savedOpts){
          const yr=opts?.optionChain?.result?.[0];
          const rawTs=yr?.expirationDates||[];
          const pairs=rawTs.map(ts=>({ts,date:new Date(ts*1000).toISOString().split('T')[0]}));
          let monthlyPairs=pairs.filter(p=>{const d=new Date(p.date+'T12:00:00Z');return(d.getUTCDay()===5||d.getUTCDay()===4)&&d.getUTCDate()>=15&&d.getUTCDate()<=21;}).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);
          if(monthlyPairs.length===0){const tw=Date.now()+14*86400000;monthlyPairs=pairs.filter(p=>p.ts*1000>=tw).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);}
          if(monthlyPairs.length===0)monthlyPairs=pairs.sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);
          // Step 6: Per-expiration chains (parallel) -- always attempt fetch,
          // validate-first logic mirrors v133 fix: write if valid regardless of window.
          const _expPairs=await Promise.all(monthlyPairs.map((pair,pi)=>{
            setP(65+pi*8,'Fetching '+t+' options exp '+(pi+1)+'/'+monthlyPairs.length+'...');
            return _tkTimeout(yahooOptionsViaProxy(t,String(pair.ts)),12000,'exp '+pair.date)
              .then(d=>({pair,data:d})).catch(()=>({pair,data:null}));
          }));
          _expPairs.forEach(({pair,data})=>{
            if(!data)return;
            const _expKey='options_exp_'+t+'_'+pair.date;
            const _expv=_validateOptionsData(data);
            if(_expv.valid){
              S.set(_expKey,{...data,ts:nowPT()});
            }else if(!_rtInWindow&&_hasGoodSameDayCache(_expKey)){
              console.log(t+' '+pair.date+': outside live window, fetch INVALID ('+_expv.reason+') -- preserving same-day exp cache');
            }else if(!S.get(_expKey)){
              S.set(_expKey,{...data,ts:nowPT(),synthetic:true});
            }else{
              console.warn(t+' '+pair.date+': exp rejected ('+_expv.reason+'), preserving cache');
            }
          });
          optionsLoaded=true;
        }
      }catch{}
      // Regardless of fetch outcome, check if good non-synthetic cache exists
      if(!optionsLoaded){
        const _fallback=S.get('options_'+t);
        if(_fallback&&!_fallback.synthetic)optionsLoaded=true;
      }
    }
    setP(100,'Done!');
    // Re-render ticker tab with fresh data
    currentTicker=t;
    await loadTicker();
    toast(t+' refreshed'+(optionsLoaded?' including options':''),3000);
    // Update health record for this ticker
    try{
      const _h=S.get('last_refresh_health');
      if(_h?.tickers){
        // Preserve 'skipped' status if options were not explicitly fetched this run
        const _prevOpts=_h.tickers[t]?.options;
        const _newOpts=optionsLoaded?true:(_prevOpts==='skipped'?'skipped':false);
        _h.tickers[t]={snap:true,hist:true,options:_newOpts};
        // Recompute summary
        const _wl=S.get('watchlist')||[];
        const _ok=_wl.filter(tk=>_h.tickers[tk]?.snap&&_h.tickers[tk]?.hist).length;
        _h.summary={total:_wl.length,ok:_ok,failed:_wl.filter(tk=>!(_h.tickers[tk]?.snap&&_h.tickers[tk]?.hist))};
        _h.completedTs=nowPT();
        S.set('last_refresh_health',_h);
        if(typeof _updateRefreshHealthBadge==='function')_updateRefreshHealthBadge();
      }
    }catch{}
  }catch(e){
    toast('Refresh failed: '+e.message,3000);
  }finally{
    btn.disabled=false;
    setTimeout(()=>{prog.style.display='none';bar.style.width='0%';},2000);
  }
}
