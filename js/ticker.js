// PutSeller Pro -- ticker.js
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
      try{const ah=await fetchAfterHoursPrice(t);if(ah){snap.postMarketPrice=ah.postMarketPrice;snap.postMarketChange=ah.postMarketChange||null;snap.postMarketChangePct=ah.postMarketChangePct||null;snap.marketState=ah.marketState;snap.peForward=ah.forwardPE||null;if(ah.trailingEps!==null)snap.epsTTM=ah.trailingEps;if(ah.intradayVolume!=null)snap.intradayVolume=ah.intradayVolume;
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
    // 2Y history for relative performance chart and earnings pattern analysis
    try{const h2=await yahooHistory(t,'2y','1d');S.set('hist2y_'+t,{timestamps:h2.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:h2.closes.map(v=>v!=null?Math.round(v*100)/100:null),ts:nowPT()});}
    catch{}
    // ^GSPC 2Y history for relative performance chart (shared across tickers)
    try{const cacheAge=(Date.now()-(S.get('hist2y_sp500')?.ts||0))/3600000;
      if(cacheAge>4){const sp2=await yahooHistory('^GSPC','2y','1d');S.set('hist2y_sp500',{timestamps:sp2.timestamps.map(d=>Math.floor(d.getTime()/1000)),closes:sp2.closes.map(v=>v!=null?Math.round(v*100)/100:null),ts:Date.now()});}
    }catch{}
    // Historical earnings dates from Finnhub (limit=8 = ~2 years of quarters)
    try{const eh=await fh('/stock/earnings?symbol='+t+'&limit=8');if(eh&&eh.length)S.set('earnings_hist_'+t,{data:eh,ts:nowPT()});}catch{}
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
  const ch2=S.get('hist2y_'+t);const hist2y=ch2?{timestamps:ch2.timestamps.map(d=>new Date(d*1000)),closes:ch2.closes}:null;
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
    ${(()=>{const _ms=getMarketState().state;const _show=snap.postMarketPrice&&snap.postMarketPrice!==snap.price&&_ms!=='open';if(!_show)return'';const _label=snap.marketState==='PRE'?'Pre-market':'After-hours';return`<div style="font-family:var(--mono);font-size:12px;color:${snap.postMarketPrice>snap.price?'var(--green)':'var(--red)'};margin-bottom:8px">${_label}: $${snap.postMarketPrice.toFixed(2)}${snap.postMarketChange?` <span style="font-size:11px">${snap.postMarketChange>=0?'+':''}${snap.postMarketChange.toFixed(2)} (${snap.postMarketChange>=0?'+':''}${snap.postMarketChangePct?.toFixed(2)||'0.00'}%)</span>`:''} <span style="font-size:10px;color:var(--text3)">(${snap.marketState||'extended'})</span></div>`;})()}
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
      <div class="metric-tile" style="grid-column:span 2"><div class="metric-label">IV Rank (approx)</div><div style="margin-top:4px">${ivr.badge||'N/A'}</div><div class="metric-sub" style="margin-top:4px;font-size:10px;line-height:1.4">${ivr.guidance}</div></div>
      ${impliedMoveStr!=='N/A'?`<div class="metric-tile" style="grid-column:span 2"><div class="metric-label">Implied Move (from options)</div><div class="metric-value" style="font-size:13px">${impliedMoveStr}</div><div class="metric-sub">ATM straddle-implied move. Use to gauge how far OTM your strike should be.</div></div>`:''}
    </div>
    ${earningsStr}
  </div>
  ${hist?`<div class="card"><div class="card-title"><span class="dot"></span>Bollinger Bands + RSI</div><div style="display:flex;gap:6px;margin-bottom:4px"><button class="btn btn-secondary" style="font-size:10px;padding:2px 8px" id="bb-btn-6m" onclick="toggleBBSpan(\'6m\')">6M</button><button class="btn btn-secondary" style="font-size:10px;padding:2px 8px;opacity:0.4" id="bb-btn-1y" onclick="toggleBBSpan(\'1y\')">1Y</button><button class="btn btn-secondary" style="font-size:10px;padding:2px 8px;opacity:0.4" id="bb-btn-2y" onclick="toggleBBSpan(\'2y\')">2Y</button></div><div class="chart-wrap" style="height:180px"><canvas id="bb-chart"></canvas></div><div class="chart-wrap" style="height:90px"><canvas id="rsi-chart"></canvas></div><div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:6px">${bbStr}</div><div class="commentary" style="margin-top:10px">Bollinger Bands: upper band touch = statistically extended, overbought. Lower band touch = oversold. Narrow bands signal compressed volatility.

RSI (14): below 30 (green shading) = oversold, favorable for puts. Above 70 (red shading) = overbought, favorable for covered calls.</div></div>`:''}
  ${(hist2y&&hist2ySP)?renderRelPerfCard(snap.ticker,hist2y,hist2ySP,earningsHistory):''}  ${hist1y?`<div class="card"><div class="card-title"><span class="dot" style="background:teal"></span>Volume Profile -- Support / Resistance (1Y)</div><div class="chart-wrap" style="height:300px"><canvas id="vp-chart"></canvas></div><div id="vp-analysis"></div></div>`:''}
  <div class="card"><div class="card-title"><span class="dot" style="background:var(--accent2)"></span>Recent News (7 days)</div><div id="news-section">${renderNewsItems(news)}</div></div>
  ${upgradesData&&upgradesData.length?buildUpgradeTable(upgradesData):''}
  ${snap.ptMean?buildPriceTargetCard(snap):''}
  ${snap.earningsTrend&&snap.earningsTrend.length?buildEarningsTrendCard(snap.earningsTrend):''}
  ${snap.recTrend&&snap.recTrend.length?buildRecTrendCard(snap.recTrend):''}`;
  if(bbData)renderBBChart(bbData,hist);
  if(hist1y)renderVPChart(hist1y,snap.price,snap.week52High,snap.week52Low);
  if(hist2y&&hist2ySP)_initRelPerfChart(snap.ticker,hist2y,hist2ySP,earningsHistory);
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
function toggleRelPerfEarnings(){
  S.set('rp_earnings_toggle',getRelPerfEarningsToggle()?'off':'on');
  // Re-render by triggering chart update
  const ctx=document.getElementById('rp-chart')?.getContext('2d');
  if(!ctx)return;
  const t=currentTicker;
  const h2c=S.get('hist2y_'+t);const h2=h2c?{timestamps:h2c.timestamps.map(d=>new Date(d*1000)),closes:h2c.closes}:null;
  const spc=S.get('hist2y_sp500');const sp=spc?{timestamps:spc.timestamps.map(d=>new Date(d*1000)),closes:spc.closes}:null;
  const ehc=S.get('earnings_hist_'+t);
  if(h2&&sp)renderRelPerfChart(t,h2,sp,ehc?.data||null);
  // Update button
  const btn=document.getElementById('rp-earn-btn');
  if(btn)btn.style.opacity=getRelPerfEarningsToggle()?'1':'0.4';
}

function renderRelPerfCard(ticker,hist2y,hist2ySP,earningsHistory){
  const earnToggleOpacity=getRelPerfEarningsToggle()?'1':'0.4';
  return `<div class="card">
    <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
      <span><span class="dot" style="background:var(--accent)"></span>Relative Performance vs S&P 500 (2Y)</span>
      <button id="rp-earn-btn" class="btn btn-secondary" style="font-size:10px;padding:2px 8px;opacity:${earnToggleOpacity}" onclick="toggleRelPerfEarnings()">Earnings</button>
    </div>
    <div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-bottom:6px">Both indexed to 100 at start of 2-year window. Above 100 = outperforming S&P 500.</div>
    <div class="chart-wrap" style="height:200px"><canvas id="rp-chart"></canvas></div>
    <div id="rp-legend" style="display:flex;gap:12px;margin-top:6px">
      <div style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:2px;background:var(--accent)"></span><span style="font-family:var(--mono);font-size:9px;color:var(--text3)">${ticker}</span></div>
      <div style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:2px;background:#8b8fa8"></span><span style="font-family:var(--mono);font-size:9px;color:var(--text3)">S&P 500</span></div>
      ${earningsHistory?.length?'<div style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:2px;height:12px;background:rgba(255,165,2,0.7)"></span><span style="font-family:var(--mono);font-size:9px;color:var(--text3)">Earnings</span></div>':''}
    </div>
  </div>`;
}

function renderRelPerfChart(ticker,hist2y,hist2ySP,earningsHistory){
  const ctx=document.getElementById('rp-chart')?.getContext('2d');
  if(!ctx)return;

  // Align series by date -- find common date range
  const _toDateStr=d=>{
    if(d instanceof Date)return d.toISOString().split('T')[0];
    // Stored as Unix seconds -- multiply by 1000
    return new Date(d*1000).toISOString().split('T')[0];
  };
  const stockDates=hist2y.timestamps.map(_toDateStr);
  const spDates=hist2ySP.timestamps.map(_toDateStr);

  // Build date-keyed maps
  const stockMap={};stockDates.forEach((d,i)=>{if(hist2y.closes[i]!=null)stockMap[d]=hist2y.closes[i];});
  const spMap={};spDates.forEach((d,i)=>{if(hist2ySP.closes[i]!=null)spMap[d]=hist2ySP.closes[i];});

  // Common dates only
  const commonDates=stockDates.filter(d=>stockMap[d]!=null&&spMap[d]!=null).sort();
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
  const earningsDates=new Set();
  if(showEarnings&&earningsHistory?.length){
    earningsHistory.forEach(e=>{if(e.date)earningsDates.add(e.date);});
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
      // Earnings vertical lines
      if(earningsDates.size>0){
        commonDates.forEach((d,i)=>{
          if(!earningsDates.has(d))return;
          const xPx=xs.getPixelForValue(i);
          c.strokeStyle='rgba(255,165,2,0.6)';
          c.lineWidth=1;
          c.beginPath();c.moveTo(xPx,ys.top);c.lineTo(xPx,ys.bottom);c.stroke();
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
function _initRelPerfChart(ticker,hist2y,hist2ySP,earningsHistory){
  if(hist2y&&hist2ySP)renderRelPerfChart(ticker,hist2y,hist2ySP,earningsHistory);
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
    // Step 2: Yahoo quote for forwardPE and EPS
    setP(20,'Fetching '+t+' extended quote...');
    try{const ah=await fetchAfterHoursPrice(t);if(ah){snap.postMarketPrice=ah.postMarketPrice;snap.postMarketChange=ah.postMarketChange||null;snap.postMarketChangePct=ah.postMarketChangePct||null;snap.marketState=ah.marketState;snap.peForward=ah.forwardPE||null;if(ah.trailingEps!=null)snap.epsTTM=ah.trailingEps;if(ah.intradayVolume!=null)snap.intradayVolume=ah.intradayVolume;
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
