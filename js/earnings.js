// Income Engine -- earnings.js
// Earnings tab: load, render cards, filter.
// Globals used: watchlist, earningsDaysFilter, earningsAllData, WORKER_URL, S
// Dependencies: helpers.js, api.js, storage.js

function filterEarnings(days,chipEl){earningsDaysFilter=days;document.querySelectorAll('#earnings-filter-chips .exp-chip').forEach(c=>c.classList.remove('selected'));chipEl.classList.add('selected');renderEarningsCards();}

// ── Upcoming / Recent view toggle ─────────────────────────────────────────────
let earningsViewMode = S.get('earnings_view_mode')||'upcoming';
const RECENT_EARNINGS_WINDOW_DAYS = 45;

function setEarningsViewMode(mode){
  earningsViewMode = mode;
  S.set('earnings_view_mode', mode);
  _syncEarningsViewModeUI();
  if(mode==='recent') renderRecentEarningsCards();
  else renderEarningsCards();
}

function _syncEarningsViewModeUI(){
  const upBtn=document.getElementById('earnings-view-upcoming'),recBtn=document.getElementById('earnings-view-recent');
  if(upBtn)upBtn.style.opacity = earningsViewMode==='upcoming'?'1':'0.4';
  if(recBtn)recBtn.style.opacity = earningsViewMode==='recent'?'1':'0.4';
  const chipsWrap=document.getElementById('earnings-upcoming-chips-wrap');
  if(chipsWrap)chipsWrap.style.display = earningsViewMode==='upcoming'?'':'none';
  const subtitle=document.getElementById('earnings-subtitle');
  if(subtitle)subtitle.textContent = earningsViewMode==='upcoming'
    ? 'Sorted by upcoming earnings date. Tap any card to analyze.'
    : `Reports from the last ${RECENT_EARNINGS_WINDOW_DAYS} days, most recent first. Tap any card to analyze.`;
}

// Renders whichever view is currently active -- used by the tab-switch
// handler so it doesn't always default to Upcoming regardless of the
// persisted mode.
function renderCurrentEarningsView(isLive=false){
  _syncEarningsViewModeUI();
  if(earningsViewMode==='recent')renderRecentEarningsCards();
  else renderEarningsCards(isLive);
}

// Builds recent-earnings summary data entirely from data already cached by
// the normal prefetch/refresh cycle -- no new fetches, fully synchronous.
// Reuses: earnings_confirmed_ (dates), snap.earningsHistoryYahoo (EPS/surprise),
// _computeEarningsReactionEvents (price reaction, shared with the ticker
// page's relative-performance card), computeHVRSeries (HVR history, shared
// with the ticker page's HVR chart), and _getIncomePositionsForTicker
// (position flag, shared with the Watchlist/Ticker "View Positions" feature).
function buildRecentEarningsData(){
  const today=new Date();today.setHours(0,0,0,0);
  const cutoff=new Date(today);cutoff.setDate(cutoff.getDate()-RECENT_EARNINGS_WINDOW_DAYS);
  const useTR=typeof getRPTotalReturn==='function'&&getRPTotalReturn();
  const spKey=useTR?'hist2y_sp500tr':'hist2y_sp500';
  const sp2c=S.get(spKey)||(useTR?S.get('hist2y_sp500'):null);
  const hist2ySP=sp2c?{timestamps:sp2c.timestamps,closes:sp2c.closes}:null;

  const results=[];
  watchlist.forEach(t=>{
    try{
      const confirmed=S.get('earnings_confirmed_'+t)||[];
      const recentDates=confirmed.filter(c=>{
        if(!c.date)return false;
        const d=new Date(c.date+'T12:00:00Z');
        return d>=cutoff&&d<today;
      }).sort((a,b)=>b.date.localeCompare(a.date));
      if(!recentDates.length)return;
      const mostRecent=recentDates[0];

      const snap=S.get('snap_'+t);
      if(!snap)return;

      // EPS actual/estimate/surprise, beat streak -- same computation as
      // the Upcoming view, from Yahoo's earningsHistory
      let epsActual=null,epsEstimate=null,surprisePct=null,beatStreak=0;
      const eh=(snap.earningsHistoryYahoo||[]).filter(e=>e.date).sort((a,b)=>b.date.localeCompare(a.date));
      const prevEh=eh.find(e=>e.epsActual!=null);
      if(prevEh){epsActual=prevEh.epsActual;epsEstimate=prevEh.epsEstimate;surprisePct=prevEh.surprisePercent;}
      const actuals=eh.filter(e=>e.epsActual!=null&&e.epsEstimate!=null);
      for(const q of actuals){if(q.epsActual>q.epsEstimate)beatStreak++;else break;}

      // Price reaction + excess vs S&P -- reusing the same per-event
      // computation that powers the ticker page's relative-performance card
      let reactionPct=null,excessReaction=null;
      try{
        const h2=S.get('hist2y_'+t);
        const earningsHistoryForChart=S.get('earnings_hist_'+t)?.data||[];
        const events=_computeEarningsReactionEvents(h2,hist2ySP,earningsHistoryForChart);
        const match=events&&events.find(ev=>Math.abs(new Date(ev.date)-new Date(mostRecent.date))<4*86400000);
        if(match){reactionPct=match.reactionPct;excessReaction=match.excessReaction;}
      }catch{}

      // HVR at the time of the report -- reusing the same series already
      // computed for the ticker page's HVR chart, looked up at the matching date
      let hvrAtReport=null;
      try{
        const series=computeHVRSeries(t);
        if(series?.timestamps?.length){
          const targetTs=Math.floor(new Date(mostRecent.date+'T12:00:00Z').getTime()/1000);
          let bestIdx=-1,bestDiff=Infinity;
          series.timestamps.forEach((ts,i)=>{const diff=Math.abs(ts-targetTs);if(diff<bestDiff){bestDiff=diff;bestIdx=i;}});
          if(bestIdx>=0&&bestDiff<=5*86400)hvrAtReport=series.values[bestIdx];
        }
      }catch{}

      const hasPositions=typeof _getIncomePositionsForTicker==='function'&&_getIncomePositionsForTicker(t).length>0;
      const daysAgo=Math.round((today-new Date(mostRecent.date+'T12:00:00Z'))/86400000);

      results.push({
        ticker:t,snap,earningsDate:mostRecent.date,earningsHour:mostRecent.hour,daysAgo,
        epsActual,epsEstimate,surprisePct,beatStreak,reactionPct,excessReaction,hvrAtReport,hasPositions
      });
    }catch{}
  });

  results.sort((a,b)=>a.daysAgo-b.daysAgo); // most recent first
  return results;
}

function renderRecentEarningsCards(){
  const el=document.getElementById('earnings-content');
  const data=buildRecentEarningsData();
  if(!data.length){el.innerHTML=`<div class="empty"><div class="empty-icon">&#x1F4C5;</div>No earnings reports in the last ${RECENT_EARNINGS_WINDOW_DAYS} days for your watchlist.</div>`;return;}
  el.innerHTML=data.map(e=>{
    const isFresh=e.daysAgo<=5;
    const cardCls='earnings-card earnings-card-normal';
    const timing=e.earningsHour==='bmo'?' (before open)':e.earningsHour==='amc'?' (after close)':'';
    const agoLabel=(e.daysAgo===0?'Today':e.daysAgo===1?'Yesterday':e.daysAgo+' days ago')+(isFresh?' &#x1F195;':'');
    const beatBadge=e.surprisePct!=null?`<span style="font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:4px;background:${e.surprisePct>=0?'rgba(0,200,150,0.2)':'rgba(255,71,87,0.2)'};color:${e.surprisePct>=0?'var(--green)':'var(--red)'}">${e.surprisePct>=0?'Beat':'Missed'} ${Math.abs(e.surprisePct).toFixed(1)}%</span>`:'';
    const streakBadge=e.beatStreak>=2?`<span style="font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(0,200,150,0.2);color:var(--green)">Beat ${e.beatStreak}Q</span>`:'';
    const posBadge=e.hasPositions?`<span style="font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(124,106,247,0.2);color:#b39ddb">You hold this</span>`:'';
    const reactionStr=e.reactionPct!=null?`<div><span style="color:var(--text3);font-size:9px;display:block">PRICE REACTION</span><span style="color:${e.reactionPct>=0?'var(--green)':'var(--red)'}">${e.reactionPct>=0?'+':''}${e.reactionPct.toFixed(1)}%</span></div>`:'';
    const excessStr=e.excessReaction!=null?`<div><span style="color:var(--text3);font-size:9px;display:block">VS S&amp;P</span><span style="color:${e.excessReaction>=0?'var(--green)':'var(--red)'}">${e.excessReaction>=0?'+':''}${e.excessReaction.toFixed(1)}%</span></div>`:'';
    const hvrStr=e.hvrAtReport!=null?`<div><span style="color:var(--text3);font-size:9px;display:block">HVR AT REPORT</span>${e.hvrAtReport.toFixed(0)}</div>`:'';
    return`<div class="${cardCls}" onclick="navigateToTicker('${e.ticker}')">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div><span style="font-family:var(--sans);font-size:20px;font-weight:700;color:var(--accent)">${e.ticker}</span>${e.snap.price?`<span style="font-family:var(--mono);font-size:13px;color:var(--text2);margin-left:8px">$${e.snap.price.toFixed(2)}</span>`:''}</div>
        <div style="text-align:right"><div style="font-family:var(--mono);font-size:11px;font-weight:600;color:var(--text2)">${agoLabel}</div><div style="font-family:var(--mono);font-size:11px;color:var(--text2)">${e.earningsDate}${timing}</div></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">${beatBadge}${streakBadge}${posBadge}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:6px;font-family:var(--mono);font-size:11px">
        <div><span style="color:var(--text3);font-size:9px;display:block">EPS ACTUAL</span>${e.epsActual!==null?`$${e.epsActual.toFixed(2)}`:'N/A'}</div>
        <div><span style="color:var(--text3);font-size:9px;display:block">EPS ESTIMATE</span>${e.epsEstimate!==null?`$${e.epsEstimate.toFixed(2)}`:'N/A'}</div>
        ${hvrStr}
        ${reactionStr}
        ${excessStr}
      </div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:8px;text-align:right">Tap to analyze</div>
    </div>`;
  }).join('');
}

async function loadEarningsTab(){
  if(!navigator.onLine&&!offlineMode){toast('Offline -- earnings data unchanged',3000);renderEarningsCards();return;}
  if(offlineMode){renderEarningsCards();return;}
  const el=document.getElementById('earnings-content');
  el.innerHTML='<div class="card"><div style="display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--text2)"><div class="spinner"></div>Loading earnings data...</div></div>';
  earningsAllData=[];
  for(let i=0;i<watchlist.length;i++){
    const t=watchlist[i];
    try{
      const snap=S.get('snap_'+t);if(!snap?.earningsDate)continue;
      // Use timezone-safe date comparison -- daysUntilDate compares calendar dates in local TZ
      // so a BMO ticker on earnings day doesn't vanish at night when UTC crosses midnight
      const du=daysUntilDate(snap.earningsDate);if(du===null||du<0)continue;
      const ed=new Date(snap.earningsDate+'T12:00:00Z'); // noon UTC for safe arithmetic
      let epsEst=null,epsActualPrev=null,surprisePrev=null,beatStreak=0;
      try{
        // NOTE: eh.date is Yahoo's fiscal PERIOD-END date (e.g. quarter close),
        // not the earnings ANNOUNCEMENT date -- do not mine it into
        // earnings_confirmed_ (that cache specifically needs report dates,
        // which come from the Finnhub calendar endpoint instead). Only the
        // EPS actual/estimate/surprise values are used here.
        const eh=(snap.earningsHistoryYahoo||[]).filter(e=>e.date).sort((a,b)=>b.date.localeCompare(a.date));
        const prev=eh.find(e=>e.epsActual!=null);
        if(prev){epsActualPrev=prev.epsActual;surprisePrev=prev.surprisePercent;}
        const actuals=eh.filter(e=>e.epsActual!=null&&e.epsEstimate!=null);
        for(const q of actuals){if(q.epsActual>q.epsEstimate)beatStreak++;else break;}
      }catch{}
      // Upcoming EPS estimate: Yahoo earningsTrend (forward-looking, already fetched via quoteSummary)
      if(epsEst===null){try{const et=snap.earningsTrend;if(et&&et.length){const cur=et.find(p=>p.period==='0q')||et[0];if(cur?.epsMean!=null)epsEst=cur.epsMean;}}catch{}}
      let news=[];try{const cn=S.get('news_'+t);if(cn)news=cn.items;else{news=await fetchNews(t);S.set('news_'+t,{items:(news||[]).slice(0,10).map(n=>({headline:n.headline,summary:n.summary?n.summary.slice(0,200):null,url:n.url,source:n.source,datetime:n.datetime,sentiment:n.sentiment})),ts:nowPT()});}}catch{}
      const ivrVal=computeIVR(t,snap.week52High,snap.week52Low,snap.price);const ivr=ivrInfo(ivrVal);
      let impliedMove=null;try{const oc=S.get('options_'+t);const res=oc?.data?.optionChain?.result?.[0];if(res&&snap.price){const opts=res.options?.[0];const atmP=(opts?.puts||[]).filter(p=>Math.abs(p.strike-snap.price)/snap.price<0.03);const atmC=(opts?.calls||[]).filter(c=>Math.abs(c.strike-snap.price)/snap.price<0.03);if(atmP.length&&atmC.length){const straddle=((atmP[0].bid+atmP[0].ask)/2)+((atmC[0].bid+atmC[0].ask)/2);impliedMove=(straddle/snap.price*100).toFixed(1);}}}catch{}
      const daysUntil=du; // already computed above via daysUntilDate
      earningsAllData.push({ticker:t,snap,earningsDate:snap.earningsDate,earningsHour:snap.earningsHour,daysUntil,epsEst,epsActualPrev,surprisePrev,beatStreak,ivrVal,ivrBadge:ivr.badge,impliedMove,news:news.slice(0,3)});
    }catch{}
    if(i<watchlist.length-1)await sleep(400);
  }
  earningsAllData.sort((a,b)=>a.daysUntil-b.daysUntil);
  S.set('earnings_data',{data:earningsAllData,ts:nowPT()});
  renderCurrentEarningsView(true);
}

function renderEarningsCards(isLive=false){
  const el=document.getElementById('earnings-content');const today=new Date();
  let data=earningsAllData;
  if(!data.length){const cached=S.get('earnings_data');if(cached?.data){data=cached.data.map(e=>({...e,daysUntil:daysUntilDate(e.earningsDate)??Math.round((new Date(e.earningsDate)-today)/86400000)})).filter(e=>e.daysUntil>=0);earningsAllData=data;}}
  const filtered=data.filter(e=>e.daysUntil<=earningsDaysFilter);
  if(!filtered.length){el.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4C5;</div>No upcoming earnings in this window. Press Refresh or run Full Refresh.</div>';return;}
  const ts=S.get('earnings_data')?.ts||nowPT();
  el.innerHTML=tsChip(ts,isLive)+filtered.map(e=>{
    const cardCls=e.daysUntil<=7?'earnings-card earnings-card-urgent':e.daysUntil<=21?'earnings-card earnings-card-soon':'earnings-card earnings-card-normal';
    const timing=e.earningsHour==='bmo'?' (before open)':e.earningsHour==='amc'?' (after close)':'';
    const urgency=e.daysUntil===0?'TODAY':e.daysUntil===1?'TOMORROW':'In '+e.daysUntil+' days';
    let guidance='';
    if(e.daysUntil<=14){guidance='Earnings within 2 weeks -- avoid options expirations that straddle this date. ';if(e.ivrVal&&e.ivrVal>60)guidance+='IV elevated ahead of earnings -- go wider OTM if selling options. ';guidance+='Consider waiting until after the announcement for IV crush to remove event risk.';}
    else if(e.daysUntil<=35){guidance='Earnings in 2-5 weeks. Confirm your expirations do not straddle this date. ';if(e.beatStreak>=3)guidance+='Strong beat streak -- put selling may be favorable on post-announcement pullbacks. ';}
    else{guidance='Earnings far enough out that near-term options are generally safe. ';if(e.impliedMove)guidance+=`Market implies +/-${e.impliedMove}% move on earnings day.`;}
    const newsHtml=e.news?.length?e.news.map(n=>{const s=newsSentiment(n.headline);return`<div style="font-family:var(--mono);font-size:10px;color:var(--text2);margin-bottom:3px"><span style="${s.css}">${sentDot(s)}</span> ${n.headline.slice(0,80)}...</div>`;}).join(''):'';
    return`<div class="${cardCls}" onclick="navigateToTicker('${e.ticker}')">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div><span style="font-family:var(--sans);font-size:20px;font-weight:700;color:var(--accent)">${e.ticker}</span>${e.snap.price?`<span style="font-family:var(--mono);font-size:13px;color:var(--text2);margin-left:8px">$${e.snap.price.toFixed(2)}</span>`:''}</div>
        <div style="text-align:right"><div style="font-family:var(--mono);font-size:11px;font-weight:600;color:var(--warn)">${urgency}</div><div style="font-family:var(--mono);font-size:11px;color:var(--text2)">${e.earningsDate}${timing}</div></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">${e.ivrBadge||''}${e.impliedMove?`<span style="font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(124,106,247,0.2);color:#b39ddb">Implied +/-${e.impliedMove}%</span>`:''}${e.beatStreak>=2?`<span style="font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(0,200,150,0.2);color:var(--green)">Beat ${e.beatStreak}Q</span>`:''}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;font-family:var(--mono);font-size:11px">
        <div><span style="color:var(--text3);font-size:9px;display:block">EPS ESTIMATE</span>${e.epsEst!==null?`$${e.epsEst.toFixed(2)}`:'N/A'}</div>
        <div><span style="color:var(--text3);font-size:9px;display:block">PRIOR ACTUAL</span>${e.epsActualPrev!==null?`$${e.epsActualPrev.toFixed(2)}`:'N/A'}</div>
        ${e.surprisePrev!==null?`<div style="grid-column:span 2"><span style="color:${e.surprisePrev>0?'var(--green)':'var(--red)'}">${e.surprisePrev>0?'+':''}${e.surprisePrev.toFixed(1)}% surprise last Q</span></div>`:''}
        ${e.snap.shortRatio?`<div><span style="color:var(--text3);font-size:9px;display:block">SHORT RATIO</span>${e.snap.shortRatio.toFixed(1)}d</div>`:''}
        ${e.snap.beta?`<div><span style="color:var(--text3);font-size:9px;display:block">BETA</span>${e.snap.beta.toFixed(2)}</div>`:''}
      </div>
      <div class="commentary" style="margin-bottom:8px;font-size:10px">${guidance}</div>
      ${newsHtml?`<div style="border-top:1px solid rgba(255,255,255,0.05);padding-top:8px;margin-top:4px">${newsHtml}</div>`:''}
      <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:8px;text-align:right">Tap to analyze</div>
    </div>`;
  }).join('');
}
