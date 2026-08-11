// Income Engine -- wheelbacktest.js
// Wheel Backtest: simulates the wheel strategy (CSP -> assignment -> CC ->
// called away -> repeat) against real historical price history, using
// Black-Scholes premiums (helpers.js) with realized volatility standing in
// for implied volatility -- the best available approximation without paid
// historical options-chain data. This is a real, documented simplification
// (see the "Premium source" label always shown alongside results) with a
// few known biases:
//   - Realized vol typically understates implied vol (the volatility risk
//     premium), so simulated premiums likely run somewhat LOW versus what
//     was actually available historically -- a conservative bias.
//   - No bid-ask spread, no volatility skew, no early assignment around
//     dividends (all explicitly out of scope for this version).
// Settlement is European-style (checked only at expiration), not
// day-by-day intraday touches -- matches the "no early assignment" scope.
// Globals used: S, _bsPutPrice, _bsCallPrice, _bsPutDelta, _bsCallDelta,
// _solveStrikeForDelta, _realizedVolAsOf, _getTBillYield

// Simulates ONE option cycle (either a put or a call) starting at a given
// index in the price history. No lookahead beyond entryIdx for pricing;
// the outcome is only revealed by looking at the actual historical price
// at the (simulated) expiration index.
function _simulateOneCycle(hist2y,entryIdx,dte,targetDeltaAbs,optionType,r){
  const closes=hist2y.closes;
  const n=closes.length;
  const S0=closes[entryIdx];
  if(S0==null||S0<=0)return null;
  const sigma=_realizedVolAsOf(closes,entryIdx,21);
  if(sigma==null||sigma<=0)return null;
  const T=dte/365;
  const K=_solveStrikeForDelta(S0,T,r,sigma,targetDeltaAbs,optionType);
  if(K==null||!isFinite(K))return null;
  const premium=optionType==='put'?_bsPutPrice(S0,K,T,r,sigma):_bsCallPrice(S0,K,T,r,sigma);
  if(!isFinite(premium)||premium<0)return null;

  // Convert calendar DTE to an approximate trading-day offset within the
  // (trading-day-indexed) price history.
  const tradingDaysOut=Math.max(1,Math.round(dte*252/365));
  const exitIdx=Math.min(entryIdx+tradingDaysOut,n-1);
  const dataExhausted=exitIdx<entryIdx+tradingDaysOut; // ran out of history before a full expiry
  const priceAtExit=closes[exitIdx];
  if(priceAtExit==null)return null;
  const assigned=optionType==='put'?(priceAtExit<K):(priceAtExit>K);

  return{entryIdx,exitIdx,optionType,strike:K,premium,spotAtEntry:S0,priceAtExit,assigned,dataExhausted};
}

// Chains cycles across a roughly-one-year window starting at startIdx:
// sells puts until assigned, then sells calls against the resulting shares
// until called away, then reverts to puts -- repeating until either the
// window's ~1 year is used up or the available price history runs out.
function _simulateWheelWindow(hist2y,startIdx,dte,targetDeltaAbs,r){
  const closes=hist2y.closes;
  const startPrice=closes[startIdx];
  if(startPrice==null||startPrice<=0)return null;

  const trades=[];
  let curIdx=startIdx;
  let mode='put';
  let costBasis=null;
  let cumPremium=0;
  let realizedShareGainLoss=0;
  const tradingDaysInYear=252;

  while(true){
    const cyc=_simulateOneCycle(hist2y,curIdx,dte,targetDeltaAbs,mode,r);
    if(!cyc)break; // insufficient data (e.g. vol undefined this early in history) -- stop here
    trades.push(cyc);
    cumPremium+=cyc.premium;

    if(mode==='put'){
      if(cyc.assigned){
        costBasis=cyc.strike-cyc.premium;
        mode='call';
      }
    }else{ // mode === 'call'
      if(cyc.assigned){
        realizedShareGainLoss+=(cyc.strike-costBasis);
        costBasis=null;
        mode='put';
      }
    }

    curIdx=cyc.exitIdx;
    if(cyc.dataExhausted)break;
    if(curIdx>=startIdx+tradingDaysInYear)break; // let the in-progress cycle finish naturally, then stop
  }

  if(!trades.length)return null;
  const endIdx=trades[trades.length-1].exitIdx;
  const elapsedTradingDays=endIdx-startIdx;
  const elapsedCalendarDaysApprox=elapsedTradingDays*365/tradingDaysInYear;
  const endPrice=closes[endIdx];
  if(endPrice==null||elapsedCalendarDaysApprox<=0)return null;

  // If still holding shares (mid-CC-cycle) at window end, mark unrealized
  // gain/loss vs cost basis so the total isn't silently missing that leg.
  const unrealizedShareGainLoss=costBasis!=null?(endPrice-costBasis):0;
  const totalPnL=cumPremium+realizedShareGainLoss+unrealizedShareGainLoss;

  // Capital base: the starting spot price, as a per-share reference (real
  // cash-secured collateral is ~strike*100/contract; anchoring to a fixed
  // starting reference rather than a fluctuating per-cycle strike is the
  // simpler, standard convention for a single headline return figure, same
  // spirit as an index anchored to a fixed base value).
  const simpleReturn=totalPnL/startPrice;
  // Simple/linear annualizing -- NOT compounded -- to match the app's own
  // existing target-APY convention (_calcIncome's putsIncome is a flat
  // notional * APY calc, no compounding), so this stays directly
  // comparable to that number rather than introducing a math-convention
  // mismatch alongside the data-quality one that already exists.
  const annualizedReturnPct=simpleReturn*(365/elapsedCalendarDaysApprox)*100;

  const assignedCount=trades.filter(t=>t.assigned).length;
  const assignmentRatePct=trades.length?assignedCount/trades.length*100:0;

  const buyHoldReturn=(endPrice-startPrice)/startPrice;
  const buyHoldAnnualizedPct=buyHoldReturn*(365/elapsedCalendarDaysApprox)*100;

  return{
    startIdx,endIdx,trades,cyclesRun:trades.length,
    annualizedReturnPct,assignmentRatePct,buyHoldAnnualizedPct,
    elapsedCalendarDaysApprox,
  };
}

// Runs _simulateWheelWindow from many starting points across the available
// history (not a single cherry-pickable date), collecting the distribution
// of outcomes. Only windows that ran close to a full year count toward the
// headline stats -- a window truncated by running out of history early
// would understate/skew the annualized figure and isn't a fair comparison
// to the full-length ones.
function _computeWheelBacktest(ticker,dte,targetDeltaAbs){
  const h2=S.get('hist2y_'+ticker);
  if(!h2?.closes?.length||!h2.opens||!h2.highs||!h2.lows)return null;
  const n=h2.closes.length;
  const rRaw=_getTBillYield();
  const r=(rRaw!=null?rRaw:4.0)/100; // fallback if T-bill cache unavailable; rate has a small effect on BS price relative to sigma
  const stepDays=10;
  const MIN_COMPLETE_DAYS=300; // ~a full year, allowing some slack for the DTE-vs-365 remainder

  const windows=[];
  for(let startIdx=21;startIdx<=n-2;startIdx+=stepDays){
    const win=_simulateWheelWindow(h2,startIdx,dte,targetDeltaAbs,r);
    if(win&&win.elapsedCalendarDaysApprox>=MIN_COMPLETE_DAYS)windows.push(win);
  }
  if(!windows.length)return null;

  const annReturns=windows.map(w=>w.annualizedReturnPct).sort((a,b)=>a-b);
  const median=annReturns[Math.floor(annReturns.length/2)];
  const worst=annReturns[0];
  const best=annReturns[annReturns.length-1];
  const avgAssignmentRate=windows.reduce((s,w)=>s+w.assignmentRatePct,0)/windows.length;
  const avgAnnReturn=annReturns.reduce((s,v)=>s+v,0)/annReturns.length;
  const avgBuyHold=windows.reduce((s,w)=>s+w.buyHoldAnnualizedPct,0)/windows.length;

  return{
    ticker,dte,targetDeltaAbs,sampleSize:windows.length,
    median,worst,best,avgAssignmentRate,avgAnnReturn,avgBuyHold,
    vsBuyHold:avgAnnReturn-avgBuyHold,
    recentCycles:windows[windows.length-1].trades.slice(-8),
    recentCyclesHist2y:h2,
  };
}

// Pools windows across every ticker in the given list into one combined
// distribution -- mirrors Gap Fill's aggregate approach (pool raw events,
// not an average of each ticker's own summary stat) for a much larger,
// more statistically meaningful sample than any single ticker offers.
function _computeWheelBacktestAggregate(tickers,dte,targetDeltaAbs){
  const rRaw=_getTBillYield();
  const r=(rRaw!=null?rRaw:4.0)/100;
  const stepDays=10;
  const MIN_COMPLETE_DAYS=300;
  let allReturns=[];
  let allAssignmentRates=[];
  let allBuyHold=[];
  let tickersWithData=0;
  let lastTickerCycles=null,lastTicker=null;

  tickers.forEach(t=>{
    const h2=S.get('hist2y_'+t);
    if(!h2?.closes?.length||!h2.opens||!h2.highs||!h2.lows)return;
    const n=h2.closes.length;
    let gotAny=false;
    for(let startIdx=21;startIdx<=n-2;startIdx+=stepDays){
      const win=_simulateWheelWindow(h2,startIdx,dte,targetDeltaAbs,r);
      if(win&&win.elapsedCalendarDaysApprox>=MIN_COMPLETE_DAYS){
        allReturns.push(win.annualizedReturnPct);
        allAssignmentRates.push(win.assignmentRatePct);
        allBuyHold.push(win.buyHoldAnnualizedPct);
        gotAny=true;
        lastTickerCycles=win.trades.slice(-8);lastTicker=t;
      }
    }
    if(gotAny)tickersWithData++;
  });

  if(!allReturns.length)return null;
  allReturns.sort((a,b)=>a-b);
  const median=allReturns[Math.floor(allReturns.length/2)];
  const worst=allReturns[0];
  const best=allReturns[allReturns.length-1];
  const avgAnnReturn=allReturns.reduce((s,v)=>s+v,0)/allReturns.length;
  const avgAssignmentRate=allAssignmentRates.reduce((s,v)=>s+v,0)/allAssignmentRates.length;
  const avgBuyHold=allBuyHold.reduce((s,v)=>s+v,0)/allBuyHold.length;

  return{
    dte,targetDeltaAbs,sampleSize:allReturns.length,tickersWithData,tickersTotal:tickers.length,
    median,worst,best,avgAssignmentRate,avgAnnReturn,avgBuyHold,
    vsBuyHold:avgAnnReturn-avgBuyHold,
    recentCycles:lastTickerCycles,recentCyclesTicker:lastTicker,
  };
}

// ── Dashboard UI ─────────────────────────────────────────────────────────
// Same conventions already established by Gap Fill/RSI Backtest: a scope
// dropdown (aggregate vs. one ticker), a span-style toggle row (here: DTE
// instead of a chart timeframe), a hero stat, and a supporting detail list.
// The 30-delta target used throughout matches this app's existing wheel
// mechanics conventions (Conviction Scoring, ITM Risk) rather than
// introducing a separate delta setting to configure.
const WHEELBT_TARGET_DELTA=0.30;
const WHEELBT_DEFAULT_TARGET_APY=12; // matches _calcIncome's own fallback default

function _populateWheelBacktestDropdown(){
  const sel=document.getElementById('wheelbt-ticker-sel');
  if(!sel)return;
  if(sel.options.length===watchlist.length+1)return;
  const current=sel.value;
  const sorted=[...watchlist].sort((a,b)=>a.localeCompare(b));
  sel.innerHTML='<option value="">Aggregate (whole watchlist)</option>'+
    sorted.map(t=>`<option value="${t}">${t}</option>`).join('');
  if(sorted.includes(current))sel.value=current;
}

function getWheelBacktestDTE(){return parseInt(S.get('wheelbt_dte'))||45;}
function setWheelBacktestDTE(dte){
  S.set('wheelbt_dte',dte);
  [30,45,60,90].forEach(d=>{
    const btn=document.getElementById('wheelbt-dte-'+d);
    if(btn)btn.style.opacity=(d===dte)?'1':'0.4';
  });
  renderWheelBacktest();
}

// Horizontal worst/median/best range, with a marker at the user's own
// target APY so the comparison this whole feature exists for -- "does my
// 12% target sit inside what actually happened historically" -- is visual
// rather than something requiring separately reading two numbers.
function _wheelBacktestDistributionSvg(worst,median,best,target){
  const lo=Math.min(worst,target)-2,hi=Math.max(best,target)+2; // pad the range so the target marker never sits at the very edge
  const toX=(v)=>10+((v-lo)/(hi-lo))*352;
  const worstX=toX(worst),medX=toX(median),bestX=toX(best),targetX=toX(target);
  const barLo=Math.min(worstX,medX),barHi=Math.max(medX,bestX);
  return`<svg viewBox="0 0 372 56" width="100%" height="56" style="margin-bottom:2px">
    <line x1="10" y1="30" x2="362" y2="30" stroke="var(--surface3)" stroke-width="1"/>
    <line x1="${worstX}" y1="20" x2="${worstX}" y2="40" stroke="var(--red)" stroke-width="1.5"/>
    <rect x="${Math.min(worstX,barLo)}" y="24" width="${Math.max(bestX,barHi)-Math.min(worstX,barLo)}" height="12" fill="var(--surface3)"/>
    <rect x="${barLo}" y="24" width="${barHi-barLo}" height="12" fill="var(--accent)" fill-opacity="0.5"/>
    <line x1="${medX}" y1="16" x2="${medX}" y2="44" stroke="var(--accent)" stroke-width="2"/>
    <line x1="${bestX}" y1="20" x2="${bestX}" y2="40" stroke="var(--green)" stroke-width="1.5"/>
    <line x1="${targetX}" y1="8" x2="${targetX}" y2="48" stroke="var(--warn)" stroke-width="1.5" stroke-dasharray="3,2"/>
    <text x="${worstX}" y="52" fill="var(--red)" font-size="8" text-anchor="middle">${worst.toFixed(1)}%</text>
    <text x="${medX}" y="12" fill="var(--accent)" font-size="8" text-anchor="middle">${median.toFixed(1)}% med</text>
    <text x="${bestX}" y="52" fill="var(--green)" font-size="8" text-anchor="middle">${best.toFixed(1)}%</text>
    <text x="${targetX}" y="6" fill="var(--warn)" font-size="8" text-anchor="middle">target ${target}%</text>
  </svg>`;
}

function _wheelBacktestCycleRowHtml(t,hist2y){
  const toDateStr=d=>{if(d==null)return'';if(d instanceof Date)return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});return new Date(typeof d==='number'&&d<1e10?d*1000:d).toLocaleDateString('en-US',{month:'short',day:'numeric'});};
  const dateStr=hist2y?toDateStr(hist2y.timestamps?.[t.entryIdx]):'';
  const label=t.optionType==='put'?'CSP':'CC';
  const outcome=t.assigned?(t.optionType==='put'?'Assigned':'Called away'):'Expired worthless';
  const outcomeColor=t.assigned?'var(--warn)':'var(--green)';
  return`<div style="display:flex;justify-content:space-between;font-size:10px;padding:4px 0;border-bottom:1px solid var(--surface3)">
    <span style="color:var(--text3)">${dateStr}</span>
    <span style="color:var(--text2)">${label} $${t.strike.toFixed(2)}</span>
    <span style="color:${outcomeColor}">${outcome}</span>
  </div>`;
}

function renderWheelBacktest(){
  const content=document.getElementById('wheelbt-content');
  if(!content)return;
  const sel=document.getElementById('wheelbt-ticker-sel');
  const selectedTicker=sel?.value||'';
  const dte=getWheelBacktestDTE();
  const target=WHEELBT_DEFAULT_TARGET_APY;

  if(!watchlist.length){
    content.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>Watchlist is empty</div>';
    return;
  }
  content.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>Computing...</div>';

  // Synchronous but potentially non-trivial (many simulated cycles across
  // many rolling starts, times every watchlist ticker for aggregate) --
  // deferred one tick so the "Computing..." state actually paints first
  // rather than the whole thing blocking in one frame.
  setTimeout(()=>{
    let result,isAggregate=!selectedTicker;
    if(isAggregate){
      result=_computeWheelBacktestAggregate(watchlist,dte,WHEELBT_TARGET_DELTA);
    }else{
      result=_computeWheelBacktest(selectedTicker,dte,WHEELBT_TARGET_DELTA);
    }

    if(!result){
      content.innerHTML=`<div class="empty"><div class="empty-icon">&#x1F4CA;</div>Not enough cached price history with Open/High/Low to complete a full-year simulation${isAggregate?' for any watchlist ticker':' for '+selectedTicker}. Run Prefetch All or Full Refresh first, and allow time for 2 years of history to accumulate.</div>`;
      return;
    }

    const scopeLabel=isAggregate?`Pooled across ${result.tickersWithData} of ${result.tickersTotal} watchlist tickers`:`${selectedTicker} only -- small single-ticker sample, directional intuition only`;
    const vsColor=result.vsBuyHold>=0?'var(--green)':'var(--red)';

    content.innerHTML=`
      <div style="font-family:var(--mono);font-size:10px;color:${isAggregate?'var(--text3)':'var(--warn)'};margin-bottom:10px">${isAggregate?'':'&#x26A0; '}${scopeLabel} &middot; ${result.sampleSize} simulated windows</div>
      ${_wheelBacktestDistributionSvg(result.worst,result.median,result.best,target)}
      <div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-bottom:12px">worst &middot; median &middot; best window (annualized, ~1yr each, ${dte}d cycles) vs. your ${target}% target</div>
      <div style="display:flex;justify-content:space-between;font-size:10px;padding:5px 0;border-top:1px solid var(--surface3)">
        <span style="color:var(--text2)">Assignment rate</span><span style="color:var(--text)">${result.avgAssignmentRate.toFixed(0)}%</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;padding:5px 0;border-top:1px solid var(--surface3)">
        <span style="color:var(--text2)">vs. Buy &amp; Hold (same windows)</span><span style="color:${vsColor}">${result.vsBuyHold>=0?'+':''}${result.vsBuyHold.toFixed(1)}pp avg</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;padding:5px 0;border-top:1px solid var(--surface3);margin-bottom:12px">
        <span style="color:var(--text2)">Premium source</span><span style="color:var(--warn)">Realized vol (approx.)</span>
      </div>
      <div style="font-family:var(--mono);font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Recent Simulated Cycles${result.recentCyclesTicker?' ('+result.recentCyclesTicker+')':''}</div>
      <div style="max-height:160px;overflow-y:auto">${(result.recentCycles||[]).map(t=>_wheelBacktestCycleRowHtml(t,S.get('hist2y_'+(isAggregate?result.recentCyclesTicker:selectedTicker)))).join('')||'<div style="font-family:var(--mono);font-size:10px;color:var(--text3);padding:6px 0">No cycles to show.</div>'}</div>
    `;
  },10);
}
