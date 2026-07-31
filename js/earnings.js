// Income Engine -- earnings.js
// Earnings tab: load, render cards, filter.
// Globals used: watchlist, earningsDaysFilter, earningsAllData, WORKER_URL, S
// Dependencies: helpers.js, api.js, storage.js

function filterEarnings(days,chipEl){earningsDaysFilter=days;document.querySelectorAll('#earnings-filter-chips .exp-chip').forEach(c=>c.classList.remove('selected'));chipEl.classList.add('selected');renderEarningsCards();}

// Counts the current consecutive beat or miss streak from a list of
// {epsActual, epsEstimate} entries sorted most-recent-first. Mutually
// exclusive -- whichever direction the most recent quarter went, count
// consecutive quarters in that same direction, stopping at the first
// quarter that breaks it. Shared by both the Upcoming and Recent views so
// they can't independently drift apart the way two separate copies of this
// logic did earlier (see prefetch.js/ticker.js earnings-history history).
function _computeBeatMissStreak(actuals){
  let beatStreak=0,missStreak=0;
  if(actuals.length){
    const mostRecentBeat=actuals[0].epsActual>actuals[0].epsEstimate;
    for(const q of actuals){
      const beat=q.epsActual>q.epsEstimate;
      if(beat!==mostRecentBeat)break;
      if(beat)beatStreak++;else missStreak++;
    }
  }
  return{beatStreak,missStreak};
}

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
// True once current time is past 4:00pm ET (US market close). Used only to
// gate same-day entries in Recent -- a single uniform floor regardless of
// BMO/AMC timing, per the agreed simplification (not trying to distinguish
// "has this specific ticker's report actually happened yet").
function _isPastMarketCloseET(){
  try{
    const now=new Date();
    const etFmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'numeric',hour12:false});
    const parts=etFmt.formatToParts(now);
    const etHour=parseInt(parts.find(p=>p.type==='hour').value);
    const etMin=parseInt(parts.find(p=>p.type==='minute').value);
    return(etHour*60+etMin)>=16*60; // 4:00pm ET
  }catch{return true;} // fail open -- don't hide data on an error here
}

function buildRecentEarningsData(){
  const today=_todayETStart();
  const todayStr=_todayET();
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
        if(d<cutoff)return false;
        if(c.date===todayStr)return _isPastMarketCloseET(); // same-day: only after close
        return d<today;
      }).sort((a,b)=>b.date.localeCompare(a.date));
      if(!recentDates.length)return;
      const mostRecent=recentDates[0];

      const snap=S.get('snap_'+t);
      if(!snap)return;

      // EPS actual/estimate/surprise, beat/miss streak -- same computation as
      // the Upcoming view, from Yahoo's earningsHistory
      let epsActual=null,epsEstimate=null,surprisePct=null;
      const eh=(snap.earningsHistoryYahoo||[]).filter(e=>e.date).sort((a,b)=>b.date.localeCompare(a.date));
      const prevEh=eh.find(e=>e.epsActual!=null);
      if(prevEh){epsActual=prevEh.epsActual;epsEstimate=prevEh.epsEstimate;surprisePct=prevEh.surprisePercent;}
      const actuals=eh.filter(e=>e.epsActual!=null&&e.epsEstimate!=null);
      const{beatStreak,missStreak}=_computeBeatMissStreak(actuals);

      // Price reaction + excess vs S&P -- reusing the same per-event
      // computation that powers the ticker page's relative-performance card
      let reactionPct=null,excessReaction=null,preAnnouncementPrice=null;
      try{
        const h2=S.get('hist2y_'+t);
        const earningsHistoryForChart=S.get('earnings_hist_'+t)?.data||[];
        const events=_computeEarningsReactionEvents(h2,hist2ySP,earningsHistoryForChart);
        const match=events&&events.find(ev=>Math.abs(new Date(ev.date)-new Date(mostRecent.date))<4*86400000);
        if(match){reactionPct=match.reactionPct;excessReaction=match.excessReaction;preAnnouncementPrice=match.preAnnouncementPrice;}
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
      // daysAgo is a user-facing label ("Today"/"Yesterday"/"3 days ago") --
      // deliberately uses _todayLocal() (tzPref) here, not the ET-anchored
      // `today` used above for the market-close gate. Those are correctness-
      // critical and tied to when the market actually closes; this is purely
      // about what day it is on the user's own clock. Pure calendar-day
      // string difference, not instant-based arithmetic, so it isn't
      // sensitive to time-of-day at all.
      const daysAgo=Math.round((new Date(_todayLocal()+'T00:00:00Z')-new Date(mostRecent.date+'T00:00:00Z'))/86400000);

      results.push({
        ticker:t,snap,earningsDate:mostRecent.date,earningsHour:mostRecent.hour,daysAgo,
        epsActual,epsEstimate,surprisePct,beatStreak,missStreak,reactionPct,excessReaction,hvrAtReport,hasPositions,preAnnouncementPrice
      });
    }catch{}
  });

  results.sort((a,b)=>a.daysAgo-b.daysAgo); // most recent first
  return results;
}

// Mini price sparkline showing daily closes from the earnings date through
// today -- shape only, no price labels or axis. Visually styled to match
// the Watchlist card's intraday sparkline (_sparklineHtml in watchlist.js),
// but this is an entirely separate function/data source (hist2y_ daily
// closes sliced by date, not intraday_ 5-minute bars) -- watchlist.js is
// not touched by this at all. Each card's line naturally spans a different
// number of days depending on how recently that ticker reported; the fixed
// SVG width is intentional, not a bug.
function _recentEarningsSparklineHtml(ticker,earningsDate,preAnnouncementPrice){
  try{
    const h2=S.get('hist2y_'+ticker);
    if(!h2?.closes?.length)return'';
    const startTs=Math.floor(new Date(earningsDate+'T00:00:00Z').getTime()/1000);
    const pts2=[];
    if(preAnnouncementPrice!=null)pts2.push(preAnnouncementPrice); // true pre-report anchor, so the initial reaction shows as part of the shape
    h2.timestamps.forEach((ts,i)=>{
      if(ts>=startTs&&h2.closes[i]!=null)pts2.push(h2.closes[i]);
    });
    if(pts2.length<2)return'';

    const first=pts2[0],last=pts2[pts2.length-1];
    const color=last>=first?'var(--green)':'var(--red)';

    const W=60,H=20,PAD=1;
    const mn=Math.min(...pts2),mx=Math.max(...pts2);
    const range=mx-mn||1;
    const toY=v=>H-PAD-((v-mn)/range)*(H-PAD*2);
    const toX=i=>PAD+(i/(pts2.length-1))*(W-PAD*2);
    const pts=pts2.map((v,i)=>toX(i).toFixed(1)+','+toY(v).toFixed(1)).join(' ');

    const refLine=`<line x1="${PAD}" y1="${toY(first).toFixed(1)}" x2="${W-PAD}" y2="${toY(first).toFixed(1)}" stroke="var(--text3)" stroke-width="0.7" stroke-dasharray="2,2" opacity="0.6"/>`;

    return '<svg width="60" height="20" viewBox="0 0 60 20" style="display:block;flex-shrink:0" xmlns="http://www.w3.org/2000/svg">'+
      refLine+
      '<polyline points="'+pts+'" fill="none" stroke="'+color+'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>'+
    '</svg>';
  }catch{return'';}
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
    const missBadge=e.missStreak>=2?`<span style="font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(255,71,87,0.2);color:var(--red)">Missed ${e.missStreak}Q</span>`:'';
    const posBadge=e.hasPositions?`<span style="font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(124,106,247,0.2);color:#b39ddb">You hold this</span>`:'';
    const reactionStr=e.reactionPct!=null?`<div><span style="color:var(--text3);font-size:9px;display:block">PRICE REACTION</span><span style="color:${e.reactionPct>=0?'var(--green)':'var(--red)'}">${e.reactionPct>=0?'+':''}${e.reactionPct.toFixed(1)}%</span></div>`:'';
    const excessStr=e.excessReaction!=null?`<div><span style="color:var(--text3);font-size:9px;display:block">VS S&amp;P</span><span style="color:${e.excessReaction>=0?'var(--green)':'var(--red)'}">${e.excessReaction>=0?'+':''}${e.excessReaction.toFixed(1)}%</span></div>`:'';
    const hvrStr=e.hvrAtReport!=null?`<div><span style="color:var(--text3);font-size:9px;display:block">HVR AT REPORT</span>${e.hvrAtReport.toFixed(0)}</div>`:'';
    const preStr=e.preAnnouncementPrice!=null?`<div><span style="color:var(--text3);font-size:9px;display:block">PRICE BEFORE</span>$${e.preAnnouncementPrice.toFixed(2)}</div>`:'';
    const spark=_recentEarningsSparklineHtml(e.ticker,e.earningsDate,e.preAnnouncementPrice);
    return`<div class="${cardCls}" onclick="navigateToTicker('${e.ticker}')">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:8px"><span style="font-family:var(--sans);font-size:20px;font-weight:700;color:var(--accent)">${e.ticker}</span>${e.snap.price?`<span style="font-family:var(--mono);font-size:13px;color:var(--text2)">$${e.snap.price.toFixed(2)}</span>`:''}${spark}</div>
        <div style="text-align:right"><div style="font-family:var(--mono);font-size:11px;font-weight:600;color:var(--text2)">${agoLabel}</div><div style="font-family:var(--mono);font-size:11px;color:var(--text2)">${e.earningsDate}${timing}</div></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">${beatBadge}${streakBadge}${missBadge}${posBadge}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:6px;font-family:var(--mono);font-size:11px">
        <div><span style="color:var(--text3);font-size:9px;display:block">EPS ACTUAL</span>${e.epsActual!==null?`$${e.epsActual.toFixed(2)}`:'N/A'}</div>
        <div><span style="color:var(--text3);font-size:9px;display:block">EPS ESTIMATE</span>${e.epsEstimate!==null?`$${e.epsEstimate.toFixed(2)}`:'N/A'}</div>
        ${preStr}
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
      const snap=S.get('snap_'+t);
      let _effEarningsDate=snap?.earningsDate,_effEarningsHour=snap?.earningsHour;
      if(snap&&!_effEarningsDate){
        // snap.earningsDate can come back empty if the live Finnhub calendar
        // has already stopped listing today's date once the event has
        // occurred, even same-day. Fall back to the confirmed/pending caches
        // for a same-day match so the ticker doesn't silently drop out of
        // Upcoming on the very day it reports.
        const _todayStr=_todayET();
        const _confMatch=(S.get('earnings_confirmed_'+t)||[]).find(c=>c.date===_todayStr);
        const _pendMatch=(S.get('earnings_pending_'+t)||[]).find(p=>p.date===_todayStr);
        const _fallback=_confMatch||_pendMatch;
        if(_fallback){_effEarningsDate=_fallback.date;_effEarningsHour=_fallback.hour||null;}
      }
      if(!snap||!_effEarningsDate)continue;
      // Use timezone-safe date comparison -- daysUntilDate compares calendar dates in local TZ
      // so a BMO ticker on earnings day doesn't vanish at night when UTC crosses midnight
      const du=daysUntilDate(_effEarningsDate);if(du===null||du<0)continue;
      const ed=new Date(_effEarningsDate+'T12:00:00Z'); // noon UTC for safe arithmetic
      let epsEst=null,epsActualPrev=null,surprisePrev=null,beatStreak=0,missStreak=0;
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
        ({beatStreak,missStreak}=_computeBeatMissStreak(actuals));
      }catch{}
      // Upcoming EPS estimate: Yahoo earningsTrend (forward-looking, already fetched via quoteSummary)
      if(epsEst===null){try{const et=snap.earningsTrend;if(et&&et.length){const cur=et.find(p=>p.period==='0q')||et[0];if(cur?.epsMean!=null)epsEst=cur.epsMean;}}catch{}}
      let news=[];try{const cn=S.get('news_'+t);if(cn)news=cn.items;else{news=await fetchNews(t);S.set('news_'+t,{items:(news||[]).slice(0,10).map(n=>({headline:n.headline,summary:n.summary?n.summary.slice(0,200):null,url:n.url,source:n.source,datetime:n.datetime,sentiment:n.sentiment})),ts:nowPT()});}}catch{}
      const ivrVal=computeIVR(t,snap.week52High,snap.week52Low,snap.price);const ivr=ivrInfo(ivrVal);
      let impliedMove=null;try{const oc=S.get('options_'+t);const res=oc?.data?.optionChain?.result?.[0];if(res&&snap.price){const opts=res.options?.[0];const atmP=(opts?.puts||[]).filter(p=>Math.abs(p.strike-snap.price)/snap.price<0.03);const atmC=(opts?.calls||[]).filter(c=>Math.abs(c.strike-snap.price)/snap.price<0.03);if(atmP.length&&atmC.length){const straddle=((atmP[0].bid+atmP[0].ask)/2)+((atmC[0].bid+atmC[0].ask)/2);impliedMove=(straddle/snap.price*100).toFixed(1);}}}catch{}
      const daysUntil=du; // already computed above via daysUntilDate
      earningsAllData.push({ticker:t,snap,earningsDate:_effEarningsDate,earningsHour:_effEarningsHour,daysUntil,epsEst,epsActualPrev,surprisePrev,beatStreak,missStreak,ivrVal,ivrBadge:ivr.badge,impliedMove,news:news.slice(0,3)});
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
    else if(e.daysUntil<=35){guidance='Earnings in 2-5 weeks. Confirm your expirations do not straddle this date. ';if(e.beatStreak>=3)guidance+='Strong beat streak -- put selling may be favorable on post-announcement pullbacks. ';if(e.missStreak>=2)guidance+='Recent miss streak -- elevated event risk, consider wider strikes or avoiding this name around earnings. ';}
    else{guidance='Earnings far enough out that near-term options are generally safe. ';if(e.impliedMove)guidance+=`Market implies +/-${e.impliedMove}% move on earnings day.`;}
    const newsHtml=e.news?.length?e.news.map(n=>{const s=newsSentiment(n.headline);return`<div style="font-family:var(--mono);font-size:10px;color:var(--text2);margin-bottom:3px"><span style="${s.css}">${sentDot(s)}</span> ${n.headline.slice(0,80)}...</div>`;}).join(''):'';
    return`<div class="${cardCls}" onclick="navigateToTicker('${e.ticker}')">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div><span style="font-family:var(--sans);font-size:20px;font-weight:700;color:var(--accent)">${e.ticker}</span>${e.snap.price?`<span style="font-family:var(--mono);font-size:13px;color:var(--text2);margin-left:8px">$${e.snap.price.toFixed(2)}</span>`:''}</div>
        <div style="text-align:right"><div style="font-family:var(--mono);font-size:11px;font-weight:600;color:var(--warn)">${urgency}</div><div style="font-family:var(--mono);font-size:11px;color:var(--text2)">${e.earningsDate}${timing}</div></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">${e.ivrBadge||''}${e.impliedMove?`<span style="font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(124,106,247,0.2);color:#b39ddb">Implied +/-${e.impliedMove}%</span>`:''}${e.beatStreak>=2?`<span style="font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(0,200,150,0.2);color:var(--green)">Beat ${e.beatStreak}Q</span>`:''}${e.missStreak>=2?`<span style="font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(255,71,87,0.2);color:var(--red)">Missed ${e.missStreak}Q</span>`:''}</div>
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
