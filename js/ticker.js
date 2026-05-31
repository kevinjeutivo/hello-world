// PutSeller Pro -- ticker.js
// currentBBSpan declared as global in index.html
// Ticker tab: load, render, restore from cache, chart functions.
// Globals used: currentTicker, WORKER_URL, S, offlineMode
// Dependencies: helpers.js, api.js, storage.js

async function loadTicker(){
  const t=document.getElementById('ticker-select').value;if(!t)return;
  if(t!==currentTicker){currentTicker=t;S.set('last_ticker',t);document.getElementById('options-ticker-select').value=t;clearOptionsState();}
  document.getElementById('ticker-content').innerHTML=`<div class="card"><div style="display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--text2)"><div class="spinner"></div>Loading ${t}...</div></div>`;
  try{
    let snap,hist6mo,hist1y,news,recData,isLive=true;
    try{
      const[quote,profile,metrics,earnings]=await Promise.all([
        fh(`/quote?symbol=${t}`),fh(`/stock/profile2?symbol=${t}`),
        fh(`/stock/metric?symbol=${t}&metric=all`),
        fh(`/calendar/earnings?symbol=${t}&from=${fmtDate(new Date())}&to=${fmtDate(addDays(new Date(),180))}`)
      ]);
      let rec=null,upgrades=null;
      try{rec=await fh(`/stock/recommendation?symbol=${t}`);}catch{}
      try{upgrades=await fh(`/stock/upgrade-downgrade?symbol=${t}&from=${fmtDate(addDays(new Date(),-90))}`);}catch{}
      // price targets fetched via fetchQuoteSummary below (Yahoo, free tier)
      snap={ticker:t,name:profile.name||t,price:quote.c,prevClose:quote.pc,change:quote.c-quote.pc,changePct:((quote.c-quote.pc)/quote.pc*100),high:quote.h,low:quote.l,week52High:metrics.metric?.['52WeekHigh']||null,week52Low:metrics.metric?.['52WeekLow']||null,marketCap:profile.marketCapitalization?profile.marketCapitalization*1e6:null,beta:metrics.metric?.beta||null,peRatio:metrics.metric?.peBasicExclExtraTTM||null,peForward:metrics.metric?.peForwardAnnual||null,epsTTM:metrics.metric?.epsBasicExclExtraTTM||null,epsGrowth:metrics.metric?.epsGrowthTTMYoy||null,dividendYield:metrics.metric?.dividendYieldIndicatedAnnual||null,shortInterest:metrics.metric?.shortInterest||null,shortRatio:metrics.metric?.shortRatio||null,shortInterestPct:metrics.metric?.shortInterestPercentage||metrics.metric?.shortInterestPercent||null,revenueGrowthTTM:metrics.metric?.revenueGrowthTTMYoy||null,fcfMargin:metrics.metric?.freeCashFlowMarginAnnual||null,operatingMargin:metrics.metric?.operatingMarginAnnual||null,earningsDate:(()=>{const future=(earnings?.earningsCalendar||[]).filter(e=>e.date>=fmtDate(new Date())).sort((a,b)=>a.date.localeCompare(b.date));return future[0]?.date||null;})(),earningsHour:(()=>{const future=(earnings?.earningsCalendar||[]).filter(e=>e.date>=fmtDate(new Date())).sort((a,b)=>a.date.localeCompare(b.date));return future[0]?.hour||null;})(),ts:nowPT(),isLive:true};
      recData=rec&&rec.length?rec[0]:null;
      const upgradeData=upgrades&&upgrades.length?upgrades.slice(0,6):[];
      // Sanity-check 52W range -- Finnhub can return TWD values for ADRs like TSM
      if(snap.week52High&&snap.week52Low&&snap.price){
        const hiRatio=snap.week52High/snap.price,loRatio=snap.price/snap.week52Low;
        if(hiRatio>5||loRatio>5||snap.week52High<snap.price*0.5||snap.week52Low>snap.price*1.5){
          console.warn(t+': implausible 52W range from Finnhub, clearing');
          snap.week52High=null;snap.week52Low=null;
        }
      }
      S.set('snap_'+t,snap);S.set('rec_'+t,{data:recData||null,ts:nowPT()});S.set('upgrades_'+t,{data:upgradeData||[],ts:nowPT()});
      try{const ah=await fetchAfterHoursPrice(t);if(ah){
        // Preserve after-hours price through overnight until premarket --
        // Yahoo stops returning postMarketPrice once CLOSED, so only overwrite
        // with null if we're actually in a live extended or regular session.
        const _ahMs=ah.marketState||'';
        const _isLiveSession=_ahMs==='PRE'||_ahMs==='POST'||_ahMs==='POSTPOST'||_ahMs==='REGULAR';
        if(_ahMs==='PRE'){
          // Premarket started -- clear lingered after-hours price, show pre-market price instead
          snap.postMarketPrice=ah.postMarketPrice;
          snap.postMarketChange=ah.postMarketChange||null;
          snap.postMarketChangePct=ah.postMarketChangePct||null;
        }else if(_isLiveSession||ah.postMarketPrice){
          snap.postMarketPrice=ah.postMarketPrice;
          snap.postMarketChange=ah.postMarketChange||null;
          snap.postMarketChangePct=ah.postMarketChangePct||null;
        }
        // CLOSED overnight: postMarketPrice preserved from previous fetch
        // Always update marketState and other fields
        snap.marketState=ah.marketState;snap.peForward=ah.forwardPE||null;
        if(ah.trailingEps!==null)snap.epsTTM=ah.trailingEps;
        if(ah.intradayVolume!=null)snap.intradayVolume=ah.intradayVolume;
      }}catch{}
      // Fetch enriched data from Yahoo quoteSummary (4 modules in one call)
      try{
        const qs=await fetchQuoteSummary(t);
        if(qs){
          if(qs.ptMean){snap.ptMean=qs.ptMean;snap.ptHigh=qs.ptHigh||null;snap.ptLow=qs.ptLow||null;snap.ptAnalysts=qs.ptAnalysts||null;}
          if(qs.pegRatio!=null)snap.pegRatio=qs.pegRatio;
          if(qs.evToEbitda!=null)snap.evToEbitda=qs.evToEbitda;
          if(qs.shortPctFloat!=null){snap.shortPctFloat=qs.shortPctFloat;snap.shortRatioYahoo=qs.shortRatioYahoo;}
          if(qs.earningsTrend&&qs.earningsTrend.length)snap.earningsTrend=qs.earningsTrend;
          if(qs.recTrend&&qs.recTrend.length)snap.recTrend=qs.recTrend;
          S.set('snap_'+t,snap);
        }
      }catch{}
    }catch{
      const cached=S.get('snap_'+t);if(cached){snap=cached;isLive=false;showOfflineBanner(cached.ts);}else throw new Error('No data available');
      const cr=S.get('rec_'+t);if(cr)recData=cr.data;
    }
    try{hist6mo=await yahooHistory(t,'6mo','1d');S.set('hist_'+t,{timestamps:hist6mo.timestamps.map(d=>d.toISOString()),closes:hist6mo.closes,volumes:hist6mo.volumes,ts:nowPT()});}
    catch{const ch=S.get('hist_'+t);if(ch){hist6mo={timestamps:ch.timestamps.map(d=>new Date(d)),closes:ch.closes,volumes:ch.volumes};if(!isLive)showOfflineBanner(ch.ts);}}
    try{const h1=await yahooHistory(t,'1y','1d');S.set('hist1y_'+t,{timestamps:h1.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:h1.closes.map(v=>v!=null?Math.round(v*100)/100:null),volumes:h1.volumes.map(v=>v||0),ts:nowPT()});hist1y=h1;}
    catch{const ch=S.get('hist1y_'+t);if(ch)hist1y={timestamps:ch.timestamps.map(d=>new Date(d)),closes:ch.closes,volumes:ch.volumes};}
    // ── Promote previous confirmed earnings date to history cache ────────────
    // Before snap.earningsDate is overwritten, check if the prior stored date
    // is now in the past -- if so, promote it to earnings_confirmed_TICKER.
    try{
      const _prevSnap=S.get('snap_'+t);
      const _prevDate=_prevSnap?.earningsDate;
      const _prevHour=_prevSnap?.earningsHour||null;
      if(_prevDate&&_prevDate<fmtDate(new Date())){
        const _conf=S.get('earnings_confirmed_'+t)||[];
        // Deduplicate within ±3 days
        const _alreadyHave=_conf.some(c=>Math.abs(new Date(c.date)-new Date(_prevDate))<4*86400000);
        if(!_alreadyHave){
          _conf.push({date:_prevDate,hour:_prevHour,addedTs:nowPT()});
          // Prune entries older than 730 days
          const _cutoff=new Date();_cutoff.setDate(_cutoff.getDate()-730);
          const _fresh=_conf.filter(c=>new Date(c.date)>=_cutoff);
          S.set('earnings_confirmed_'+t,_fresh);
        }
      }
    }catch{}

    // 2Y history for relative performance chart and earnings pattern analysis
    try{const h2=await yahooHistory(t,'2y','1d');S.set('hist2y_'+t,{timestamps:h2.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:h2.closes.map(v=>v!=null?Math.round(v*100)/100:null),volumes:h2.volumes?h2.volumes.map(v=>v||0):null,ts:nowPT()});}
    catch{}
    // ^GSPC 2Y history for relative performance chart (shared across tickers)
    try{const cacheAge=(Date.now()-(S.get('hist2y_sp500')?.ts||0))/3600000;
      if(cacheAge>4){const sp2=await yahooHistory('^GSPC','2y','1d');S.set('hist2y_sp500',{timestamps:sp2.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:sp2.closes.map(v=>v!=null?Math.round(v*100)/100:null),ts:Date.now()});}
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

          if(bestGap&&bestGap.gapPct>=3){
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
    // Backfill 52W high/low from Yahoo history when Finnhub values are null or were cleared as implausible
    if((!snap.week52High||!snap.week52Low)&&hist1y?.closes?.length){
      const valid=hist1y.closes.filter(c=>c!=null&&c>0);
      if(valid.length){
        const histHigh=Math.max(...valid),histLow=Math.min(...valid);
        if(!snap.week52High)snap.week52High=histHigh;
        if(!snap.week52Low)snap.week52Low=histLow;
        S.set('snap_'+t,{...S.get('snap_'+t)||snap,week52High:snap.week52High,week52Low:snap.week52Low});
        console.log(t+': backfilled 52W range from history: '+histLow+'-'+histHigh);
      }
    }
    try{news=await fetchNews(t);S.set('news_'+t,{items:(news||[]).slice(0,10).map(n=>({headline:n.headline,summary:n.summary?n.summary.slice(0,200):null,url:n.url,source:n.source,datetime:n.datetime,sentiment:n.sentiment})),ts:nowPT()});}
    catch{const cn=S.get('news_'+t);if(cn)news=cn.items;}
    const upgradesData=S.get('upgrades_'+t)?.data||[];
    // Re-read snap from localStorage to pick up fetchQuoteSummary enrichment
    // (ptMean, pegRatio, earningsTrend etc. are saved there by fetchQuoteSummary)
    const snapFinal=S.get('snap_'+t)||snap;
    const _h2=S.get('hist2y_'+t);const _hist2y=_h2?{timestamps:_h2.timestamps.map(d=>new Date(d*1000)),closes:_h2.closes}:null;
    const _sp2=S.get('hist2y_sp500');const _hist2ySP=_sp2?{timestamps:_sp2.timestamps.map(d=>new Date(d*1000)),closes:_sp2.closes}:null;
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
  const ch=S.get('hist_'+t);const hist6mo=ch?{timestamps:ch.timestamps.map(d=>new Date(d)),closes:ch.closes,volumes:ch.volumes}:null;
  const ch1=S.get('hist1y_'+t);const hist1y=ch1?{timestamps:ch1.timestamps.map(d=>new Date(d)),closes:ch1.closes,volumes:ch1.volumes}:null;
  const ch2=S.get('hist2y_'+t);const hist2y=ch2?{timestamps:ch2.timestamps.map(d=>new Date(d*1000)),closes:ch2.closes,volumes:ch2.volumes||null}:null;
  const sp2c=S.get('hist2y_sp500');const hist2ySP=sp2c?{timestamps:sp2c.timestamps.map(d=>new Date(d*1000)),closes:sp2c.closes}:null;
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
  const cacheKey=span==='6m'?'hist_'+t:(span==='2y'?'hist2y_'+t:'hist1y_'+t);
  const h=S.get(cacheKey);
  if(!h){toast((span==='1y'?'1Y':'6M')+' history not cached -- run full refresh',2500);return;}
  const hist={
    timestamps:h.timestamps.map(d=>new Date(typeof d==='number'?d*1000:d)),
    closes:h.closes,
    volumes:h.volumes||[]
  };
  // Recompute Bollinger Band data from history (same logic as renderTickerContent)
  let bbData=null;
  if(hist.closes&&hist.closes.length>20){
    const closes=hist.closes.filter(c=>c!==null);
    const sma20=closes.map((_,i)=>i<19?null:avg(closes.slice(i-19,i+1)));
    const stdDev=closes.map((_,i)=>{if(i<19)return null;const sl=closes.slice(i-19,i+1);const m=avg(sl);return Math.sqrt(sl.reduce((s,v)=>s+(v-m)**2,0)/20);});
    const upper=sma20.map((m,i)=>m?m+2*stdDev[i]:null);
    const lower=sma20.map((m,i)=>m?m-2*stdDev[i]:null);
    // Align with timestamps (filter nulls from front)
    const fullCloses=hist.closes;
    bbData={timestamps:hist.timestamps,closes:fullCloses,sma20,upper,lower};
  }
  if(bbData)renderBBChart(bbData,hist);
  // Re-render volume chart for new span
  const _vt=currentTicker;
  const _vh6=S.get('hist_'+_vt);const _vh6m=_vh6?{timestamps:_vh6.timestamps.map(d=>new Date(d*1000)),closes:_vh6.closes,volumes:_vh6.volumes}:null;
  const _vh1=S.get('hist1y_'+_vt);const _vh1y=_vh1?{timestamps:_vh1.timestamps.map(d=>new Date(d*1000)),closes:_vh1.closes,volumes:_vh1.volumes}:null;
  const _vh2=S.get('hist2y_'+_vt);const _vh2y=_vh2?{timestamps:_vh2.timestamps,closes:_vh2.closes,volumes:_vh2.volumes||null}:null;
  const _vSnap=S.get('snap_'+_vt);const _avg20=_vSnap?.avgVol20||null;
  renderVolChart(_vh6m,_vh1y,_vh2y,span,_avg20);
}

function buildR40Tile(snap){
  const revGrowth=snap.revenueGrowthTTM;
  const margin=snap.fcfMargin||snap.operatingMargin;
  if(revGrowth===null||revGrowth===undefined||margin===null||margin===undefined)return'';
  // revenueGrowthTTMYoy is a decimal (0.25 = 25%) -- multiply by 100
  // fcfMargin / operatingMargin: Finnhub returns inconsistently --
  // sometimes as a percentage (42.3) sometimes as a decimal (0.423)
  // and occasionally as a large integer (4230 -- bug in their API).
  // Normalize: if |value| > 200, divide by 100. If |value| <= 1, multiply by 100.
  let marginNorm=margin;
  if(Math.abs(marginNorm)>200)marginNorm=marginNorm/100;
  else if(Math.abs(marginNorm)<=1&&marginNorm!==0)marginNorm=marginNorm*100;
  // Clamp to reasonable range (-100% to +100%)
  marginNorm=Math.max(-100,Math.min(100,marginNorm));
  // Same normalization for revenue growth
  let growthNorm=revGrowth;
  if(Math.abs(growthNorm)>5)growthNorm=growthNorm/100; // already a percentage
  const growthPct=(growthNorm*100).toFixed(1);
  const marginPct=marginNorm.toFixed(1);
  const score=parseFloat(growthPct)+parseFloat(marginPct);
  const scoreStr=score.toFixed(1);
  const scoreColor=score>=40?'var(--green)':score>=20?'var(--warn)':'var(--red)';
  const scoreLabel=score>=40?'Healthy (above 40)':score>=20?'Below threshold (20-40)':'Weak (below 20)';
  const marginLabel=snap.fcfMargin?'FCF':'Operating';
  return '<div class="metric-tile" style="grid-column:span 2">'
    +'<div class="metric-label">Rule of 40 (software/SaaS)</div>'
    +'<div style="display:flex;align-items:baseline;gap:8px;margin-top:4px">'
    +'<div style="font-family:var(--mono);font-size:22px;font-weight:600;color:'+scoreColor+'">'+scoreStr+'</div>'
    +'<div style="font-family:var(--mono);font-size:11px;color:'+scoreColor+'">'+scoreLabel+'</div>'
    +'</div>'
    +'<div class="metric-sub" style="margin-top:4px">Revenue growth '+growthPct+'% + '+marginLabel+' margin '+marginPct+'% = '+scoreStr+'.'
    +' Applies primarily to software and SaaS companies. Score above 40 indicates healthy growth-profitability balance.</div>'
    +'</div>';
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
  function fmtVol(v){if(v==null)return'N/A';if(v>=1e9)return(v/1e9).toFixed(2)+'B';if(v>=1e6)return(v/1e6).toFixed(2)+'M';if(v>=1e3)return(v/1e3).toFixed(0)+'K';return v.toFixed(0);}
  const earningsTiming=snap.earningsHour==='bmo'?' (before open)':snap.earningsHour==='amc'?' (after close)':'';
  const earningsStr=snap.earningsDate?`<div class="earnings-warn" style="margin-top:10px">Earnings: ${snap.earningsDate}${earningsTiming}</div>`:'';
  const ivrVal=computeIVR(snap.ticker,snap.week52High,snap.week52Low,snap.price);
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
      <div class="metric-tile"><div class="metric-label">52W High</div><div class="metric-value" style="font-size:13px">$${snap.week52High?.toFixed(2)||'N/A'}</div></div>
      <div class="metric-tile"><div class="metric-label">52W Low</div><div class="metric-value" style="font-size:13px">$${snap.week52Low?.toFixed(2)||'N/A'}</div></div>
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
  ${hist?`<div class="card"><div class="card-title"><span class="dot"></span>Bollinger Bands + RSI</div><div style="display:flex;gap:6px;margin-bottom:4px"><button class="btn btn-secondary" style="font-size:10px;padding:2px 8px" id="bb-btn-6m" onclick="toggleBBSpan(\'6m\')">6M</button><button class="btn btn-secondary" style="font-size:10px;padding:2px 8px;opacity:0.4" id="bb-btn-1y" onclick="toggleBBSpan(\'1y\')">1Y</button><button class="btn btn-secondary" style="font-size:10px;padding:2px 8px;opacity:0.4" id="bb-btn-2y" onclick="toggleBBSpan(\'2y\')">2Y</button></div><div class="chart-wrap" style="height:180px"><canvas id="bb-chart"></canvas></div><div class="chart-wrap" style="height:90px"><canvas id="rsi-chart"></canvas></div><div class="chart-wrap" style="height:70px;margin-top:4px"><canvas id="vol-chart"></canvas></div><div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:6px">${bbStr}</div><div class="commentary" style="margin-top:10px">Bollinger Bands: upper band touch = statistically extended, overbought. Lower band touch = oversold. Narrow bands signal compressed volatility.

RSI (14): below 30 (green shading) = oversold, favorable for puts. Above 70 (red shading) = overbought, favorable for covered calls.</div></div>`:''}
  ${(hist2y&&hist2ySP)?renderRelPerfCard(snap.ticker,hist2y,hist2ySP,earningsHistory):''}  ${hist1y?`<div class="card"><div class="card-title"><span class="dot" style="background:teal"></span>Volume Profile -- Support / Resistance (1Y)</div><div class="chart-wrap" style="height:300px"><canvas id="vp-chart"></canvas></div><div id="vp-analysis"></div></div>`:''}
  <div class="card"><div class="card-title"><span class="dot" style="background:var(--accent2)"></span>Recent News (7 days)</div><div id="news-section">${renderNewsItems(news)}</div></div>
  ${upgradesData&&upgradesData.length?buildUpgradeTable(upgradesData):''}
  ${snap.ptMean?buildPriceTargetCard(snap):''}
  ${snap.earningsTrend&&snap.earningsTrend.length?buildEarningsTrendCard(snap.earningsTrend):''}
  ${snap.recTrend&&snap.recTrend.length?buildRecTrendCard(snap.recTrend):''}`;
  if(bbData)renderBBChart(bbData,hist);
  renderVolChart(hist,hist1y,hist2y,currentBBSpan||'6m',avgVol20);
  if(hist1y)renderVPChart(hist1y,snap.price,snap.week52High,snap.week52Low);
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
function toggleRPSpan(span){
  currentRPSpan=span;
  ['6m','1y','2y'].forEach(s=>{
    const btn=document.getElementById('rp-btn-'+s);
    if(btn)btn.style.opacity=s===span?'1':'0.4';
  });
  const t=currentTicker;
  const h2c=S.get('hist2y_'+t);
  const spc=S.get('hist2y_sp500');
  const ehc=S.get('earnings_hist_'+t);
  if(h2c&&spc)renderRelPerfChart(t,
    {timestamps:h2c.timestamps,closes:h2c.closes},
    {timestamps:spc.timestamps,closes:spc.closes},
    _getEarningsWithOverrides(t),span);
  const titleEl=document.getElementById('rp-title-span');
  if(titleEl){
    const label=span==='6m'?'6 Months':span==='1y'?'1 Year':'2 Years';
    titleEl.textContent='Relative Performance vs S\u0026P 500 ('+label+')';
  }
}

function toggleRelPerfEarnings(){
  S.set('rp_earnings_toggle',getRelPerfEarningsToggle()?'off':'on');
  // Re-render by triggering chart update
  const ctx=document.getElementById('rp-chart')?.getContext('2d');
  if(!ctx)return;
  const t=currentTicker;
  const h2c=S.get('hist2y_'+t);const h2=h2c?{timestamps:h2c.timestamps.map(d=>new Date(d*1000)),closes:h2c.closes}:null;
  const spc=S.get('hist2y_sp500');const sp=spc?{timestamps:spc.timestamps.map(d=>new Date(d*1000)),closes:spc.closes}:null;
  const ehc=S.get('earnings_hist_'+t);
  if(h2&&sp)renderRelPerfChart(t,h2,sp,_getEarningsWithOverrides(t),currentRPSpan||'2y');
  // Update button
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
  return `<div class="card">
    <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
      <span id="rp-title-span"><span class="dot" style="background:var(--accent)"></span>Relative Performance vs S&P 500 (${_rpSpanLabel})</span>
      <button id="rp-earn-btn" class="btn btn-secondary" style="font-size:10px;padding:2px 8px;opacity:${earnToggleOpacity}" onclick="toggleRelPerfEarnings()">Earnings</button>
    </div>
    <div style="display:flex;gap:4px;margin-bottom:6px">
      ${_rpBtn('6m','6M')+_rpBtn('1y','1Y')+_rpBtn('2y','2Y')}
    </div>
    <div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-bottom:6px">Both indexed to 100 at start of window. Above 100 = outperforming S&amp;P 500.</div>
    <div class="chart-wrap" style="height:200px"><canvas id="rp-chart"></canvas></div>
    <div id="rp-legend" style="display:flex;gap:12px;margin-top:6px">
      <div style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:2px;background:var(--accent)"></span><span style="font-family:var(--mono);font-size:9px;color:var(--text3)">${ticker}</span></div>
      <div style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:2px;background:#8b8fa8"></span><span style="font-family:var(--mono);font-size:9px;color:var(--text3)">S&P 500</span></div>
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

function renderRelPerfChart(ticker,hist2y,hist2ySP,earningsHistory,span){
  const ctx=document.getElementById('rp-chart')?.getContext('2d');
  if(!ctx)return;

  // Compute cutoff date from span param (default 2Y)
  const _span=span||currentRPSpan||'2y';
  const cutoffDays=_span==='6m'?183:_span==='1y'?365:730;
  const cutoff=new Date(Date.now()-cutoffDays*86400000);

  // Align series by date -- find common date range
  const _toDateStr=d=>{
    if(d instanceof Date)return d.toISOString().split('T')[0];
    // Stored as Unix seconds -- multiply by 1000
    return new Date(d*1000).toISOString().split('T')[0];
  };
  // Filter timestamps to the selected timeframe window
  const stockDates=hist2y.timestamps
    .map((d,i)=>({d:_toDateStr(d),i}))
    .filter(({d})=>new Date(d+'T00:00:00Z')>=cutoff)
    .map(({d})=>d);
  const spDates=hist2ySP.timestamps
    .map((d,i)=>({d:_toDateStr(d),i}))
    .filter(({d})=>new Date(d+'T00:00:00Z')>=cutoff)
    .map(({d})=>d);
  // Rebuild closes aligned to filtered dates
  const _stockFiltered=hist2y.timestamps
    .map((d,i)=>({d:_toDateStr(d),c:hist2y.closes[i]}))
    .filter(({d})=>new Date(d+'T00:00:00Z')>=cutoff);
  const _spFiltered=hist2ySP.timestamps
    .map((d,i)=>({d:_toDateStr(d),c:hist2ySP.closes[i]}))
    .filter(({d})=>new Date(d+'T00:00:00Z')>=cutoff);

  // Build date-keyed maps from filtered data
  const stockMap={};_stockFiltered.forEach(({d,c})=>{if(c!=null)stockMap[d]=c;});
  const spMap={};_spFiltered.forEach(({d,c})=>{if(c!=null)spMap[d]=c;});

  // Filter to selected span before finding common dates
  const _spanDays={'6m':183,'1y':365,'2y':730}[span||'2y']||730;
  const _cutoff=new Date(Date.now()-_spanDays*86400000).toISOString().split('T')[0];

  // Common dates only, filtered to span
  const commonDates=stockDates.filter(d=>stockMap[d]!=null&&spMap[d]!=null&&d>=_cutoff).sort();
  if(commonDates.length<10)return;

  // Normalize both to 100 at first common date
  const base=commonDates[0];
  const stockBase=stockMap[base];
  const spBase=spMap[base];

  const stockNorm=commonDates.map(d=>Math.round(stockMap[d]/stockBase*10000)/100);
  const spNorm=commonDates.map(d=>Math.round(spMap[d]/spBase*10000)/100);

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
          const confirmed=ev.source==='gap-confirmed'||(ev.gapPct!=null&&ev.gapPct>=3);
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
        {label:'S&P 500',data:spNorm,borderColor:'#8b8fa8',borderWidth:1.5,pointRadius:0,tension:0.2,fill:false,borderDash:[3,2]}
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

// Called after renderTickerContent to render the rel perf chart
function _initRelPerfChart(ticker,hist2y,hist2ySP,earningsHistory,span){
  if(hist2y&&hist2ySP)renderRelPerfChart(ticker,hist2y,hist2ySP,earningsHistory,span||'2y');
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
      if(!(d instanceof Date))d=new Date(d);
      return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
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
    const[quote,profile,metrics,earnings]=await Promise.all([
      fh(`/quote?symbol=${t}`),fh(`/stock/profile2?symbol=${t}`),
      fh(`/stock/metric?symbol=${t}&metric=all`),
      fh(`/calendar/earnings?symbol=${t}&from=${fmtDate(new Date())}&to=${fmtDate(addDays(new Date(),180))}`)
    ]);
    let rec=null,upgrades=null,priceTargetS=null;
    try{rec=await fh(`/stock/recommendation?symbol=${t}`);}catch{}
    try{upgrades=await fh(`/stock/upgrade-downgrade?symbol=${t}&from=${fmtDate(addDays(new Date(),-90))}`);}catch{}
    try{priceTargetS=await fh(`/stock/price-target?symbol=${t}`);}catch{}
    const futE=(earnings?.earningsCalendar||[]).filter(e=>e.date>=fmtDate(new Date())).sort((a,b)=>a.date.localeCompare(b.date));
    const snap={ticker:t,name:profile.name||t,price:quote.c,prevClose:quote.pc,
      change:quote.c-quote.pc,changePct:((quote.c-quote.pc)/quote.pc*100),
      high:quote.h,low:quote.l,
      week52High:metrics.metric?.['52WeekHigh']||null,week52Low:metrics.metric?.['52WeekLow']||null,
      marketCap:profile.marketCapitalization?profile.marketCapitalization*1e6:null,
      beta:metrics.metric?.beta||null,peRatio:metrics.metric?.peBasicExclExtraTTM||null,
      peForward:metrics.metric?.peForwardAnnual||null,
      dividendYield:metrics.metric?.dividendYieldIndicatedAnnual||null,
      shortInterest:metrics.metric?.shortInterest||null,shortRatio:metrics.metric?.shortRatio||null,
      shortInterestPct:metrics.metric?.shortInterestPercentage||metrics.metric?.shortInterestPercent||null,
      revenueGrowthTTM:metrics.metric?.revenueGrowthTTMYoy||null,
      fcfMargin:metrics.metric?.freeCashFlowMarginAnnual||null,
      operatingMargin:metrics.metric?.operatingMarginAnnual||null,
      epsTTM:metrics.metric?.epsBasicExclExtraTTM||null,
      epsGrowth:metrics.metric?.epsGrowthTTMYoy||null,
      earningsDate:futE[0]?.date||null,earningsHour:futE[0]?.hour||null,
      ts:nowPT(),isLive:true};
    // Promote previous confirmed earnings date before overwriting
    try{
      const _rPrev=S.get('snap_'+t);
      const _rPrevDate=_rPrev?.earningsDate;const _rPrevHour=_rPrev?.earningsHour||null;
      if(_rPrevDate&&_rPrevDate<fmtDate(new Date())){
        const _rConf=S.get('earnings_confirmed_'+t)||[];
        if(!_rConf.some(c=>Math.abs(new Date(c.date)-new Date(_rPrevDate))<4*86400000)){
          _rConf.push({date:_rPrevDate,hour:_rPrevHour,addedTs:nowPT()});
          const _rCut=new Date();_rCut.setDate(_rCut.getDate()-730);
          S.set('earnings_confirmed_'+t,_rConf.filter(c=>new Date(c.date)>=_rCut));
        }
      }
    }catch{}
    // Step 2: Yahoo quote for forwardPE and EPS
    setP(20,'Fetching '+t+' extended quote...');
    try{const ah=await fetchAfterHoursPrice(t);if(ah){
        const _ahMs2=ah.marketState||'';
        const _isLive2=_ahMs2==='PRE'||_ahMs2==='POST'||_ahMs2==='POSTPOST'||_ahMs2==='REGULAR';
        if(_isLive2||ah.postMarketPrice){
          snap.postMarketPrice=ah.postMarketPrice;
          snap.postMarketChange=ah.postMarketChange||null;
          snap.postMarketChangePct=ah.postMarketChangePct||null;
        }
        snap.marketState=ah.marketState;snap.peForward=ah.forwardPE||null;
        if(ah.trailingEps!=null)snap.epsTTM=ah.trailingEps;
        if(ah.intradayVolume!=null)snap.intradayVolume=ah.intradayVolume;
      }}catch{}
      try{const qs=await fetchQuoteSummary(t);if(qs){
        if(qs.ptMean){snap.ptMean=qs.ptMean;snap.ptHigh=qs.ptHigh||null;snap.ptLow=qs.ptLow||null;snap.ptAnalysts=qs.ptAnalysts||null;}
        if(qs.pegRatio!=null)snap.pegRatio=qs.pegRatio;
        if(qs.evToEbitda!=null)snap.evToEbitda=qs.evToEbitda;
        if(qs.shortPctFloat!=null){snap.shortPctFloat=qs.shortPctFloat;snap.shortRatioYahoo=qs.shortRatioYahoo;}
        if(qs.earningsTrend&&qs.earningsTrend.length)snap.earningsTrend=qs.earningsTrend;
        if(qs.recTrend&&qs.recTrend.length)snap.recTrend=qs.recTrend;
      }}catch{}
      if(priceTargetS&&priceTargetS.targetMean){snap.ptMean=priceTargetS.targetMean||null;snap.ptHigh=priceTargetS.targetHigh||null;snap.ptLow=priceTargetS.targetLow||null;}
    S.set('snap_'+t,snap);
    S.set('rec_'+t,{data:rec&&rec.length?rec[0]:null,ts:nowPT()});
    S.set('upgrades_'+t,{data:upgrades&&upgrades.length?upgrades.slice(0,6):[],ts:nowPT()});
    // Step 3: Price history
    setP(35,'Fetching '+t+' price history...');
    try{const h6=await yahooHistory(t,'6mo','1d');S.set('hist_'+t,{timestamps:h6.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:h6.closes.map(v=>v!=null?Math.round(v*100)/100:null),volumes:h6.volumes.map(v=>v||0),ts:nowPT()});}catch{}
    try{const h1=await yahooHistory(t,'1y','1d');S.set('hist1y_'+t,{timestamps:h1.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:h1.closes.map(v=>v!=null?Math.round(v*100)/100:null),volumes:h1.volumes.map(v=>v||0),ts:nowPT()});}catch{}
    // Step 4: News
    setP(50,'Fetching '+t+' news...');
    try{const newsData=await fetchNews(t);S.set('news_'+t,{items:(newsData||[]).slice(0,10).map(n=>({headline:n.headline,summary:n.summary?n.summary.slice(0,200):null,url:n.url,source:n.source,datetime:n.datetime,sentiment:n.sentiment})),ts:nowPT()});}catch{}
    // Step 5: Options chain top-level
    setP(65,'Fetching '+t+' options chain...');
    let optionsLoaded=false;
    try{
      const opts=await yahooOptionsViaProxy(t);
      S.set('options_'+t,{data:slimOptionsData(opts),ts:nowPT()});
      const yr=opts?.optionChain?.result?.[0];
      const rawTs=yr?.expirationDates||[];
      const pairs=rawTs.map(ts=>({ts,date:new Date(ts*1000).toISOString().split('T')[0]}));
      let monthlyPairs=pairs.filter(p=>{const d=new Date(p.date+'T12:00:00Z');return(d.getUTCDay()===5||d.getUTCDay()===4)&&d.getUTCDate()>=15&&d.getUTCDate()<=21;}).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);
      if(monthlyPairs.length===0){const tw=Date.now()+14*86400000;monthlyPairs=pairs.filter(p=>p.ts*1000>=tw).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);}
      if(monthlyPairs.length===0)monthlyPairs=pairs.sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);
      // Step 6: Per-expiration chains
      for(let pi=0;pi<monthlyPairs.length;pi++){
        const pair=monthlyPairs[pi];
        setP(65+pi*10,'Fetching '+t+' options exp '+(pi+1)+'/'+monthlyPairs.length+'...');
        try{S.set('options_exp_'+t+'_'+pair.date,await yahooOptionsViaProxy(t,String(pair.ts)));}catch{}
      }
      optionsLoaded=true;
    }catch{}
    setP(100,'Done!');
    // Re-render ticker tab with fresh data
    currentTicker=t;
    await loadTicker();
    toast(t+' refreshed'+(optionsLoaded?' including options':''),3000);
  }catch(e){
    toast('Refresh failed: '+e.message,3000);
  }finally{
    btn.disabled=false;
    setTimeout(()=>{prog.style.display='none';bar.style.width='0%';},2000);
  }
}
