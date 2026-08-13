// Income Engine -- dashboard.js
// Conviction dashboards: run scoring, render cards.
// Globals used: watchlist, currentMode, S, WORKER_URL
// Dependencies: helpers.js, scoring.js, storage.js

function compBarColor(v){return v>=2?'#00d4aa':v===1?'#4fc3f7':v===0?'#555870':'#ff4757';}

// ── Dashboard view toggle (Puts / Covered Calls / RSI Backtest) ──────────────
let dashboardViewMode=S.get('dashboard_view_mode')||'puts';

function setDashboardViewMode(mode){
  dashboardViewMode=mode;
  S.set('dashboard_view_mode',mode);
  _syncDashboardViewModeUI();
}

function _syncDashboardViewModeUI(){
  const putsBtn=document.getElementById('dash-view-puts'),ccBtn=document.getElementById('dash-view-cc'),rsiBtn=document.getElementById('dash-view-rsi'),riskBtn=document.getElementById('dash-view-risk'),gapBtn=document.getElementById('dash-view-gap'),notesBtn=document.getElementById('dash-view-notes'),wheelbtBtn=document.getElementById('dash-view-wheelbt');
  if(putsBtn)putsBtn.style.opacity=dashboardViewMode==='puts'?'1':'0.4';
  if(ccBtn)ccBtn.style.opacity=dashboardViewMode==='cc'?'1':'0.4';
  if(rsiBtn)rsiBtn.style.opacity=dashboardViewMode==='rsi'?'1':'0.4';
  if(riskBtn)riskBtn.style.opacity=dashboardViewMode==='risk'?'1':'0.4';
  if(gapBtn)gapBtn.style.opacity=dashboardViewMode==='gap'?'1':'0.4';
  if(notesBtn)notesBtn.style.opacity=dashboardViewMode==='notes'?'1':'0.4';
  if(wheelbtBtn)wheelbtBtn.style.opacity=dashboardViewMode==='wheelbt'?'1':'0.4';

  const convictionControls=document.getElementById('dash-conviction-controls');
  const putsCard=document.getElementById('dash-puts-card');
  const ccCard=document.getElementById('dash-cc-card');
  const rsiCard=document.getElementById('dash-rsi-card');
  const rsiRankingCard=document.getElementById('dash-rsi-ranking-card');
  const riskCard=document.getElementById('dash-risk-card');
  const gapCard=document.getElementById('dash-gap-card');
  const notesCard=document.getElementById('dash-notes-card');
  const wheelbtCard=document.getElementById('dash-wheelbt-card');
  const wheelbtRankingCard=document.getElementById('dash-wheelbt-ranking-card');
  if(convictionControls)convictionControls.style.display=(dashboardViewMode==='rsi'||dashboardViewMode==='risk'||dashboardViewMode==='gap'||dashboardViewMode==='notes'||dashboardViewMode==='wheelbt')?'none':'';
  if(putsCard)putsCard.style.display=dashboardViewMode==='puts'?'':'none';
  if(ccCard)ccCard.style.display=dashboardViewMode==='cc'?'':'none';
  if(rsiCard)rsiCard.style.display=dashboardViewMode==='rsi'?'':'none';
  if(rsiRankingCard)rsiRankingCard.style.display=dashboardViewMode==='rsi'?'':'none';
  if(riskCard)riskCard.style.display=dashboardViewMode==='risk'?'':'none';
  if(gapCard)gapCard.style.display=dashboardViewMode==='gap'?'':'none';
  if(notesCard)notesCard.style.display=dashboardViewMode==='notes'?'':'none';
  if(wheelbtCard)wheelbtCard.style.display=dashboardViewMode==='wheelbt'?'':'none';
  if(wheelbtRankingCard)wheelbtRankingCard.style.display=dashboardViewMode==='wheelbt'?'':'none';

  if(dashboardViewMode==='rsi'){_populateRSIBacktestDropdown();renderRSIBacktest();renderRSIRanking();}
  if(dashboardViewMode==='risk'){renderAssignmentRisk();}
  if(dashboardViewMode==='gap'){_populateGapFillDropdown();renderGapFillDashboard();}
  if(dashboardViewMode==='notes'){renderDashboardNotes();}
  if(dashboardViewMode==='wheelbt'){_populateWheelBacktestDropdown();if(!_wheelbtViewEverRendered||_wheelbtDataStale)setTimeout(refreshWheelBacktestViews,50);}
}

// 9 component definitions split into two rows: 4 on top, 5 on bottom.
// Labels sit below their respective bar, consistent with the existing convention.
const COMP_DEFS=[
  {key:'ivr',   label:'HVR'},
  {key:'rsi',   label:'RSI'},
  {key:'range', label:'Rng'},
  {key:'apy',   label:'APY'},
  {key:'earn',  label:'Earn'},
  {key:'ma',    label:'MA'},
  {key:'upside',label:'Up\u2191'},
  {key:'beta',  label:'Beta'},
  {key:'oiGap', label:'OI\u2193'},
];
const COMP_ROW1=COMP_DEFS.slice(0,4);  // IVR RSI Rng APY
const COMP_ROW2=COMP_DEFS.slice(4);    // Earn MA Up↑ Beta OI↓

function renderCompRow(defs,comps){
  return '<div style="display:flex;gap:3px;align-items:flex-end">'
    +defs.map(d=>{
      const v=comps[d.key]!=null?comps[d.key]:0;
      const col=compBarColor(v);
      const ht=Math.max(4,Math.abs(v)/3*14);
      return '<div style="flex:1;text-align:center">'
        +'<div style="background:'+col+';height:'+ht+'px;border-radius:2px;margin-bottom:2px"></div>'
        +'<div style="font-family:var(--mono);font-size:8px;color:var(--text3)">'+d.label+'</div>'
        +'</div>';
    }).join('')
    +'</div>';
}

function renderCompBars(comps){
  return '<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:8px;padding:4px 0">'
    +renderCompRow(COMP_ROW1,comps)
    +renderCompRow(COMP_ROW2,comps)
    +'</div>';
}

function renderDashTable(elId,results,ts,isLive){
  const el=document.getElementById(elId);if(!results.length){el.innerHTML='<div class="empty">No data</div>';return;}
  el.innerHTML=results.filter(r=>r.signal!=='error').map(r=>{
    const bc=r.signal==='high'?'rgba(0,200,150,0.7)':r.signal==='medium'?'rgba(255,193,7,0.7)':'rgba(255,71,87,0.6)';
    const bg=r.signal==='high'?'rgba(0,200,150,0.12)':r.signal==='medium'?'rgba(255,193,7,0.12)':'rgba(255,71,87,0.10)';
    const rs=r.recStrike&&r.recStrike!=='--'?r.recStrike:null;
    const exp=r.expiration&&r.expiration!=='--'?r.expiration:null;
    const apy=r.estApy&&r.estApy!=='--'?r.estApy:null;
    const sc=r.score!=null?r.score:'';
    const comps=r.components||{};
    return'<div style="background:'+bg+';border:1px solid '+bc+';border-left:4px solid '+bc+';border-radius:10px;padding:12px;margin-bottom:10px;cursor:pointer" onclick="navigateToTicker(\''+r.ticker+'\')">'
      +'<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">'
      +'<div><span style="font-family:var(--sans);font-size:18px;font-weight:700;color:var(--accent)">'+r.ticker+'</span>'+(r.price?'<span style="font-family:var(--mono);font-size:13px;color:var(--text2);margin-left:8px">$'+r.price.toFixed(2)+'</span>':'')+'</div>'
      +'<div style="text-align:right"><div style="font-family:var(--mono);font-size:11px;font-weight:600">'+r.signal.toUpperCase()+(sc!==''?' &middot; '+sc:'')+'</div>'+(r.ivrBadge||'')+'</div>'
      +'</div>'
      +renderCompBars(comps)
      +(rs?'<div style="display:flex;gap:16px;margin-bottom:8px;font-family:var(--mono)"><div><span style="font-size:9px;color:var(--text3);display:block">REC STRIKE</span><span style="font-size:14px">'+rs+'</span></div>'+(exp?'<div><span style="font-size:9px;color:var(--text3);display:block">EXPIRY</span><span style="font-size:12px;color:var(--text2)">'+exp+'</span></div>':'')+(apy?'<div><span style="font-size:9px;color:var(--text3);display:block">EST APY</span><span style="font-size:14px;color:var(--accent)">'+apy+'</span></div>':'')+'</div>':'')
      +(r.earningsDate?'<div style="font-family:var(--mono);font-size:11px;color:var(--warn);margin-bottom:6px">Earnings '+r.earningsDate+'</div>':'')
      +(r.narrative?'<div style="font-family:var(--mono);font-size:11px;color:var(--text2);line-height:1.6;border-top:1px solid rgba(255,255,255,0.05);padding-top:8px;margin-top:4px">'+r.narrative+'</div>':'')
      +'<div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:6px;text-align:right">Tap to analyze</div>'
      +'</div>';
  }).join('');
}

function _dashErr(t,msg){
  return{ticker:t,price:null,score:-99,signal:'error',factors:'No cached data',
    narrative:'Run Prefetch All first to populate cache for '+t,
    ivrBadge:'',earningsDate:null,recStrike:'--',expiration:'--',estApy:'--'};
}

// runDashboards: pure cache-based computation, no network calls.
// All required data is populated by prefetchAll / refreshSingleTicker.
function runDashboards(){
  if(!watchlist.length){toast('No tickers in watchlist');return;}
  const btn=document.getElementById('run-dashboard-btn');btn.disabled=true;
  document.getElementById('dashboard-progress').style.display='block';
  document.getElementById('dash-progress-bar').style.width='0%';
  document.getElementById('dash-progress-label').textContent='Scoring from cache...';
  const targetAPY=parseFloat(document.getElementById('target-apy').value)||12;
  const putResults=[],ccResults=[];
  const today=new Date();
  for(let i=0;i<watchlist.length;i++){
    const t=watchlist[i];
    document.getElementById('dash-progress-bar').style.width=Math.round(((i+1)/watchlist.length)*100)+'%';
    try{
      // ── All data from cache ────────────────────────────────────────────
      const snap=S.get('snap_'+t)||{};
      const price=snap.price||null;
      if(!price){putResults.push(_dashErr(t,'No cached price'));ccResults.push(_dashErr(t,'No cached price'));continue;}

      // 52W range -- from snap, fallback to hist2y (sliced to 1Y)
      let w52h=snap.week52High||null,w52l=snap.week52Low||null;
      let rsiVal=null,ma50=null,ma200=null,rangePos=null;
      const ch1=S.get('hist2y_'+t);
      if(ch1?.closes?.length){
        const closes=ch1.closes.slice(-252).filter(c=>c!=null&&c>0);
        if(closes.length>=21){
          const rsi=computeRSI(closes);rsiVal=rsi[rsi.length-1];
          if(closes.length>=50)ma50=avg(closes.slice(-50));
          if(closes.length>=200)ma200=avg(closes.slice(-200));
          if(!w52h||!w52l){w52h=w52h||Math.max(...closes);w52l=w52l||Math.min(...closes);}
          if(w52h&&w52l&&w52h>w52l)rangePos=(price-w52l)/(w52h-w52l);
        }
      }

      // IVR -- use persisted snap.ivrVal, recompute if missing
      let ivrVal=snap.ivrVal!=null?snap.ivrVal:computeIVR(t,w52h,w52l,price);
      if(ivrVal!=null&&snap.ivrVal==null){snap.ivrVal=ivrVal;S.set('snap_'+t,snap);}
      const ivr=ivrInfo(ivrVal);

      // Earnings date from snap
      const earningsDate=snap.earningsDate||null;
      const earningsHour=snap.earningsHour||null;
      const earningsTiming=earningsHour==='bmo'?' (before open)':earningsHour==='amc'?' (after close)':'';
      const earningsDisplay=earningsDate?earningsDate+earningsTiming:null;

      // Options: best put and call strikes from cached per-expiry chains
      let pRS=null,pExp=null,pApy=null,cRS=null,cExp=null,cApy=null;
      try{
        const oc=S.get('options_'+t);
        const yr=oc?.data?.optionChain?.result?.[0];
        if(yr&&price){
          const expDates=(yr.expirationDates||[]).map(ts=>new Date(ts*1000).toISOString().split('T')[0]);
          for(const exp of expDates.slice(0,3)){
            const ec=S.get('options_exp_'+t+'_'+exp);
            const res=ec?.optionChain?.result?.[0];
            if(!res)continue;
            const expD=new Date(exp+'T12:00:00Z');
            const dte=Math.max(Math.round((expD-today)/86400000),1);
            if(dte<25||dte>100)continue;
            if(!pRS&&res.options?.[0]?.puts){
              const puts=res.options[0].puts.filter(p=>{const s=p.strike,bid=p.bid||0,last=p.lastPrice||0,prem=(bid>0?bid:last)*100,apy=prem/(s*100)*(365/dte)*100,pct=(price-s)/price*100;return s<price&&pct>=4&&pct<=18&&apy>=targetAPY*0.7&&(p.openInterest||0)>=50;});
              if(puts.length){const best=puts.reduce((b,p)=>{const apyA=((p.bid||0)>0?p.bid:p.lastPrice||0)*100/(p.strike*100)*(365/dte)*100;const apyB=((b.bid||0)>0?b.bid:b.lastPrice||0)*100/(b.strike*100)*(365/dte)*100;return Math.abs(apyA-targetAPY)<Math.abs(apyB-targetAPY)?p:b;});const prem=((best.bid||0)>0?best.bid:best.lastPrice||0)*100;pRS='$'+formatStrike(best.strike);pExp=exp;pApy=(prem/(best.strike*100)*(365/dte)*100).toFixed(1)+'%';}
            }
            if(!cRS&&res.options?.[0]?.calls){
              const calls=res.options[0].calls.filter(c=>{const s=c.strike,bid=c.bid||0,last=c.lastPrice||0,prem=(bid>0?bid:last)*100,apy=prem/(price*100)*(365/dte)*100,pct=(s-price)/price*100;return s>price&&pct>=4&&pct<=18&&apy>=targetAPY*0.7&&(c.openInterest||0)>=50;});
              if(calls.length){const best=calls.reduce((b,c)=>{const apyA=((c.bid||0)>0?c.bid:c.lastPrice||0)*100/(price*100)*(365/dte)*100;const apyB=((b.bid||0)>0?b.bid:b.lastPrice||0)*100/(price*100)*(365/dte)*100;return Math.abs(apyA-targetAPY)<Math.abs(apyB-targetAPY)?c:b;});const prem=((best.bid||0)>0?best.bid:best.lastPrice||0)*100;cRS='$'+formatStrike(best.strike);cExp=exp;cApy=(prem/(price*100)*(365/dte)*100).toFixed(1)+'%';}
            }
            if(pRS&&cRS)break;
          }
        }
      }catch{}

      // OI gravity gap
      let oiGapPct=null,callOiGapPct=null;
      try{
        const opts=S.get('options_'+t)?.data?.optionChain?.result?.[0];
        if(opts&&price>0){
          const near=opts.options?.[0];
          if(near?.puts?.length){const maxP=near.puts.reduce((b,p)=>(!b||(p.openInterest||0)>(b.openInterest||0))?p:b,null);if(maxP?.strike)oiGapPct=(price-maxP.strike)/price*100;}
          if(near?.calls?.length){const maxC=near.calls.filter(c=>c.strike>price).reduce((b,c)=>(!b||(c.openInterest||0)>(b.openInterest||0))?c:b,null);if(maxC?.strike)callOiGapPct=(maxC.strike-price)/price*100;}
        }
      }catch{}

      const ps=scorePuts({price,rsiVal,ma50,ma200,rangePos,earningsDate:earningsDisplay,recStrike:pRS,expiration:pExp,estApy:pApy,ivrVal,ptMean:snap.ptMean||null,beta:snap.beta||null,oiGapPct});
      const cs=scoreCalls({price,rsiVal,ma50,ma200,rangePos,earningsDate:earningsDisplay,recStrike:cRS,expiration:cExp,estApy:cApy,ivrVal,ptMean:snap.ptMean||null,beta:snap.beta||null,oiGapPct:callOiGapPct});
      const common={ticker:t,price,ivrBadge:ivr.badge,ivrVal,earningsDate:earningsDisplay};
      putResults.push({...common,...ps});ccResults.push({...common,...cs});
    }catch(err){
      console.error('Dashboard error for '+t+':',err?.message);
      putResults.push(_dashErr(t,err?.message));ccResults.push(_dashErr(t,err?.message));
    }
  }
  // No sleep needed -- pure cache computation
  document.getElementById('dash-progress-bar').style.width='100%';
  document.getElementById('dash-progress-label').textContent='Done!';
  setTimeout(()=>{document.getElementById('dashboard-progress').style.display='none';},1500);
  btn.disabled=false;
  const _cmpConviction=(a,b)=>b.score-a.score||(b.ivrVal||0)-(a.ivrVal||0)||a.ticker.localeCompare(b.ticker);
  putResults.sort(_cmpConviction);ccResults.sort(_cmpConviction);
  const validPuts=putResults.filter(r=>r.signal!=='error');
  const validCC=ccResults.filter(r=>r.signal!=='error');
  if(validPuts.length===0&&validCC.length===0){
    const firstErr=putResults.find(r=>r.signal==='error')?.narrative||'';
    const errHint=firstErr?': '+firstErr.slice(0,50):'';
    toast('All tickers failed'+errHint,4500);
    const cp=S.get('conviction_puts'),cc=S.get('conviction_cc');
    if(cp)renderDashTable('put-dashboard-content',cp.results,cp.ts,false);
    if(cc)renderDashTable('cc-dashboard-content',cc.results,cc.ts,false);
    return;
  }
  const ts=nowPT(),tsEpoch=Date.now();S.set('conviction_puts',{results:putResults,ts,tsEpoch});S.set('conviction_cc',{results:ccResults,ts,tsEpoch});
  renderDashTable('put-dashboard-content',putResults,ts,true);renderDashTable('cc-dashboard-content',ccResults,ts,true);
  document.getElementById('put-dash-ts').innerHTML=tsChip(ts,true,tsEpoch);document.getElementById('cc-dash-ts').innerHTML=tsChip(ts,true,tsEpoch);
  toast('Both dashboards updated',3000);
}

// ── RSI Backtest view ─────────────────────────────────────────────────────

function _populateRSIBacktestDropdown(){
  const sel=document.getElementById('rsi-backtest-ticker-sel');
  if(!sel)return;
  // Only rebuild if the option count doesn't match the watchlist (+1 for
  // "Aggregate"), so we don't wipe out the user's current selection on
  // every toggle switch back to this view.
  if(sel.options.length===watchlist.length+1)return;
  const current=sel.value;
  const sorted=[...watchlist].sort((a,b)=>a.localeCompare(b));
  sel.innerHTML='<option value="">Aggregate (whole watchlist)</option>'+
    sorted.map(t=>`<option value="${t}">${t}</option>`).join('');
  if(sorted.includes(current))sel.value=current;
}

// Builds the HTML for one direction's (oversold/overbought) results block --
// shared by both the aggregate and individual-ticker views, since they use
// the exact same data shape.
function _rsiBacktestDirectionHtml(label,color,data){
  if(!data||!data.occurrences){
    return `<div style="font-family:var(--mono);font-size:11px;color:var(--text3);margin-bottom:10px">${label}: no occurrences found in the available history.</div>`;
  }
  const rows=RSI_BACKTEST_WINDOWS.map(n=>{
    const w=data.windows[n];
    if(!w)return `<div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:11px;color:var(--text3);padding:3px 0">${n}-day fwd: not enough data</div>`;
    const retColor=w.avgReturn>=0?'var(--green)':'var(--red)';
    const excStr=w.excess!=null?` <span style="font-size:9px;font-weight:400;color:var(--text3)">exc ${w.excess>=0?'+':''}${w.excess.toFixed(1)}%</span>`:'';
    return `<div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:11px;padding:3px 0;border-bottom:1px solid var(--surface3)">
      <span style="color:var(--text2)">${n}-day fwd</span>
      <span style="text-align:right">
        <span style="color:${retColor};font-weight:600">${w.avgReturn>=0?'+':''}${w.avgReturn.toFixed(2)}%</span>${excStr}
        <span style="color:var(--text3);display:block;font-size:10px">${w.pctPositive.toFixed(0)}% positive</span>
      </span>
    </div>`;
  }).join('');
  return `<div style="margin-bottom:14px">
    <div style="font-family:var(--mono);font-size:11px;font-weight:600;color:${color};margin-bottom:4px">${label} -- ${data.occurrences} occurrence${data.occurrences!==1?'s':''}</div>
    ${rows}
  </div>`;
}

function renderRSIBacktest(){
  const content=document.getElementById('rsi-backtest-content');
  if(!content)return;
  const sel=document.getElementById('rsi-backtest-ticker-sel');
  const selectedTicker=sel?.value||'';

  if(!watchlist.length){
    content.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>Watchlist is empty</div>';
    return;
  }

  if(!selectedTicker){
    // Aggregate view
    const agg=_computeRSIBacktestAggregate(watchlist);
    if(!agg.tickersWithData){
      content.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>No cached price history yet -- run Prefetch All or Full Refresh first.</div>';
      return;
    }
    content.innerHTML=`
      <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:10px">Pooled across ${agg.tickersWithData} of ${agg.tickersTotal} watchlist tickers with sufficient history.</div>
      ${_rsiBacktestDirectionHtml('Oversold -- entering (RSI&lt;'+RSI_OVERSOLD_THRESHOLD+')','var(--green)',agg.oversoldEnter)}
      ${_rsiBacktestDirectionHtml('Oversold -- leaving','var(--green)',agg.oversoldExit)}
      ${_rsiBacktestDirectionHtml('Overbought -- entering (RSI&gt;'+RSI_OVERBOUGHT_THRESHOLD+')','var(--red)',agg.overboughtEnter)}
      ${_rsiBacktestDirectionHtml('Overbought -- leaving','var(--red)',agg.overboughtExit)}
    `;
  }else{
    // Individual ticker view
    const result=_computeRSIBacktestForTicker(selectedTicker);
    if(!result){
      content.innerHTML=`<div class="empty"><div class="empty-icon">&#x1F4CA;</div>Not enough cached history for ${selectedTicker} yet.</div>`;
      return;
    }
    const totalEvents=result.oversoldEnter.occurrences+result.oversoldExit.occurrences+result.overboughtEnter.occurrences+result.overboughtExit.occurrences;
    content.innerHTML=`
      <div style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--text);margin-bottom:4px">${selectedTicker}</div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--warn);margin-bottom:10px">&#x26A0; Single-ticker sample -- based on ${totalEvents} total events across ${result.totalDays} trading days. Small sample, directional intuition only, not statistically robust.</div>
      ${_rsiBacktestDirectionHtml('Oversold -- entering (RSI&lt;'+RSI_OVERSOLD_THRESHOLD+')','var(--green)',result.oversoldEnter)}
      ${_rsiBacktestDirectionHtml('Oversold -- leaving','var(--green)',result.oversoldExit)}
      ${_rsiBacktestDirectionHtml('Overbought -- entering (RSI&gt;'+RSI_OVERBOUGHT_THRESHOLD+')','var(--red)',result.overboughtEnter)}
      ${_rsiBacktestDirectionHtml('Overbought -- leaving','var(--red)',result.overboughtExit)}
    `;
  }
}

// ── RSI Ranking (which tickers show the strongest signal) ────────────────

function _rsiRankingRowsHtml(rows,color){
  if(!rows.length){
    return `<div style="font-family:var(--mono);font-size:11px;color:var(--text3);padding:6px 0">No tickers currently qualify (need at least 4 historical episodes).</div>`;
  }
  return rows.map(r=>{
    const excColor=r.excess>=0?'var(--green)':'var(--red)';
    return `<div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:11px;padding:4px 0;border-bottom:1px solid var(--surface3)">
      <span style="color:var(--text);font-weight:600;cursor:pointer" onclick="navigateToTicker('${r.ticker}')">${r.ticker}</span>
      <span style="color:var(--text3);font-size:10px">${r.occurrences} ep.</span>
      <span style="text-align:right">
        <span style="color:${r.avgReturn>=0?'var(--green)':'var(--red)'}">${r.avgReturn>=0?'+':''}${r.avgReturn.toFixed(2)}%</span>
        <span style="color:${excColor};font-size:10px"> exc ${r.excess>=0?'+':''}${r.excess.toFixed(1)}%</span>
      </span>
    </div>`;
  }).join('');
}

function renderRSIRanking(){
  const content=document.getElementById('rsi-ranking-content');
  if(!content)return;
  if(!watchlist.length){
    content.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>Watchlist is empty</div>';
    return;
  }
  const windowSel=document.getElementById('rsi-ranking-window-sel');
  const phaseSel=document.getElementById('rsi-ranking-phase-sel');
  const window=parseInt(windowSel?.value||'10',10);
  const phase=phaseSel?.value||'Exit'; // 'Enter' or 'Exit'
  const phaseLabel=phase==='Enter'?'Entering':'Leaving';

  const oversoldRanking=_computeRSIBacktestRanking(watchlist,'oversold'+phase,window,4);
  // Overbought "downside" ranking: worst (most negative) excess first --
  // most attractive for covered-call timing -- so reverse the base sort.
  const overboughtRanking=_computeRSIBacktestRanking(watchlist,'overbought'+phase,window,4).slice().reverse();

  content.innerHTML=`
    <div style="margin-bottom:14px">
      <div style="font-family:var(--mono);font-size:11px;font-weight:600;color:var(--green);margin-bottom:4px">Oversold ${phaseLabel} -- biggest upside</div>
      ${_rsiRankingRowsHtml(oversoldRanking,'var(--green)')}
    </div>
    <div>
      <div style="font-family:var(--mono);font-size:11px;font-weight:600;color:var(--red);margin-bottom:4px">Overbought ${phaseLabel} -- biggest downside</div>
      ${_rsiRankingRowsHtml(overboughtRanking,'var(--red)')}
    </div>
  `;
}

// ── Assignment Risk view ──────────────────────────────────────────────────

function renderAssignmentRisk(){
  const content=document.getElementById('assignment-risk-content');
  if(!content)return;
  const rows=_computeAssignmentRisk();
  if(!rows.length){
    content.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>No positions currently ITM</div>';
    return;
  }
  content.innerHTML=rows.map(r=>{
    const kindLabel=r.isCall?'Call':'Put';
    const urgentColor=r.daysToExpiry<=7?'var(--red)':r.daysToExpiry<=21?'var(--warn)':'var(--text2)';
    const tvStr=r.timeValue!=null?'$'+r.timeValue.toFixed(0):'--';
    const earningsStr=r.earningsFlag?`<span style="color:var(--warn)">&#x26A0; Earnings ${r.earningsFlag}</span>`:'';
    return`<div style="padding:8px 0;border-bottom:1px solid var(--surface3)">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-family:var(--mono);font-size:12px;font-weight:600;cursor:pointer" onclick="navigateToTicker('${r.ticker}')">${r.ticker}</span>
        <span style="font-family:var(--mono);font-size:9px;color:var(--text3);cursor:pointer;text-decoration:underline" onclick="navigateToAccount('${r.accountId}')">${r.accountName}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:11px;margin-top:3px">
        <span style="color:var(--text2)">${kindLabel} $${formatStrike(r.strike)} vs $${r.currentPrice.toFixed(2)}</span>
        <span style="color:var(--accent);font-weight:600">${r.itmPct.toFixed(1)}% ITM</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:2px">
        <span style="color:${urgentColor}">${r.daysToExpiry}d to expiry</span>
        <span>Time value: ${tvStr}</span>
      </div>
      ${earningsStr?`<div style="font-family:var(--mono);font-size:10px;margin-top:2px">${earningsStr}</div>`:''}
    </div>`;
  }).join('');
}

// ── Gap Fill view ──────────────────────────────────────────────────────────

function _populateGapFillDropdown(){
  const sel=document.getElementById('gap-fill-ticker-sel');
  if(!sel)return;
  if(sel.options.length===watchlist.length+1)return;
  const current=sel.value;
  const sorted=[...watchlist].sort((a,b)=>a.localeCompare(b));
  sel.innerHTML='<option value="">Aggregate (whole watchlist)</option>'+
    sorted.map(t=>`<option value="${t}">${t}</option>`).join('');
  if(sorted.includes(current))sel.value=current;
}

// Shared block for one direction's (up/down) fill-rate summary -- same data
// shape used by both the aggregate and individual-ticker views.
function _gapFillDirectionHtml(label,color,data){
  if(!data||!data.count){
    return `<div style="font-family:var(--mono);font-size:11px;color:var(--text3);margin-bottom:10px">${label}: no qualifying gaps found in the available history.</div>`;
  }
  const fillStr=data.fillRate!=null?data.fillRate.toFixed(0)+'%':'--';
  const avgDaysStr=data.avgDaysToFill!=null?data.avgDaysToFill.toFixed(1)+' days avg':'--';
  return `<div style="margin-bottom:14px">
    <div style="font-family:var(--mono);font-size:11px;font-weight:600;color:${color};margin-bottom:4px">${label} -- ${data.count} gap${data.count!==1?'s':''}</div>
    <div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:11px;padding:3px 0;border-bottom:1px solid var(--surface3)">
      <span style="color:var(--text2)">Filled</span>
      <span style="text-align:right">
        <span style="color:var(--text);font-weight:600">${data.filledCount} / ${data.count} (${fillStr})</span>
        <span style="color:var(--text3);display:block;font-size:10px">${avgDaysStr}, when filled</span>
      </span>
    </div>
  </div>`;
}

// One row per individual gap event -- used only in the single-ticker view,
// where seeing each occurrence (not just the summary) is useful given how
// few events there typically are for one ticker.
function _gapEventRowHtml(ticker,e,hist2y){
  // hist2y.timestamps can arrive as either raw epoch-seconds numbers
  // (dashboard's direct S.get() path) or already-converted Date objects
  // (ticker page's rebuilt hist2y) -- accept both rather than assuming one,
  // same defensive pattern already used elsewhere in ticker.js. Getting
  // this wrong double-converts a Date into a garbage year that a
  // month/day-only format then silently hides -- so the year is included
  // below specifically to make that class of bug visible if it recurs.
  const raw=hist2y?.timestamps?.[e.index];
  const d=raw==null?null:(raw instanceof Date?raw:new Date(typeof raw==='number'&&raw<1e10?raw*1000:raw));
  const dateStr=d?d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'';
  const color=e.direction==='up'?'var(--green)':'var(--red)';
  const statusStr=e.filled?(e.daysToFill===0?'Filled same day':`Filled in ${e.daysToFill}d`):`Open -- ${e.daysSince}d ago`;
  const statusColor=e.filled?'var(--text3)':'var(--warn)';
  const rangeStr=`$${Math.min(e.prevClose,e.open).toFixed(2)} \u2013 $${Math.max(e.prevClose,e.open).toFixed(2)}`;
  return `<div style="padding:4px 0;border-bottom:1px solid var(--surface3)">
    <div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:11px">
      <span style="color:var(--text3)">${dateStr}</span>
      <span style="color:${color};font-weight:600">${e.direction==='up'?'+':''}${e.gapPct.toFixed(1)}%</span>
      <span style="color:${statusColor}">${statusStr}</span>
    </div>
    <div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-top:1px">${rangeStr}</div>
  </div>`;
}

function renderGapFillDashboard(){
  const content=document.getElementById('gap-fill-content');
  if(!content)return;
  const sel=document.getElementById('gap-fill-ticker-sel');
  const selectedTicker=sel?.value||'';

  if(!watchlist.length){
    content.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>Watchlist is empty</div>';
    return;
  }

  if(!selectedTicker){
    const agg=_computeGapAggregate(watchlist);
    if(!agg.tickersWithData){
      content.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>No cached price history with Open/High/Low yet -- run Prefetch All or Full Refresh first.</div>';
      return;
    }
    content.innerHTML=`
      <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:10px">Pooled across ${agg.tickersWithData} of ${agg.tickersTotal} watchlist tickers with sufficient history.</div>
      ${_gapFillDirectionHtml('Gap Up','var(--green)',agg.up)}
      ${_gapFillDirectionHtml('Gap Down','var(--red)',agg.down)}
    `;
  }else{
    const result=_computeGapSummaryForTicker(selectedTicker);
    if(!result){
      content.innerHTML=`<div class="empty"><div class="empty-icon">&#x1F4CA;</div>No cached price history with Open/High/Low for ${selectedTicker} yet.</div>`;
      return;
    }
    if(!result.totalGaps){
      content.innerHTML=`<div class="empty"><div class="empty-icon">&#x1F4CA;</div>No gaps &ge;${GAP_SIZE_THRESHOLD_PCT}% found for ${selectedTicker} in the available history.</div>`;
      return;
    }
    const hist2y=S.get('hist2y_'+selectedTicker);
    const allEventsDesc=[...result.events].reverse(); // most recent first
    const filterMode=getGapListFilterMode();
    const eventsDesc=filterMode==='open'?allEventsDesc.filter(e=>!e.filled):allEventsDesc;
    const listLabel=filterMode==='open'?`Open gaps (${eventsDesc.length})`:`All gaps (${result.totalGaps})`;
    const filterBtn=(mode,lbl)=>`<button class="btn btn-secondary" style="font-size:9px;padding:2px 6px;opacity:${filterMode===mode?'1':'0.4'}" onclick="setGapListFilterMode('${mode}')">${lbl}</button>`;
    content.innerHTML=`
      <div style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--text);margin-bottom:4px">${selectedTicker}</div>
      <div style="font-family:var(--mono);font-size:10px;color:var(--warn);margin-bottom:10px">&#x26A0; Single-ticker sample -- ${result.totalGaps} total gaps found. Small sample, directional intuition only, not statistically robust.</div>
      ${_gapFillDirectionHtml('Gap Up','var(--green)',result.up)}
      ${_gapFillDirectionHtml('Gap Down','var(--red)',result.down)}
      <div style="display:flex;justify-content:space-between;align-items:center;margin:10px 0 4px">
        <span style="font-family:var(--mono);font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px">${listLabel}</span>
        <div style="display:flex;gap:4px">${filterBtn('all','All')}${filterBtn('open','Open Only')}</div>
      </div>
      <div id="gap-fill-list-dash" style="max-height:180px;overflow-y:auto;">${eventsDesc.length?eventsDesc.map(e=>_gapEventRowHtml(selectedTicker,e,hist2y)).join(''):'<div style="font-family:var(--mono);font-size:10px;color:var(--text3);padding:6px 0">No open gaps right now.</div>'}</div>
    `;
  }
}

// ── Notes view ────────────────────────────────────────────────────────────
// Freeform, not tied to any ticker -- no length limit by design (unlike the
// per-ticker watchlist notes, which are intentionally short). Auto-saves on
// input with a short debounce, rather than requiring an explicit Save
// action, since this is meant to feel like a persistent scratchpad.

let _dashNotesSaveTimer=null;

function renderDashboardNotes(){
  const ta=document.getElementById('dash-notes-text');
  if(!ta)return;
  ta.value=S.get('dashboard_notes')||'';
  const status=document.getElementById('dash-notes-status');
  if(status)status.innerHTML='&nbsp;';
}

function _saveDashboardNotes(){
  const ta=document.getElementById('dash-notes-text');
  const status=document.getElementById('dash-notes-status');
  if(!ta)return;
  if(status)status.textContent='Saving...';
  clearTimeout(_dashNotesSaveTimer);
  _dashNotesSaveTimer=setTimeout(()=>{
    S.set('dashboard_notes',ta.value);
    if(status)status.textContent='Saved '+new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
  },500);
}
