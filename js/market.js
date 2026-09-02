// ═══ MARKET TAB with T-BILL YIELDS ═══
function _mktTimeout(p,ms,label){return Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error('Timeout: '+label)),ms))]);}
let currentTBillSpan='1y'; // T-bill chart timeframe toggle (3m/6m/1y)
// Shared by loadMarketTab (live) and _renderMarketFromCache (cached) --
// previously defined identically in both places.
function fmtChg(val,chg,chgPct){if(!val)return'N/A';const color=chg>=0?'var(--green)':'var(--red)';const sign=chg>=0?'+':'';return`${val.toFixed(2)} <span style="color:${color};font-size:11px">${sign}${chg?.toFixed(2)} (${sign}${chgPct?.toFixed(2)}%)</span>`;}

// Shared by loadMarketTab (live) and _renderMarketFromCache (cached) --
// previously this whole block was duplicated line-for-line in both
// functions.
function _computeMarketDerivedValues(sp500,nasdaq,spLivePrice,spPrevClose,nqLivePrice,nqPrevClose,tbill3m,tbill5y,tbill10y){
  const tb3Current=tbill3m.length?tbill3m[tbill3m.length-1].value:null;
  const tb5yCurrent=tbill5y.length?tbill5y[tbill5y.length-1].value:null;
  const tb10yCurrent=tbill10y.length?tbill10y[tbill10y.length-1].value:null;
  const tb3Yr=tbill3m.length>=252?tbill3m[tbill3m.length-252].value:tbill3m[0]?.value;
  const tb5yYr=tbill5y.length>=252?tbill5y[tbill5y.length-252].value:tbill5y[0]?.value;
  const tb10yYr=tbill10y.length>=252?tbill10y[tbill10y.length-252].value:tbill10y[0]?.value;

  // Three spreads, each reading a different part of the curve. None of
  // these are a true 3-month/6-month comparison -- there is no 6-month
  // T-bill index available via Yahoo, so ^FVX (5Y) and ^TNX (10Y) are used
  // as the two longer points instead, labeled honestly throughout.
  const spread35=tb3Current&&tb5yCurrent?tb5yCurrent-tb3Current:null;
  const spread310=tb3Current&&tb10yCurrent?tb10yCurrent-tb3Current:null;
  const spread510=tb5yCurrent&&tb10yCurrent?tb10yCurrent-tb5yCurrent:null;
  const spreadStr35=spread35!==null?(spread35>=0?`5Y yields ${spread35.toFixed(2)}bp above 3M (normal) -- medium-term signal`:`3M yields ${Math.abs(spread35).toFixed(2)}bp above 5Y (inverted -- market expects rate cuts) -- medium-term signal`):'';
  const spreadStr310=spread310!==null?(spread310>=0?`10Y yields ${spread310.toFixed(2)}bp above 3M (normal) -- the classic recession-watch spread`:`3M yields ${Math.abs(spread310).toFixed(2)}bp above 10Y (inverted -- market expects rate cuts) -- the classic recession-watch spread`):'';
  const spreadStr510=spread510!==null?(spread510>=0?`10Y yields ${spread510.toFixed(2)}bp above 5Y (normal) -- long-end slope, not near-term Fed policy`:`5Y yields ${Math.abs(spread510).toFixed(2)}bp above 10Y (inverted) -- long-end slope, not near-term Fed policy`):'';

  // Income engine summary -- compare all three layers
  const spyi_snap=S.get('snap_etf_SPYI');const nbos_snap=S.get('snap_etf_NBOS');
  const spyi_div=S.get('div_etf_SPYI');const nbos_div=S.get('div_etf_NBOS');
  let spyiYield=null,nbosYield=null;
  if(spyi_snap?.price&&spyi_div?.distributions){const tot=spyi_div.distributions.slice(0,12).reduce((s,d)=>s+(d.amount||0),0);spyiYield=(tot/spyi_snap.price*100).toFixed(2);}
  if(nbos_snap?.price&&nbos_div?.distributions){const tot=nbos_div.distributions.slice(0,12).reduce((s,d)=>s+(d.amount||0),0);nbosYield=(tot/nbos_snap.price*100).toFixed(2);}

  const cv=S.get('vix_hist');const vixCurrent=cv?.closes?.filter(c=>c!==null).slice(-1)[0]||null;
  // Prefer live quote price; fall back to last close from history
  const spCurrent=spLivePrice||sp500?.closes?.filter(c=>c!==null).slice(-1)[0]||null;
  const spPrevHist=sp500?.closes?.filter(c=>c!==null).slice(-2)[0]||null;
  const spPrevFinal=spPrevClose||spPrevHist||null;
  const spChg=spCurrent&&spPrevFinal?spCurrent-spPrevFinal:null;
  const spChgPct=spChg&&spPrevFinal?spChg/spPrevFinal*100:null;
  const nqCurrent=nqLivePrice||nasdaq?.closes?.filter(c=>c!==null).slice(-1)[0]||null;
  const nqPrevHist=nasdaq?.closes?.filter(c=>c!==null).slice(-2)[0]||null;
  const nqPrevFinal=nqPrevClose||nqPrevHist||null;
  const nqChg=nqCurrent&&nqPrevFinal?nqCurrent-nqPrevFinal:null;
  const nqChgPct=nqChg&&nqPrevFinal?nqChg/nqPrevFinal*100:null;

  const spLabels=sp500?.timestamps?.slice(-63).map(d=>{if(!(d instanceof Date))d=new Date(d);return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});})||[];
  const spData=sp500?.closes?.slice(-63)||[];

  return{tb3Current,tb5yCurrent,tb10yCurrent,tb3Yr,tb5yYr,tb10yYr,spread35,spread310,spread510,spreadStr35,spreadStr310,spreadStr510,spyiYield,nbosYield,vixCurrent,spCurrent,spChg,spChgPct,nqCurrent,nqChg,nqChgPct,spLabels,spData};
}

// Shared render + chart-draw, driven by an isLive flag rather than being
// duplicated per call site. Consumes the object _computeMarketDerivedValues
// returns. Fixes two real bugs the duplication had let drift: the T-bill
// card's explanatory sentence was missing from the cached-render copy, and
// the live copy computed outlook/outlookHike but never used either --
// dead code left over from an edit that only touched one of the two copies.
// Second day of each 2-day FOMC meeting (when the rate decision is
// announced) -- sourced from the Fed's own published schedule. These are
// published roughly a year and a half ahead and essentially never move, so
// this only needs updating about once a year when the next year's tentative
// schedule comes out (usually announced in the back half of the prior year).
const FOMC_MEETING_DATES=[
  '2026-01-28','2026-03-18','2026-04-29','2026-06-17','2026-07-29','2026-09-16','2026-10-28','2026-12-09',
  '2027-01-27','2027-03-17','2027-04-28','2027-06-09','2027-07-28','2027-09-15','2027-10-27','2027-12-08',
  '2028-01-26', // only 2028 date announced so far -- the rest of 2028's schedule is expected ~Aug/Sep 2027, per the Fed's usual one-year-ahead announcement pattern
];
// Editable in Settings (see _renderFomcDatesEditor/saveFomcDates below), for
// exactly the scenario where nobody's available to update the hardcoded
// list above via a code change -- the Fed publishes these dates on its own
// site, so anyone can copy the next year's 8 dates in by hand once a year.
// A stored override, if present, is the sole effective list (not merged
// with the hardcoded one), so what's shown in the editor is always the
// complete picture, never a hidden diff against something invisible.
function _effectiveFomcDates(){
  const stored=S.get('fomc_meeting_dates_override');
  return(Array.isArray(stored)&&stored.length)?stored:FOMC_MEETING_DATES;
}
const _MONTH_ABBR={Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};

// Simple version: assumes at most one standard 25bp step per meeting.
// Correct the large majority of the time; a genuine 50bp-move scenario
// would show as a probability this model can't fully represent (capped at
// 100% for whichever direction), which is a known, accepted simplification
// for a first version rather than the fuller multi-outcome treatment CME's
// own methodology uses.
function _computeFedMeetingProbabilities(fedFutures){
  if(!fedFutures||!fedFutures.length)return[];
  const STEP=0.25; // standard FOMC move size, percentage points
  const meetingDates=_effectiveFomcDates();
  const results=[];
  let currentRate=null;
  for(let i=0;i<fedFutures.length;i++){
    const c=fedFutures[i];
    const[mAbbr,yStr]=(c.month||'').split(' ');
    const m=_MONTH_ABBR[mAbbr],y=parseInt(yStr);
    if(m==null||isNaN(y))continue;
    const daysInMonth=new Date(y,m+1,0).getDate();
    const meetingDateStr=meetingDates.find(d=>{
      const dd=new Date(d+'T12:00:00Z');
      return dd.getFullYear()===y&&dd.getMonth()===m;
    });
    if(!meetingDateStr){
      // No meeting this month -- if we don't have a baseline rate yet,
      // this month's implied rate IS the baseline (nothing moves it).
      if(currentRate==null)currentRate=c.impliedRate;
      continue;
    }
    const meetingDay=new Date(meetingDateStr+'T12:00:00Z').getDate();
    const daysBefore=meetingDay-1;
    const daysAfter=daysInMonth-daysBefore;
    if(currentRate==null||daysAfter<=0){
      // Can't cleanly establish a pre-meeting baseline for this specific
      // meeting (e.g. it falls in the very first fetched month, before any
      // meeting-free month has given us a starting rate) -- skip just this
      // one meeting rather than guess. Later meetings still get a chance to
      // resolve once/if a baseline becomes available.
      continue;
    }
    // Day-weighted average: the contract's implied rate for the whole month
    // blends the known pre-meeting rate with the unknown post-meeting rate.
    const postMeetingRate=(c.impliedRate*daysInMonth-currentRate*daysBefore)/daysAfter;
    const impliedMove=postMeetingRate-currentRate;
    let pCut=0,pHike=0;
    if(impliedMove<0)pCut=Math.min(Math.abs(impliedMove)/STEP,1);
    else if(impliedMove>0)pHike=Math.min(impliedMove/STEP,1);
    const pHold=1-pCut-pHike;
    results.push({
      month:c.month,meetingDate:meetingDateStr,
      pHold:Math.round(pHold*100),pCut25:Math.round(pCut*100),pHike25:Math.round(pHike*100),
    });
    currentRate=postMeetingRate; // chain forward -- next meeting's baseline is this one's outcome
  }
  return results;
}

function _renderMarketContent(el,{ts,isLive,tsEpoch,fredTs,fredTsEpoch,fedFutures,fedFuturesFailedMonths,tbill3m,tbill5y,tbill10y,marketNews,derived}){
  const{tb3Current,tb5yCurrent,tb10yCurrent,tb3Yr,tb5yYr,tb10yYr,spread35,spread310,spread510,spreadStr35,spreadStr310,spreadStr510,spyiYield,nbosYield,vixCurrent,spCurrent,spChg,spChgPct,nqCurrent,nqChg,nqChgPct,spLabels,spData}=derived;

  el.innerHTML=`
    ${tsChip(ts,isLive,tsEpoch)}
    <!-- Income Engine Summary -->
    <div class="card" style="border-left:4px solid var(--accent3)">
      <div class="card-title"><span class="dot" style="background:var(--accent3)"></span>Income Engine Summary</div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:10px">Your three-layer income strategy -- risk premium above risk-free rate at each layer</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:rgba(33,150,243,0.1);border-radius:8px;border:1px solid rgba(33,150,243,0.3)">
          <div><div style="font-family:var(--mono);font-size:10px;color:var(--text3)">LAYER 1 -- T-BILLS</div><div style="font-family:var(--mono);font-size:12px;color:var(--text2)">3-month Treasury</div></div>
          <div style="font-family:var(--mono);font-size:20px;font-weight:600;color:#64b5f6">${tb3Current?tb3Current.toFixed(2)+'%':'N/A'}</div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:rgba(255,107,53,0.1);border-radius:8px;border:1px solid rgba(255,107,53,0.3)">
          <div><div style="font-family:var(--mono);font-size:10px;color:var(--text3)">LAYER 2 -- ETFs</div><div style="font-family:var(--mono);font-size:12px;color:var(--text2)">SPYI / NBOS TTM Yield</div></div>
          <div style="text-align:right">
            <div style="font-family:var(--mono);font-size:13px;font-weight:600;color:var(--accent2)">${spyiYield?'SPYI '+spyiYield+'%':'SPYI --'}${tb3Current&&spyiYield?' (+'+((parseFloat(spyiYield)-tb3Current).toFixed(2))+'% vs T-bills)':''}</div>
            <div style="font-family:var(--mono);font-size:13px;font-weight:600;color:var(--accent2);margin-top:2px">${nbosYield?'NBOS '+nbosYield+'%':'NBOS --'}${tb3Current&&nbosYield?' (+'+((parseFloat(nbosYield)-tb3Current).toFixed(2))+'% vs T-bills)':''}</div>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:rgba(0,212,170,0.1);border-radius:8px;border:1px solid rgba(0,212,170,0.3)">
          <div><div style="font-family:var(--mono);font-size:10px;color:var(--text3)">LAYER 3 -- WHEEL</div><div style="font-family:var(--mono);font-size:12px;color:var(--text2)">Active put/call selling target</div></div>
          <div style="text-align:right"><div style="font-family:var(--mono);font-size:20px;font-weight:600;color:var(--accent)">${(parseFloat(document.getElementById('target-apy')?.value)||12).toFixed(1)}%</div><div style="font-family:var(--mono);font-size:9px;color:var(--text3)">${tb3Current?`+${((parseFloat(document.getElementById('target-apy')?.value)||12)-tb3Current).toFixed(2)}% risk premium`:'target APY (set on Dashboard tab)'}</div></div>
        </div>
      </div>
    </div>
    <!-- T-bill yields -->
    ${(()=>{
      // CME Fed Funds Futures -- implied rate path
      if(!fedFutures||!fedFutures.length)return'';
      const firstRate=fedFutures[0]?.impliedRate;
      const lastRate=fedFutures[fedFutures.length-1]?.impliedRate;
      // Compute cumulative cut/hike vs first contract
      const rows=fedFutures.map((c,i)=>{
        const delta=i===0?0:parseFloat((c.impliedRate-fedFutures[0].impliedRate).toFixed(3));
        const bps=Math.round(delta*100);
        const col=bps<-5?'var(--green)':bps>5?'var(--red)':'var(--text2)';
        const sign=bps>0?'+':'';
        return '<tr>'
          +'<td style="color:var(--text2)">'+c.month+'</td>'
          +'<td style="font-family:var(--mono)">'+c.price.toFixed(3)+'</td>'
          +'<td style="font-family:var(--mono)">'+c.impliedRate.toFixed(3)+'%</td>'
          +'<td style="color:'+col+';font-family:var(--mono)">'+(i===0?'—':sign+bps+'bp')+'</td>'
          +'</tr>';
      }).join('');
      const totalBps=Math.round((lastRate-firstRate)*100);
      const _absBps=Math.abs(totalBps);
      // Symmetric by construction across both directions, rather than the
      // previous cut-only branches with a same-text fallback for anything
      // that didn't match -- that fallback silently caught positive
      // (hike-direction) totalBps too, since nothing there checked sign,
      // producing "Markets pricing 1-2 cuts" even when the underlying
      // futures prices were falling (implied rate rising, a hike signal)
      // -- exactly contradicting the correctly-signed meeting-by-meeting
      // breakdown below it.
      const summary=_absBps<25
        ?'Markets pricing no change'
        :(totalBps<0
            ?(_absBps<50?'Markets pricing ~1 cut':'Markets pricing 2+ cuts')
            :(_absBps<50?'Markets pricing ~1 hike':'Markets pricing 2+ hikes'));
      const meetingProbs=_computeFedMeetingProbabilities(fedFutures);
      const probRows=meetingProbs.map(p=>{
        const dateLabel=new Date(p.meetingDate+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric'});
        const parts=[];
        if(p.pHold>0)parts.push(p.pHold+'% hold');
        if(p.pCut25>0)parts.push(p.pCut25+'% cut 25bp');
        if(p.pHike25>0)parts.push(p.pHike25+'% hike 25bp');
        return '<div style="font-family:var(--mono);font-size:10px;color:var(--text2);padding:3px 0">'+dateLabel+' meeting: '+parts.join(', ')+'</div>';
      }).join('');
      return '<div class="card"><div class="card-title"><span class="dot" style="background:var(--accent2)"></span>Fed Funds Futures (CME Implied Rates)</div>'
        +'<div style="font-family:var(--mono);font-size:11px;color:var(--text3);margin-bottom:8px">30-day futures price → implied rate (100 − price). Delta vs near-month contract.</div>'
        +'<div class="options-table-wrap"><table class="options-table">'
        +'<thead><tr><th style="text-align:left">Month</th><th>Price</th><th>Implied Rate</th><th>Δ vs Now</th></tr></thead>'
        +'<tbody>'+rows+'</tbody></table></div>'
        +'<div style="font-family:var(--mono);font-size:11px;color:var(--accent);margin-top:8px">'+summary+' (next '+fedFutures.length+' months, '+Math.abs(totalBps)+'bp total)</div>'
        +(fedFuturesFailedMonths&&fedFuturesFailedMonths.length?'<div style="font-family:var(--mono);font-size:9px;color:var(--warn);margin-top:4px">Data unavailable for: '+fedFuturesFailedMonths.join(', ')+' -- that contract didn\'t return a usable quote this fetch, so those meetings (if any fall in these months) are missing below, not intentionally excluded.</div>':'')
        +(probRows?'<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--surface3)"><div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-bottom:2px">Meeting-by-meeting odds (simplified -- assumes at most one 25bp step per meeting):</div>'+probRows+'</div>':'')
        +'</div>';
    })()}
    <div class="card">
      <div class="card-title"><span class="dot" style="background:#64b5f6"></span>Treasury Yields (^IRX / ^FVX / ^TNX)</div>
      ${tsChip(fredTs,isLive,fredTsEpoch)}
      <div class="metrics-grid">
        <div class="metric-tile"><div class="metric-label">3-Month T-Bill (^IRX)</div><div class="metric-value" style="color:#64b5f6">${tb3Current?tb3Current.toFixed(3)+'%':'N/A'}</div><div class="metric-sub">${tb3Yr?`1Y ago: ${tb3Yr.toFixed(3)}% (${(tb3Current-tb3Yr)>=0?'+':''}${(tb3Current-tb3Yr).toFixed(3)}%)`:''}</div></div>
        <div class="metric-tile"><div class="metric-label">5-Year Treasury (^FVX)</div><div class="metric-value" style="color:#64b5f6">${tb5yCurrent?tb5yCurrent.toFixed(3)+'%':'N/A'}</div><div class="metric-sub">${tb5yYr?`1Y ago: ${tb5yYr.toFixed(3)}% (${(tb5yCurrent-tb5yYr)>=0?'+':''}${(tb5yCurrent-tb5yYr).toFixed(3)}%)`:''}</div></div>
        <div class="metric-tile"><div class="metric-label">10-Year Treasury (^TNX)</div><div class="metric-value" style="color:#64b5f6">${tb10yCurrent?tb10yCurrent.toFixed(3)+'%':'N/A'}</div><div class="metric-sub">${tb10yYr?`1Y ago: ${tb10yYr.toFixed(3)}% (${(tb10yCurrent-tb10yYr)>=0?'+':''}${(tb10yCurrent-tb10yYr).toFixed(3)}%)`:''}</div></div>
        ${spread35!==null?`<div class="metric-tile" style="grid-column:span 2"><div class="metric-label">3M / 5Y Spread</div><div class="metric-value" style="font-size:13px">${Math.abs(spread35).toFixed(2)}bp ${spread35>=0?'(5Y > 3M)':'(3M > 5Y -- inverted)'}</div><div class="metric-sub">${spreadStr35}</div></div>`:''}
        ${spread310!==null?`<div class="metric-tile" style="grid-column:span 2"><div class="metric-label">3M / 10Y Spread</div><div class="metric-value" style="font-size:13px">${Math.abs(spread310).toFixed(2)}bp ${spread310>=0?'(10Y > 3M)':'(3M > 10Y -- inverted)'}</div><div class="metric-sub">${spreadStr310}</div></div>`:''}
        ${spread510!==null?`<div class="metric-tile" style="grid-column:span 2"><div class="metric-label">5Y / 10Y Spread</div><div class="metric-value" style="font-size:13px">${Math.abs(spread510).toFixed(2)}bp ${spread510>=0?'(10Y > 5Y)':'(5Y > 10Y -- inverted)'}</div><div class="metric-sub">${spreadStr510}</div></div>`:''}
      </div>
      ${tbill3m&&tbill3m.length?`<div style="display:flex;gap:6px;margin:10px 0 4px"><button class="btn btn-secondary" style="font-size:10px;padding:2px 8px;opacity:${currentTBillSpan==='3m'?'1':'0.4'}" id="tbill-btn-3m" onclick="toggleTBillSpan('3m')">3M</button><button class="btn btn-secondary" style="font-size:10px;padding:2px 8px;opacity:${currentTBillSpan==='6m'?'1':'0.4'}" id="tbill-btn-6m" onclick="toggleTBillSpan('6m')">6M</button><button class="btn btn-secondary" style="font-size:10px;padding:2px 8px;opacity:${currentTBillSpan==='1y'?'1':'0.4'}" id="tbill-btn-1y" onclick="toggleTBillSpan('1y')">1Y</button></div><div class="chart-wrap" style="height:160px"><canvas id="tbill-chart"></canvas></div><div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:4px">History of 3-month T-bill (blue, ^IRX), 5-Year Treasury (orange, ^FVX), and 10-Year Treasury (purple, ^TNX) yields. No 6-month T-bill index is available via this data source. Source: Yahoo Finance via Cloudflare Worker. Spreads above read curve shape at different horizons -- 3M/10Y is the standard recession-watch spread; 5Y/10Y reads the long end alone.</div>`:''}
    </div>
    <!-- Market indices -->
    <div class="metrics-grid">
      <div class="metric-tile" style="grid-column:span 2"><div class="metric-label">S&P 500</div><div class="metric-value" style="font-size:15px">${fmtChg(spCurrent,spChg,spChgPct)}</div></div>
      <div class="metric-tile" style="grid-column:span 2"><div class="metric-label">Nasdaq Composite</div><div class="metric-value" style="font-size:15px">${fmtChg(nqCurrent,nqChg,nqChgPct)}</div></div>
      ${vixCurrent?`<div class="metric-tile" style="grid-column:span 2;background:${vixCurrent>=30?'rgba(255,71,87,0.1)':vixCurrent>=20?'rgba(255,165,2,0.1)':'var(--surface2)'}"><div class="metric-label">VIX (from cache)</div><div class="metric-value" style="color:${vixCurrent>=30?'var(--red)':vixCurrent>=20?'var(--warn)':'var(--text)'}">${vixCurrent.toFixed(2)}</div><div class="metric-sub">${vixCurrent>=30?'FEAR SPIKE -- exceptional premium':vixCurrent>=20?'ELEVATED -- favorable for selling':'Normal conditions'}</div></div>`:''}
    </div>
    ${spLabels.length?`<div class="card"><div class="card-title"><span class="dot" style="background:#4fc3f7"></span>S&P 500 (3 months)</div><div class="chart-wrap" style="height:180px"><canvas id="sp500-chart"></canvas></div></div>`:''}
    <div class="card"><div class="card-title"><span class="dot" style="background:var(--accent2)"></span>Top Market News</div><div>${renderNewsItems(marketNews,10)}</div></div>`;

  // Render charts
  setTimeout(()=>{
    const ctx=document.getElementById('sp500-chart')?.getContext('2d');
    if(ctx&&spLabels.length){new Chart(ctx,{type:'line',data:{labels:spLabels,datasets:[{data:spData,borderColor:'#4fc3f7',borderWidth:1.5,pointRadius:0,tension:0.2,fill:false}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#555870',font:{size:9},maxTicksLimit:6},grid:{color:'#2a2e38'}},y:{ticks:{color:'#555870',font:{size:9}},grid:{color:'#2a2e38'}}}}});}
    // T-bill/Treasury chart -- data is daily (^IRX/^FVX/^TNX via
    // yahooHistory 1y/1d), not weekly. Slicing must be in trading-day
    // counts, matching the 252-day convention already used for the "1Y
    // ago" comparison above -- the old slice(-52) assumed weekly auctions
    // and only ever showed ~10 weeks.
    window._mktTBillData={tbill3m,tbill5y,tbill10y};
    _drawTBillChart(tbill3m,tbill5y,tbill10y,currentTBillSpan);
  },100);
}

function _tbillSpanDays(span){return span==='3m'?63:span==='6m'?126:252;}

// Shared by the initial render and toggleTBillSpan -- redraws only the
// T-bill canvas, without re-rendering the whole card, so toggling doesn't
// need a network round-trip (a full year of daily data is already fetched).
function _drawTBillChart(tbill3m,tbill5y,tbill10y,span){
  const tbCtx=document.getElementById('tbill-chart')?.getContext('2d');
  if(!tbCtx||!tbill3m.length)return;
  if(window._tbillChart){window._tbillChart.destroy();window._tbillChart=null;}
  const n=_tbillSpanDays(span);
  const recent3m=tbill3m.slice(-n);
  const recent5y=(tbill5y||[]).slice(-n);
  const recent10y=(tbill10y||[]).slice(-n);
  const chartLabels=recent3m.map(d=>d.date.slice(5)); // MM-DD
  // Align 5Y/10Y series to the same date range/length as the 3M series --
  // defensive against a stale cache read where one series is shorter or
  // empty (e.g. right after this build's cache-key rename).
  const aligned5y=recent5y.slice(-recent3m.length).map(d=>d.value);
  const aligned10y=recent10y.slice(-recent3m.length).map(d=>d.value);
  window._tbillChart=new Chart(tbCtx,{type:'line',data:{labels:chartLabels,datasets:[
    {label:'3-Month T-bill',data:recent3m.map(d=>d.value),borderColor:'#64b5f6',borderWidth:1.5,pointRadius:0,tension:0.3,fill:false},
    {label:'5-Year Treasury',data:aligned5y,borderColor:'#ff9800',borderWidth:1.5,pointRadius:0,tension:0.3,fill:false},
    {label:'10-Year Treasury',data:aligned10y,borderColor:'#ab47bc',borderWidth:1.5,pointRadius:0,tension:0.3,fill:false}
  ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#8b8fa8',font:{size:9}}}},scales:{x:{ticks:{color:'#555870',font:{size:9},maxTicksLimit:8},grid:{color:'#2a2e38'}},y:{ticks:{color:'#555870',font:{size:9},callback:v=>v.toFixed(2)+'%'},grid:{color:'#2a2e38'}}}}});
}

function toggleTBillSpan(span){
  currentTBillSpan=span;
  const btn3=document.getElementById('tbill-btn-3m');
  const btn6=document.getElementById('tbill-btn-6m');
  const btn1=document.getElementById('tbill-btn-1y');
  if(btn3)btn3.style.opacity=span==='3m'?'1':'0.4';
  if(btn6)btn6.style.opacity=span==='6m'?'1':'0.4';
  if(btn1)btn1.style.opacity=span==='1y'?'1':'0.4';
  const data=window._mktTBillData;
  if(data)_drawTBillChart(data.tbill3m,data.tbill5y,data.tbill10y,span);
}

async function loadMarketTab(){
  if(offlineMode){await restoreMarketFromCache();return;}
  const el=document.getElementById('market-content');
  el.innerHTML='<div class="card"><div style="display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--text2)"><div class="spinner"></div>Loading market data...</div></div>';
  try{
    let sp500,nasdaq,treasury2y,isLive=true,mktTs=nowPT(),mktTsEpoch=Date.now();
    let spLivePrice=null,nqLivePrice=null,spPrevClose=null,nqPrevClose=null;
    // Fetch each independently so one failure doesn't block the others
    // Use cached 2Y GSPC data (sliced to 3M) instead of a separate fetch
    try{
      const _gsp=S.get('hist2y_sp500');
      if(_gsp?.closes?.length>=60){
        const _g6=Math.max(0,_gsp.timestamps.length-63); // ~3 months of trading days
        sp500={timestamps:_gsp.timestamps.slice(_g6).map(d=>new Date(d*1000)),closes:_gsp.closes.slice(_g6)};
        S.set('mkt_sp500',{timestamps:sp500.timestamps.map(d=>d.toISOString()),closes:sp500.closes,ts:mktTs,tsEpoch:mktTsEpoch});
      }else{
        sp500=await _mktTimeout(yahooHistory('^GSPC','3mo','1d'),12000,'GSPC 3mo');
        S.set('mkt_sp500',{timestamps:sp500.timestamps.map(d=>d.toISOString()),closes:sp500.closes,ts:mktTs,tsEpoch:mktTsEpoch});
      }}
    catch{const cs=S.get('mkt_sp500');if(cs){sp500={timestamps:cs.timestamps.map(d=>new Date(typeof d==='number'?d*1000:d)),closes:cs.closes};isLive=false;mktTs=cs.ts;mktTsEpoch=cs.tsEpoch;showOfflineBanner(cs.ts,cs.tsEpoch);}}
    try{nasdaq=await _mktTimeout(yahooHistory('^IXIC','3mo','1d'),12000,'IXIC 3mo');S.set('mkt_nasdaq',{timestamps:nasdaq.timestamps.map(d=>d.toISOString()),closes:nasdaq.closes,ts:mktTs,tsEpoch:mktTsEpoch});}
    catch{const cn=S.get('mkt_nasdaq');if(cn)nasdaq={timestamps:cn.timestamps.map(d=>new Date(typeof d==='number'?d*1000:d)),closes:cn.closes};}
    // 2-year Treasury: try ^USGG2YR first, fall back to ^TNX (10Y) scaled, then live quote
    try{
      treasury2y=await _mktTimeout(yahooHistory('^USGG2YR','3mo','1d'),12000,'USGG2YR');
      // Validate -- ^USGG2YR sometimes returns all-null closes
      const validCloses=treasury2y?.closes?.filter(c=>c!==null&&c>0)||[];
      if(!validCloses.length)throw new Error('No valid 2Y closes');
      S.set('mkt_2y',{timestamps:treasury2y.timestamps.map(d=>d.toISOString()),closes:treasury2y.closes,ts:mktTs,tsEpoch:mktTsEpoch});
    }catch{
      // Try live quote for 2Y yield as fallback
      try{
        const t2q=await _mktTimeout(fetch(`${WORKER_URL}/?ticker=${encodeURIComponent('^TNX')}&type=quote&_t=${Date.now()}`).then(r=>r.json()),10000,'TNX quote');
        const t2Live=t2q?.quoteResponse?.result?.[0]?.regularMarketPrice||null;
        if(t2Live){
          // Create synthetic history with just the current value
          const now=new Date();
          treasury2y={timestamps:[now],closes:[t2Live]};
        }
      }catch{}
      const c2=S.get('mkt_2y');
      if(c2&&(!treasury2y||!treasury2y.closes?.filter(c=>c!==null).length))
        treasury2y={timestamps:c2.timestamps.map(d=>new Date(typeof d==='number'?d*1000:d)),closes:c2.closes};
    }
    S.set('mkt_ts',mktTs);
    // Fetch live quotes for S&P 500 and Nasdaq -- history closes can be null for index tickers
    try{
      const[spQ,nqQ]=await Promise.all([
        fetch(`${WORKER_URL}/?ticker=${encodeURIComponent('^GSPC')}&type=quote&_t=${Date.now()}`).then(r=>r.json()),
        fetch(`${WORKER_URL}/?ticker=${encodeURIComponent('^IXIC')}&type=quote&_t=${Date.now()}`).then(r=>r.json())
      ]);
      spLivePrice=spQ?.quoteResponse?.result?.[0]?.regularMarketPrice||null;
      spPrevClose=spQ?.quoteResponse?.result?.[0]?.regularMarketPreviousClose||null;
      nqLivePrice=nqQ?.quoteResponse?.result?.[0]?.regularMarketPrice||null;
      nqPrevClose=nqQ?.quoteResponse?.result?.[0]?.regularMarketPreviousClose||null;
      if(spLivePrice)S.set('mkt_sp_live',{price:spLivePrice,prevClose:spPrevClose,ts:mktTs,tsEpoch:mktTsEpoch});
      if(nqLivePrice)S.set('mkt_nq_live',{price:nqLivePrice,prevClose:nqPrevClose,ts:mktTs,tsEpoch:mktTsEpoch});
    }catch{}
    if(!spLivePrice){const c=S.get('mkt_sp_live');if(c){spLivePrice=c.price;spPrevClose=c.prevClose;}}
    if(!nqLivePrice){const c=S.get('mkt_nq_live');if(c){nqLivePrice=c.price;nqPrevClose=c.prevClose;}}
    // Fetch CME Fed Funds futures for rate probability display
    let fedFutures=null,fedFuturesFailedMonths=[];
    try{
      const fedResult=await _mktTimeout(fetchFedFundsFutures(),12000,'fed futures');
      if(fedResult){fedFutures=fedResult.contracts;fedFuturesFailedMonths=fedResult.failedMonths||[];S.set('fed_futures',{data:fedFutures,failedMonths:fedFuturesFailedMonths,ts:mktTs,tsEpoch:mktTsEpoch});}
    }catch{}
    if(!fedFutures){const cf=S.get('fed_futures');if(cf){fedFutures=cf.data;fedFuturesFailedMonths=cf.failedMonths||[];}}
    // Treasury yields via Yahoo Finance (^IRX/^FVX/^TNX), routed through
    // the Worker. Previously this comment referenced Treasury FiscalData --
    // that was abandoned for SSL failures on Cloudflare Workers; Yahoo has
    // been the actual source since v1.7.3.
    let tbill3m=[],tbill5y=[],tbill10y=[],fredTs=nowPT(),fredTsEpoch=Date.now();
    try{
      const tbills=await _mktTimeout(fetchTBills(),12000,'tbills');
      tbill3m=tbills.tbill3m;tbill5y=tbills.tbill5y;tbill10y=tbills.tbill10y;
      fredTs=nowPT();fredTsEpoch=Date.now();
      S.set('tbills_cache',{tbill3m,tbill5y,tbill10y,ts:fredTs,tsEpoch:fredTsEpoch});
    }catch{
      const cd=S.get('tbills_cache');
      if(cd){tbill3m=cd.tbill3m||[];tbill5y=cd.tbill5y||[];tbill10y=cd.tbill10y||[];fredTs=cd.ts||'';fredTsEpoch=cd.tsEpoch;}
    }

    let marketNews=await _fetchMarketNews();

    const derived=_computeMarketDerivedValues(sp500,nasdaq,spLivePrice,spPrevClose,nqLivePrice,nqPrevClose,tbill3m,tbill5y,tbill10y);
    _renderMarketContent(el,{ts:mktTs,isLive,tsEpoch:mktTsEpoch,fredTs,fredTsEpoch,fedFutures,fedFuturesFailedMonths,tbill3m,tbill5y,tbill10y,marketNews,derived});

    S.set('market_ts',{ts:nowPT(),tsEpoch:Date.now()});
  }catch(err){el.innerHTML=`<div class="card"><div style="font-family:var(--mono);font-size:12px;color:var(--red)">Error: ${err.message}</div></div>`;}
}

// ── Cache age helper (minutes) ──────────────────────────────────────────────
// Returns how many minutes ago a stored timestamp string was, or Infinity if
// the timestamp is absent / unparseable.
function _mktCacheAgeMins(tsStr){
  if(!tsStr)return Infinity;
  try{
    const clean=(typeof tsStr==='object'&&tsStr.ts)?tsStr.ts:tsStr;
    const d=new Date(String(clean).replace(/ PT$| UTC$| local$/,'').trim());
    if(isNaN(d.getTime()))return Infinity;
    return(Date.now()-d.getTime())/60000;
  }catch{return Infinity;}
}

// Fetches general market news and updates the cache. Used both by the full
// loadMarketTab() cycle and by restoreMarketFromCache()'s independent news
// freshness check. Returns the cached items on failure.
async function _fetchMarketNews(){
  try{
    const news=await _mktTimeout(fh('/news?category=general'),10000,'market news');
    const marketNews=(news||[]).slice(0,10);
    S.set('market_news',{items:marketNews.slice(0,15).map(n=>({headline:n.headline,summary:n.summary?n.summary.slice(0,200):null,url:n.url,source:n.source,datetime:n.datetime})),ts:nowPT(),tsEpoch:Date.now()});
    return marketNews;
  }catch{
    const cn=S.get('market_news');
    return cn?.items||[];
  }
}

// How fresh general market news must be (in minutes) before we skip a live
// fetch. Deliberately NOT tied to _isMarketActiveWindow() -- unlike prices,
// yields, and futures (which are frozen while the market is closed), news
// can break at any hour: after-hours earnings calls, weekend M&A, Fed
// statements, geopolitical events. This TTL applies at all times, day or
// night, weekday or weekend.
const MARKET_NEWS_FRESH_MINS=20;

async function restoreMarketFromCache(){
  // Check whether we have recent market data in localStorage.
  // Two independent freshness checks, not one combined gate:
  //   - Price/yield/futures data uses the same active-window-aware TTL as
  //     ticker.js's per-ticker snap freshness (_isMarketActiveWindow): 5
  //     minutes during market hours, cache holds indefinitely outside them,
  //     since that data genuinely doesn't change while the market is closed.
  //   - News uses its own flat MARKET_NEWS_FRESH_MINS TTL that applies
  //     regardless of market hours, since news can break at any time.
  // This means a Prefetch All run at 11pm can skip the price/yield/futures
  // fetches entirely while still refreshing news if it's gone stale.
  //
  // Decision matrix:
  //   online  + both fresh        → skip live fetch entirely; render from cache
  //   online  + data fresh, news stale → fetch just news, render the rest from cache
  //   online  + data stale        → full live fetch via loadMarketTab() (which
  //                                  already refreshes news as part of its cycle)
  //   offline (any cache age)     → loadMarketTab() handles offline path itself

  const mktTs=S.get('market_ts');
  const dataAgeMins=_mktCacheAgeMins(mktTs?.ts||mktTs);
  const dataTtlMins=_isMarketActiveWindow()?5:Infinity;

  if(dataAgeMins>=0&&dataAgeMins<dataTtlMins&&navigator.onLine){
    const cnews=S.get('market_news');
    const newsAgeMins=_mktCacheAgeMins(cnews?.ts);
    if(!(newsAgeMins>=0&&newsAgeMins<MARKET_NEWS_FRESH_MINS)){
      await _fetchMarketNews();
    }
    _renderMarketFromCache();
    return;
  }

  // Price/yield/futures data is stale, missing, or offline.
  if(offlineMode){
    // Don't fall through to loadMarketTab() here -- it calls back into this
    // function whenever offlineMode is true, which would recurse forever if
    // the cache is also stale. Render whatever's cached regardless of age;
    // that's what "offline" should mean, and is strictly better than a loop.
    _renderMarketFromCache();
    return;
  }
  // Online but stale/missing → let loadMarketTab() do a full live fetch
  // (it also refreshes news as part of its normal cycle).
  await loadMarketTab();
}

// Renders the market tab entirely from localStorage — zero network calls.
// Mirrors the rendering block inside loadMarketTab() but reads every value
// from cache rather than from live fetch results.
function _renderMarketFromCache(){
  const el=document.getElementById('market-content');
  if(!el)return;

  // ── Read all cached data ─────────────────────────────────────────────────
  const mktTs=S.get('market_ts');
  const cachedTs=(mktTs?.ts||mktTs)||'';
  const mktTsEpoch=mktTs?.tsEpoch;

  const cs=S.get('mkt_sp500');
  const sp500=cs?{timestamps:cs.timestamps.map(d=>new Date(typeof d==='number'?d*1000:d)),closes:cs.closes}:null;

  const cn=S.get('mkt_nasdaq');
  const nasdaq=cn?{timestamps:cn.timestamps.map(d=>new Date(typeof d==='number'?d*1000:d)),closes:cn.closes}:null;

  const csp=S.get('mkt_sp_live');
  const spLivePrice=csp?.price||null;
  const spPrevClose=csp?.prevClose||null;

  const cnq=S.get('mkt_nq_live');
  const nqLivePrice=cnq?.price||null;
  const nqPrevClose=cnq?.prevClose||null;

  const cf=S.get('fed_futures');
  const fedFutures=cf?.data||null;
  const fedFuturesFailedMonths=cf?.failedMonths||[];

  const cd=S.get('tbills_cache');
  const tbill3m=cd?.tbill3m||[];
  const tbill5y=cd?.tbill5y||[];
  const tbill10y=cd?.tbill10y||[];
  const fredTs=cd?.ts||cachedTs;
  const fredTsEpoch=cd?.tsEpoch||mktTsEpoch;

  const cnews=S.get('market_news');
  const marketNews=cnews?.items||[];

  const derived=_computeMarketDerivedValues(sp500,nasdaq,spLivePrice,spPrevClose,nqLivePrice,nqPrevClose,tbill3m,tbill5y,tbill10y);
  _renderMarketContent(el,{ts:cachedTs,isLive:false,tsEpoch:mktTsEpoch,fredTs,fredTsEpoch,fedFutures,fedFuturesFailedMonths,tbill3m,tbill5y,tbill10y,marketNews,derived});

  setTimeout(refreshTsChipAges,200);
}
