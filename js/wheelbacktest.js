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
//   - No bid-ask spread, no volatility skew beyond the estimated term
//     structure adjustment below, no early assignment around dividends
//     (all explicitly out of scope for this version).
// Settlement is European-style (checked only at expiration), not
// day-by-day intraday touches -- matches the "no early assignment" scope.
//
// Strike selection targets a yield floor (WHEELBT_DEFAULT_TARGET_APY),
// not a fixed delta: each cycle picks the strike closest to that target
// annualized yield while still clearing it. If the preferred expiration
// (from the toggle) can't clear the floor, tries the other expirations
// within the 1-3 month range -- shorter or longer, whichever actually
// works, prioritized by closeness to the preference -- and if none of
// those clear it either, waits for a later trading day and repeats the
// whole search there. See _estimateTermStructureSlope for why extending
// duration can genuinely help (not just cost annualized efficiency) --
// it requires a real, ticker-specific volatility term structure estimate,
// not just more calendar time on a flat vol assumption.
//
// Globals used: S, _bsPutPrice, _bsCallPrice, _bsPutDelta, _bsCallDelta,
// _solveStrikeForYieldFloor, _realizedVolAsOf, _getTBillYield

// Strike selection targets a yield floor now (see _solveStrikeForYieldFloor
// in helpers.js), not a fixed delta -- reuses WHEELBT_DEFAULT_TARGET_APY
// directly as that floor, so the simulation is literally targeting the
// same number the results get compared against, rather than two
// independently-chosen values that happened to both be "12" by
// coincidence.
const WHEELBT_DEFAULT_TARGET_APY=12; // matches _calcIncome's own fallback default

// ── Real monthly-expiration calendar mechanics ──────────────────────────
// Earlier version used a fixed trading-day offset (e.g. "45 days later")
// with no relationship to when options actually expire -- traditional
// monthlies expire the 3rd Friday of the month, a specific, discrete date,
// not an arbitrary point on a continuous day count. That mattered: dates
// shown in the simulation didn't correspond to real expirations someone
// trading monthlies would ever have actually held.

// 3rd Friday of a given (year, month) -- month is 0-indexed (Jan=0).
function _thirdFriday(year,month){
  const first=new Date(year,month,1);
  const firstFridayDate=1+((5-first.getDay()+7)%7); // 5 = Friday
  return new Date(year,month,firstFridayDate+14);
}

// Given an entry date and N (months out), finds the target monthly
// expiration date -- the 3rd Friday of (entry month + N). Bumps forward an
// extra month if the naive target would be uncomfortably close to entry
// (<15 days lead time) -- avoids a degenerate near-zero-duration cycle
// when entry happens to fall very late in a month, right after that
// month's own expiration already passed.
function _monthlyExpirationDate(entryDate,monthsOut){
  let year=entryDate.getFullYear();
  let month=entryDate.getMonth()+monthsOut;
  year+=Math.floor(month/12);
  month=((month%12)+12)%12;
  let expiry=_thirdFriday(year,month);
  const MIN_LEAD_DAYS=15;
  while((expiry-entryDate)/86400000<MIN_LEAD_DAYS){
    month+=1;
    if(month>11){month=0;year+=1;}
    expiry=_thirdFriday(year,month);
  }
  return expiry;
}

// Maps a target calendar date to the nearest actual trading day AT OR
// BEFORE it in the price history (real expirations settle on the actual
// trading day, and can't resolve on a weekend/holiday the market never
// traded). Binary search since timestamps are always ascending. Returns
// the LAST available index if the target is beyond all cached history
// (signals "ran out of data before expiration" to the caller, rather than
// null -- null is reserved for "target predates all available history",
// which shouldn't occur given entryIdx is always within the array, but is
// handled defensively rather than assumed impossible).
// Single, consistent date parser for hist2y timestamp entries -- these can
// be Date objects (some callers pre-convert) or raw Unix epoch SECONDS
// (how hist2y_ is actually persisted to storage, per ticker.js/prefetch.js
// -- JSON has no Date type, so anything written via S.set is always a
// plain number by the time it's read back). Every date-handling function
// in this file MUST go through this one helper -- a previous version had
// this same epoch-seconds-vs-milliseconds check duplicated inconsistently
// across functions, and one of them (the monthly-start enumerator) was
// missing it entirely, silently misinterpreting real dates as landing in
// January 1970 and breaking the whole aggregate view.
function _parseHist2yDate(raw){
  if(raw==null)return null;
  if(raw instanceof Date)return raw;
  if(typeof raw==='number')return new Date(raw<1e10?raw*1000:raw);
  return new Date(raw); // ISO string or other parseable format
}

function _tradingDayIndexAtOrBefore(timestamps,targetDate){
  let lo=0,hi=timestamps.length-1,result=null;
  while(lo<=hi){
    const mid=(lo+hi)>>1;
    const midDate=_parseHist2yDate(timestamps[mid]);
    if(midDate<=targetDate){result=mid;lo=mid+1;}else{hi=mid-1;}
  }
  return result;
}

// Forward-search counterpart -- nearest trading day AT OR AFTER a target
// date. Used below to find "the trading day you'd actually re-enter on,
// right after a real expiration."
function _tradingDayIndexAtOrAfter(timestamps,targetDate){
  let lo=0,hi=timestamps.length-1,result=null;
  while(lo<=hi){
    const mid=(lo+hi)>>1;
    const midDate=_parseHist2yDate(timestamps[mid]);
    if(midDate>=targetDate){result=mid;hi=mid-1;}else{lo=mid+1;}
  }
  return result;
}

// Enumerates candidate window-start indices anchored to REAL monthly
// expiration boundaries -- the trading day right after each 3rd-Friday
// expiration across the full span of cached history. This replaces a
// fixed trading-day step (e.g. "every 10 days") as the rolling-start
// sampling strategy: now that cycles snap to real monthly dates, starting
// every ~10 days would mostly just produce many near-duplicate windows
// that resolve onto the SAME real expiration a few days apart -- not
// genuinely independent scenarios. Anchoring to actual expiration-to-
// expiration transitions gives a smaller but honestly distinct sample,
// and also means every simulated window (not just the "example run" one)
// begins the way a real trader working traditional monthlies actually
// would -- re-entering shortly after the prior position resolved.
function _enumerateMonthlyStartIndices(hist2y){
  const timestamps=hist2y.timestamps;
  if(!timestamps||!timestamps.length)return[];
  const first=_parseHist2yDate(timestamps[0]);
  const last=_parseHist2yDate(timestamps[timestamps.length-1]);
  const starts=[];
  let year=first.getFullYear(),month=first.getMonth();
  while(true){
    const expiry=_thirdFriday(year,month);
    if(expiry>last)break;
    const dayAfter=new Date(expiry.getTime()+86400000);
    const idx=_tradingDayIndexAtOrAfter(timestamps,dayAfter);
    if(idx!=null&&idx>=21&&idx<=timestamps.length-2)starts.push(idx);
    month+=1;
    if(month>11){month=0;year+=1;}
  }
  // De-duplicate -- two consecutive months' "day after expiration" could
  // in principle resolve to the same trading day right at the edges of
  // the cached range.
  return[...new Set(starts)].sort((a,b)=>a-b);
}

// Simulates ONE option cycle (either a put or a call) starting at a given
// index in the price history, expiring on the REAL 3rd-Friday monthly
// expiration `monthsOut` months from the entry date (not an arbitrary
// fixed day-count) -- see _monthlyExpirationDate above. No lookahead
// beyond entryIdx for pricing; the outcome is only revealed by looking at
// the actual historical price at the (real) expiration index.
//
// Strike is chosen via yield-floor targeting, not a fixed delta: the
// strike CLOSEST to targetFloorPct annualized while still clearing it --
// matching a real income-floor discipline ("give me a strike that just
// clears my target") rather than a fixed statistical probability of
// assignment regardless of what that happens to pay. Returns null if even
// the at-the-money strike can't reach the floor at this DTE (the caller
// is expected to try a different DTE, or wait for a later entry day, when
// this happens -- see _findFloorClearingCycle below).
//
// termSlope (from _estimateTermStructureSlope) scales the vol input up as
// monthsOut increases -- reflecting that this stock's own history shows
// somewhat higher realized vol at longer horizons than at 1 month, which
// is what actually lets extending duration help clear a yield floor
// rather than hurt it (flat vol alone would make longer-dated ANNUALIZED
// yield strictly lower, not higher, since option value grows slower than
// linearly with time). Interpolated linearly between 1 month (no
// adjustment) and 3 months (the full estimated slope).

// Standard CBOE strike-interval guideline, confirmed across current
// sources: <=$25 -> $2.50, $25-$200 -> $5, >$200 -> $10. The continuous
// strike from _solveStrikeForYieldFloor is a theoretical boundary that
// doesn't correspond to a real, tradeable strike -- snapping to this
// makes the simulated strike something you could actually have selected
// from a real options chain.
function _realisticStrikeIncrement(spot){
  return spot<=25?2.5:spot<=200?5:10;
}

// Snaps toward the money (never away from it) -- yield is monotonic in
// strike, so rounding this direction guarantees the snapped strike still
// clears the floor whenever the continuous boundary did (never rounds to
// something that falls short). If the snap lands essentially AT spot
// itself (can happen when spot sits very close to a grid line -- not
// realistic with real market prices to the degree seen in clean
// synthetic test data, but the underlying case is real near tier
// boundaries), pushes one more full increment out: a strike
// indistinguishable from spot isn't a genuine OTM position, and no real
// options chain would treat it as meaningfully different from ATM.
// Returns null if the increment is coarse enough that no valid OTM
// strike exists at all in this direction.
function _snapStrikeToRealistic(rawStrike,spot,optionType){
  const increment=_realisticStrikeIncrement(spot);
  let snapped=optionType==='put'
    ?Math.ceil(rawStrike/increment)*increment
    :Math.floor(rawStrike/increment)*increment;
  const EPS=increment*0.001;
  const tooCloseToSpot=optionType==='put'?snapped>=spot-EPS:snapped<=spot+EPS;
  if(tooCloseToSpot)snapped=optionType==='put'?snapped-increment:snapped+increment;
  const stillOTM=optionType==='put'?snapped<spot:snapped>spot;
  return stillOTM?snapped:null;
}

function _simulateOneCycle(hist2y,entryIdx,monthsOut,targetFloorPct,optionType,r,termSlope){
  const closes=hist2y.closes,timestamps=hist2y.timestamps;
  const n=closes.length;
  const S0=closes[entryIdx];
  if(S0==null||S0<=0)return null;
  const entryDateRaw=timestamps?.[entryIdx];
  if(entryDateRaw==null)return null;
  const entryDate=_parseHist2yDate(entryDateRaw);
  const sigma1mo=_realizedVolAsOf(closes,entryIdx,21);
  if(sigma1mo==null||sigma1mo<=0)return null;
  const slope=termSlope!=null?termSlope:1.0;
  const adjFactor=1+(slope-1)*((monthsOut-1)/2); // 1.0 at monthsOut=1, full slope at monthsOut=3, linear between
  const sigma=sigma1mo*adjFactor;

  const expiryDate=_monthlyExpirationDate(entryDate,monthsOut);
  const exitIdx=_tradingDayIndexAtOrBefore(timestamps,expiryDate);
  if(exitIdx==null||exitIdx<=entryIdx)return null; // shouldn't occur given the lead-time guard, but defensive
  const exitDateRaw=timestamps[exitIdx];
  const exitDate=_parseHist2yDate(exitDateRaw);
  // If the resolved trading day falls meaningfully short (>=5 days) of the
  // real target expiration, the actual expiration hasn't happened yet in
  // the cached data -- this cycle is still genuinely open. Don't fabricate
  // a resolved "worthless"/"assigned" outcome using whatever the last
  // cached price happens to be as a stand-in for a real settlement price
  // that hasn't occurred. Returning null here stops the chain cleanly at
  // the last cycle that actually finished (the caller's existing
  // if(!cyc)break already handles this correctly).
  if((expiryDate-exitDate)/86400000>=5)return null;

  // T uses the ACTUAL elapsed calendar time to real expiration, not an
  // assumed monthsOut*30/365 -- monthly spacing isn't perfectly uniform
  // (28-35 days depending on where in the month entry happens to fall),
  // and pricing should reflect the real duration being simulated.
  const T=(exitDate-entryDate)/(365*86400000);
  if(T<=0)return null;
  const K_raw=_solveStrikeForYieldFloor(S0,T,r,sigma,targetFloorPct,optionType);
  if(K_raw==null||!isFinite(K_raw))return null; // floor not reachable at this DTE -- caller tries a different DTE or waits
  const K=_snapStrikeToRealistic(K_raw,S0,optionType);
  if(K==null)return null; // increment too coarse at this price level -- would cross the money, not a valid OTM strike
  const premium=optionType==='put'?_bsPutPrice(S0,K,T,r,sigma):_bsCallPrice(S0,K,T,r,sigma);
  if(!isFinite(premium)||premium<0)return null;
  // Snapping (especially the too-close-to-spot push-out above) can move
  // the strike further from the money than the continuous boundary was --
  // re-verify the REALISTIC strike's own yield still clears the floor,
  // rather than trusting the continuous solve alone. If it doesn't, this
  // specific entry/DTE genuinely can't be done with a real, valid strike
  // -- the caller's existing escalation/waiting logic handles this
  // exactly like any other infeasible attempt.
  const actualYield=_annualizedYieldPct(premium,S0,T);
  if(actualYield<targetFloorPct-0.01)return null;

  const priceAtExit=closes[exitIdx];
  if(priceAtExit==null)return null;
  const assigned=optionType==='put'?(priceAtExit<K):(priceAtExit>K);

  return{entryIdx,exitIdx,optionType,strike:K,premium,spotAtEntry:S0,priceAtExit,assigned,monthsUsed:monthsOut};
}

// Given a candidate entry day and a preferred starting DTE, finds the
// first entry that can actually clear the yield floor -- trying longer
// DTEs first (up to maxMonthsOut, matching the app's existing 3-expiry
// data-fetch cap elsewhere), and if nothing up to that cap works, waiting
// for a later trading day and repeating. This mirrors a real decision
// rule directly: extend duration first since it costs nothing but time
// already being spent, and only delay entry if even the longest
// reasonable duration still can't reach the target.
// Estimates this specific stock's own volatility term structure -- how
// much higher its realized vol tends to run at a ~3-month horizon versus
// a ~1-month horizon -- from many already-completed past stretches within
// its own cached history. Purely backward-looking at every reference
// point (no lookahead), computed ONCE per ticker and applied uniformly
// across the whole backtest (the cheaper of two options, versus
// re-estimating fresh at every entry date -- accepted tradeoff: very
// early simulated entries get a slope estimate informed by data that
// technically includes some points chronologically after them, since the
// estimate draws on the full 2-year cache rather than only what preceded
// each individual entry).
//
// Each reference point measures realized vol over the 21 trading days
// immediately following it, and separately over the 63 trading days
// following it -- the ratio of the two is one sample of "how much higher
// does this stock's vol run at 3 months than at 1 month." Averaging that
// ratio across many non-overlapping reference points gives an empirical,
// ticker-specific answer instead of a guessed industry-wide slope.
// Clamped to a modest range so a thin/noisy sample can't produce an
// extreme adjustment; returns 1.0 (flat, no adjustment) if there isn't
// enough history yet to estimate anything.
function _estimateTermStructureSlope(hist2y){
  const closes=hist2y.closes;
  const n=closes.length;
  const ratios=[];
  for(let refIdx=63;refIdx+63<=n-1;refIdx+=21){
    const vol21=_realizedVolAsOf(closes,refIdx+21,21); // realized vol over the 21 trading days after refIdx
    const vol63=_realizedVolAsOf(closes,refIdx+63,63); // realized vol over the 63 trading days after refIdx
    if(vol21!=null&&vol21>0&&vol63!=null&&vol63>0)ratios.push(vol63/vol21);
  }
  if(!ratios.length)return 1.0;
  const avgRatio=ratios.reduce((s,v)=>s+v,0)/ratios.length;
  const CLAMP_MIN=0.7,CLAMP_MAX=1.4;
  return Math.max(CLAMP_MIN,Math.min(CLAMP_MAX,avgRatio));
}

// Orders candidate DTEs (1..maxMonthsOut) by closeness to the preferred
// starting DTE -- the preferred one first, then whichever neighbor is
// closest, working outward. Ties (equally close on both sides) prefer the
// shorter duration, since shorter-dated options carry a higher baseline
// annualized yield before any term-structure adjustment even applies, so
// it's marginally more likely to actually clear the floor.
function _monthsOutSearchOrder(baseMonthsOut,maxMonthsOut){
  const all=[];
  for(let m=1;m<=maxMonthsOut;m++)all.push(m);
  all.sort((a,b)=>{
    const da=Math.abs(a-baseMonthsOut),db=Math.abs(b-baseMonthsOut);
    if(da!==db)return da-db;
    return a-b;
  });
  return all;
}

function _findFloorClearingCycle(hist2y,candidateEntryIdx,baseMonthsOut,targetFloorPct,optionType,r,maxMonthsOut,termSlope){
  const n=hist2y.closes.length;
  const searchOrder=_monthsOutSearchOrder(baseMonthsOut,maxMonthsOut);
  let idx=candidateEntryIdx;
  while(idx<n){
    for(const m of searchOrder){
      const cyc=_simulateOneCycle(hist2y,idx,m,targetFloorPct,optionType,r,termSlope);
      if(cyc)return cyc;
    }
    idx+=1; // no DTE (shorter or longer) cleared the floor on this entry day -- wait for the next trading day
  }
  return null; // ran out of data while waiting for a floor-clearing day
}

// Chains cycles across a roughly-one-year window starting at startIdx:
// sells puts until assigned, then sells calls against the resulting shares
// until called away, then reverts to puts -- repeating until either the
// window's ~1 year is used up or the available price history runs out.
const WHEELBT_MAX_MONTHS_OUT=3; // matches the app's existing 3-expiry data-fetch cap elsewhere

function _simulateWheelWindow(hist2y,startIdx,monthsOut,targetFloorPct,r,termSlope){
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
    const cyc=_findFloorClearingCycle(hist2y,curIdx,monthsOut,targetFloorPct,mode,r,WHEELBT_MAX_MONTHS_OUT,termSlope);
    if(!cyc)break; // couldn't clear the floor at any DTE, at any remaining entry day -- stop here
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
    if(curIdx>=startIdx+tradingDaysInYear)break; // let the in-progress cycle finish naturally, then stop
  }

  if(!trades.length)return null;
  const endIdx=trades[trades.length-1].exitIdx;
  const startDateRaw=hist2y.timestamps?.[startIdx],endDateRaw=hist2y.timestamps?.[endIdx];
  if(startDateRaw==null||endDateRaw==null)return null;
  const startDate=_parseHist2yDate(startDateRaw);
  const endDate=_parseHist2yDate(endDateRaw);
  const elapsedCalendarDaysApprox=(endDate-startDate)/86400000;
  const endPrice=closes[endIdx];
  if(endPrice==null||elapsedCalendarDaysApprox<=0)return null;

  // If still holding shares (mid-CC-cycle) at window end, mark unrealized
  // gain/loss vs cost basis so the total isn't silently missing that leg.
  const unrealizedShareGainLoss=costBasis!=null?(endPrice-costBasis):0;
  const totalPnL=cumPremium+realizedShareGainLoss+unrealizedShareGainLoss;

  // Capital base: the AVERAGE of each cycle's own spot price at entry, not
  // just the window's day-1 starting price. This matters a lot on a
  // volatile underlying -- a stock that rallies hard during the window
  // means real committed capital (the value of shares held, or the strike
  // securing a new put) grows right along with it, but a fixed day-1
  // denominator stays frozen, silently understating the true capital base
  // for every later cycle and inflating the resulting annualized return.
  // Averaging each cycle's actual entry price captures that a real trader
  // would have had progressively more capital at risk as the stock rose
  // (or less, if it fell), without introducing full compounding -- still
  // one total P&L divided by one denominator, matching _calcIncome's own
  // simple/linear convention so this stays directly comparable to a
  // target APY input.
  const avgCapitalBase=trades.reduce((s,t)=>s+t.spotAtEntry,0)/trades.length;
  const simpleReturn=totalPnL/avgCapitalBase;
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
function _computeWheelBacktest(ticker,monthsOut,targetFloorPct){
  const h2=S.get('hist2y_'+ticker);
  if(!h2?.closes?.length||!h2.timestamps||!h2.opens||!h2.highs||!h2.lows)return null;
  const rRaw=_getTBillYield();
  const r=(rRaw!=null?rRaw:4.0)/100; // fallback if T-bill cache unavailable; rate has a small effect on BS price relative to sigma
  const MIN_COMPLETE_DAYS=300; // ~a full year, allowing some slack for real monthly spacing not being perfectly uniform
  const termSlope=_estimateTermStructureSlope(h2); // once per ticker, applied uniformly across every window below

  const windows=[];
  _enumerateMonthlyStartIndices(h2).forEach(startIdx=>{
    const win=_simulateWheelWindow(h2,startIdx,monthsOut,targetFloorPct,r,termSlope);
    if(win&&win.elapsedCalendarDaysApprox>=MIN_COMPLETE_DAYS)windows.push(win);
  });
  if(!windows.length)return null;

  const annReturns=windows.map(w=>w.annualizedReturnPct).sort((a,b)=>a-b);
  const median=annReturns[Math.floor(annReturns.length/2)];
  const worst=annReturns[0];
  const best=annReturns[annReturns.length-1];
  const avgAssignmentRate=windows.reduce((s,w)=>s+w.assignmentRatePct,0)/windows.length;
  const avgAnnReturn=annReturns.reduce((s,v)=>s+v,0)/annReturns.length;
  const avgBuyHold=windows.reduce((s,w)=>s+w.buyHoldAnnualizedPct,0)/windows.length;
  const pctBeatTarget=(annReturns.filter(v=>v>=targetFloorPct).length/annReturns.length)*100;

  const mostRecentWindow=windows[windows.length-1];

  return{
    ticker,monthsOut,targetFloorPct,sampleSize:windows.length,
    median,worst,best,avgAssignmentRate,avgAnnReturn,avgBuyHold,pctBeatTarget,
    vsBuyHold:avgAnnReturn-avgBuyHold,
    recentCycles:mostRecentWindow.trades.slice(-8),
    recentRunStartIdx:mostRecentWindow.startIdx,
    recentRunEndIdx:mostRecentWindow.endIdx,
    recentRunTotalCycles:mostRecentWindow.trades.length,
  };
}

// Pools windows across every ticker in the given list into one combined
// distribution -- mirrors Gap Fill's aggregate approach (pool raw events,
// not an average of each ticker's own summary stat) for a much larger,
// more statistically meaningful sample than any single ticker offers.
function _computeWheelBacktestAggregate(tickers,monthsOut,targetFloorPct){
  const rRaw=_getTBillYield();
  const r=(rRaw!=null?rRaw:4.0)/100;
  const MIN_COMPLETE_DAYS=300;
  let allReturns=[];
  let allAssignmentRates=[];
  let allBuyHold=[];
  let tickersWithData=0;
  // Tracks the single most CALENDAR-RECENT complete run across every
  // ticker in the list -- not just whichever ticker happens to be iterated
  // last, which is what a plain overwrite-on-every-match would produce.
  // Comparing actual end dates (not array position) is what makes "one
  // example run" mean something -- the most current one you have data
  // for, regardless of where that ticker sits in your watchlist.
  let bestRunCycles=null,bestRunTicker=null,bestRunStartIdx=null,bestRunEndIdx=null,bestRunTotalCycles=null,bestRunEndDate=null;
  // Per-ticker breakdown, tracked as a side effect of the same loop below
  // -- reused by the "Best Tickers" ranking view so it doesn't need its
  // own separate full computation pass over the whole watchlist.
  const perTickerReturns={};

  tickers.forEach(t=>{
    const h2=S.get('hist2y_'+t);
    if(!h2?.closes?.length||!h2.timestamps||!h2.opens||!h2.highs||!h2.lows)return;
    const termSlope=_estimateTermStructureSlope(h2);
    let gotAny=false;
    perTickerReturns[t]=[];
    _enumerateMonthlyStartIndices(h2).forEach(startIdx=>{
      const win=_simulateWheelWindow(h2,startIdx,monthsOut,targetFloorPct,r,termSlope);
      if(win&&win.elapsedCalendarDaysApprox>=MIN_COMPLETE_DAYS){
        allReturns.push(win.annualizedReturnPct);
        allAssignmentRates.push(win.assignmentRatePct);
        allBuyHold.push(win.buyHoldAnnualizedPct);
        perTickerReturns[t].push(win.annualizedReturnPct);
        gotAny=true;
        const rawEndDate=h2.timestamps?.[win.endIdx];
        const endDate=rawEndDate!=null?_parseHist2yDate(rawEndDate):null;
        if(endDate&&(bestRunEndDate==null||endDate>bestRunEndDate)){
          bestRunCycles=win.trades.slice(-8);bestRunTicker=t;bestRunStartIdx=win.startIdx;bestRunEndIdx=win.endIdx;bestRunTotalCycles=win.trades.length;bestRunEndDate=endDate;
        }
      }
    });
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
  const pctBeatTarget=(allReturns.filter(v=>v>=targetFloorPct).length/allReturns.length)*100;

  // Rank tickers by their own median simulated return, best first --
  // requires at least 3 qualifying windows to be included, same
  // small-sample caution already applied elsewhere in this app (RSI
  // Ranking's minOccurrences), so one or two lucky windows on a thinly-
  // cached ticker can't misleadingly top the list.
  const MIN_TICKER_SAMPLE=3;
  const perTickerRanking=Object.entries(perTickerReturns)
    .filter(([,arr])=>arr.length>=MIN_TICKER_SAMPLE)
    .map(([t,arr])=>{
      const sorted=[...arr].sort((a,b)=>a-b);
      return{
        ticker:t,sampleSize:sorted.length,
        worst:sorted[0],median:sorted[Math.floor(sorted.length/2)],best:sorted[sorted.length-1],
      };
    })
    .sort((a,b)=>b.median-a.median);

  return{
    monthsOut,targetFloorPct,sampleSize:allReturns.length,tickersWithData,tickersTotal:tickers.length,
    median,worst,best,avgAssignmentRate,avgAnnReturn,avgBuyHold,pctBeatTarget,
    vsBuyHold:avgAnnReturn-avgBuyHold,
    recentCycles:bestRunCycles,recentCyclesTicker:bestRunTicker,
    recentRunStartIdx:bestRunStartIdx,recentRunEndIdx:bestRunEndIdx,recentRunTotalCycles:bestRunTotalCycles,
    perTickerRanking,
  };
}

// ── Dashboard UI ─────────────────────────────────────────────────────────
// Same conventions already established by Gap Fill/RSI Backtest: a scope
// dropdown (aggregate vs. one ticker), a span-style toggle row (here: the
// preferred starting expiration instead of a chart timeframe), a hero
// stat, and a supporting detail list.

function _populateWheelBacktestDropdown(){
  const sel=document.getElementById('wheelbt-ticker-sel');
  if(!sel)return;
  if(sel.options.length===watchlist.length+2)return; // 2 static options now: Aggregate, Starred Only
  const current=sel.value;
  const sorted=[...watchlist].sort((a,b)=>a.localeCompare(b));
  sel.innerHTML='<option value="">Aggregate (whole watchlist)</option>'+
    '<option value="__starred__">Starred Only</option>'+
    sorted.map(t=>`<option value="${t}">${t}</option>`).join('');
  if(current==='__starred__'||sorted.includes(current))sel.value=current;
}

// Independent of Conviction Scoring's own target-apy field, by design --
// this simulation's floor is a deliberately separate setting, so changing
// one never silently changes the other. Defaults to 12%, same as
// Conviction Scoring's own fallback, purely because that's this app's
// existing convention, not because the two are linked.
function getWheelBacktestTargetAPY(){
  const stored=parseFloat(S.get('wheelbt_target_apy'));
  return(!isNaN(stored)&&stored>0)?stored:WHEELBT_DEFAULT_TARGET_APY;
}
function setWheelBacktestTargetAPY(){
  const input=document.getElementById('wheelbt-target-apy-input');
  if(!input)return;
  const val=parseFloat(input.value);
  if(!isNaN(val)&&val>0){
    S.set('wheelbt_target_apy',val);
    refreshWheelBacktestViews();
  }
}

function getWheelBacktestMonths(){return parseInt(S.get('wheelbt_months'))||2;}
function setWheelBacktestMonths(months){
  S.set('wheelbt_months',months);
  [1,2,3].forEach(m=>{
    const btn=document.getElementById('wheelbt-months-'+m);
    if(btn)btn.style.opacity=(m===months)?'1':'0.4';
  });
  refreshWheelBacktestViews();
}

// Purely geometric range bar -- worst-to-best span, median tick, target
// marker. Deliberately carries NO text of its own: SVG <text> is sized in
// fixed SVG units that don't respect the device's font-size/zoom setting
// at all, which is exactly what made the previous version illegible. All
// the actual numbers live in regular HTML around this bar instead, where
// normal font scaling applies.
function _wheelBacktestRangeBarSvg(worst,median,best,target){
  const dataMin=Math.min(worst,target),dataMax=Math.max(best,target);
  const dataRange=dataMax-dataMin;
  // Padding scales WITH the actual spread rather than a fixed +/-2pp --
  // yield-floor targeting genuinely converges tightly around the target in
  // many cases (a 8.9%-9.1% range around a 9% target is real, correct
  // data, not a bug), and a fixed-size axis made a real tight cluster look
  // like a barely-visible sliver. A tiny absolute floor (0.1) only exists
  // to guard the theoretical zero-range case from collapsing the axis to
  // zero width entirely.
  const padding=Math.max(dataRange*0.3,0.1);
  const lo=dataMin-padding,hi=dataMax+padding;
  const toX=(v)=>10+((v-lo)/(hi-lo))*352;
  const worstX=toX(worst),medX=toX(median),bestX=toX(best),targetX=toX(target);
  return`<svg viewBox="0 0 372 30" width="100%" height="30" style="margin-bottom:4px">
    <line x1="10" y1="15" x2="362" y2="15" stroke="var(--surface3)" stroke-width="1"/>
    <rect x="${worstX}" y="9" width="${Math.max(bestX-worstX,2)}" height="12" rx="3" fill="var(--accent)" fill-opacity="0.35"/>
    <line x1="${worstX}" y1="4" x2="${worstX}" y2="26" stroke="var(--red)" stroke-width="2"/>
    <line x1="${medX}" y1="2" x2="${medX}" y2="28" stroke="var(--accent)" stroke-width="2.5"/>
    <line x1="${bestX}" y1="4" x2="${bestX}" y2="26" stroke="var(--green)" stroke-width="2"/>
    <line x1="${targetX}" y1="0" x2="${targetX}" y2="30" stroke="var(--warn)" stroke-width="2" stroke-dasharray="3,2"/>
  </svg>`;
}

// The actual readable numbers -- large, normal HTML text, same convention
// as the blended-yield hero card's income row.
function _wheelBacktestStatBlocksHtml(worst,median,best){
  const block=(label,val,color,size)=>`<div style="text-align:center;flex:1">
    <div style="font-family:var(--mono);font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px">${label}</div>
    <div style="font-family:var(--mono);font-size:${size}px;font-weight:700;color:${color}">${val>=0?'+':''}${val.toFixed(1)}%</div>
  </div>`;
  return`<div style="display:flex;align-items:flex-end;margin-bottom:6px">
    ${block('Worst',worst,'var(--red)',18)}
    ${block('Median',median,'var(--accent)',24)}
    ${block('Best',best,'var(--green)',18)}
  </div>`;
}

// Plain-language takeaway using the actual percentile rank within the full
// pooled distribution, not just a visual comparison against three summary
// points -- directly answers "does my target hold up historically."
function _wheelBacktestTargetSentence(target,pctBeatTarget){
  if(pctBeatTarget<=0)return`Your ${target}% target was not reached by any simulated window in this sample.`;
  if(pctBeatTarget>=90)return`Your ${target}% target was easily cleared &mdash; ${pctBeatTarget.toFixed(0)}% of simulated windows beat it.`;
  if(pctBeatTarget>=50)return`Your ${target}% target looks realistic here &mdash; ${pctBeatTarget.toFixed(0)}% of simulated windows beat it.`;
  return`Your ${target}% target is on the ambitious side for this history &mdash; only ${pctBeatTarget.toFixed(0)}% of simulated windows beat it.`;
}

// Shows BOTH the opening and closing date of each cycle, explicitly
// labeled -- the previous version showed only the entry date with no
// label at all, sitting right next to an outcome that actually resolves
// at the end of the cycle, which was genuinely ambiguous.
function _wheelBacktestCycleRowHtml(t,hist2y){
  const toDateStr=d=>{const parsed=_parseHist2yDate(d);return parsed?parsed.toLocaleDateString('en-US',{month:'short',day:'numeric'}):'?';};
  const entryDateStr=hist2y?toDateStr(hist2y.timestamps?.[t.entryIdx]):'?';
  const exitDateStr=hist2y?toDateStr(hist2y.timestamps?.[t.exitIdx]):'?';
  const label=t.optionType==='put'?'CSP':'CC';
  const outcome=t.assigned?(t.optionType==='put'?'Assigned':'Called away'):'Expired worthless';
  const outcomeColor=t.assigned?'var(--warn)':'var(--green)';
  const monthsLabel=t.monthsUsed?` &middot; ${t.monthsUsed}mo`:'';
  // Puts are always struck below spot, calls always above (the yield-floor
  // solver only ever returns OTM-eligible strikes) -- one absolute-value
  // formula covers both directions correctly.
  const otmPct=Math.abs(t.spotAtEntry-t.strike)/t.spotAtEntry*100;
  const otmLabel=` &middot; ${otmPct.toFixed(1)}% OTM`;
  const strikeStr=t.strike%1===0?t.strike.toFixed(0):t.strike.toFixed(2);
  return`<div style="padding:5px 0;border-bottom:1px solid var(--surface3)">
    <div style="display:flex;justify-content:space-between;font-size:11px">
      <span style="color:var(--text2)">${label} $${strikeStr}${monthsLabel}${otmLabel}</span>
      <span style="color:${outcomeColor}">${outcome}</span>
    </div>
    <div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-top:1px">Opened ${entryDateStr} ($${t.spotAtEntry.toFixed(2)}) &rarr; ${exitDateStr} ($${t.priceAtExit.toFixed(2)})</div>
  </div>`;
}

function renderWheelBacktest(){
  const content=document.getElementById('wheelbt-content');
  if(!content)return;
  const sel=document.getElementById('wheelbt-ticker-sel');
  const selectedValue=sel?.value||'';
  const isStarredMode=selectedValue==='__starred__';
  const selectedTicker=isStarredMode?'':selectedValue;
  const monthsOut=getWheelBacktestMonths();
  const target=getWheelBacktestTargetAPY();

  const apyInput=document.getElementById('wheelbt-target-apy-input');
  if(apyInput&&document.activeElement!==apyInput)apyInput.value=target;

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
    if(isStarredMode){
      const starredList=watchlist.filter(t=>_starredTickers().has(t));
      if(!starredList.length){
        content.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>No starred tickers yet -- tap the star on a ticker in the Watchlist tab to add one.</div>';
        return;
      }
      result=_computeWheelBacktestAggregate(starredList,monthsOut,target);
    }else if(isAggregate){
      result=_computeWheelBacktestAggregate(watchlist,monthsOut,target);
    }else{
      result=_computeWheelBacktest(selectedTicker,monthsOut,target);
    }
    _renderWheelBacktestFromResult(result,isAggregate,isStarredMode,selectedTicker,monthsOut,target);
  },10);
}

// Pure rendering, given an already-computed result -- separated out so the
// coordinator below (refreshWheelBacktestViews) can reuse a single
// whole-watchlist computation for both this card and the ranking card,
// instead of each independently computing the identical aggregate when
// scope is "Aggregate" (the default and most common case).
function _renderWheelBacktestFromResult(result,isAggregate,isStarredMode,selectedTicker,monthsOut,target){
  const content=document.getElementById('wheelbt-content');
  if(!content)return;

  if(!result){
    content.innerHTML=`<div class="empty"><div class="empty-icon">&#x1F4CA;</div>Not enough cached price history with Open/High/Low to complete a full-year simulation${isAggregate?' for any watchlist ticker':' for '+selectedTicker}. Run Prefetch All or Full Refresh first, and allow time for 2 years of history to accumulate.</div>`;
    return;
  }

  const scopeLabel=isStarredMode?`Pooled across ${result.tickersWithData} of ${result.tickersTotal} starred tickers`:isAggregate?`Pooled across ${result.tickersWithData} of ${result.tickersTotal} watchlist tickers`:`${selectedTicker} only -- small single-ticker sample, directional intuition only`;
  const vsColor=result.vsBuyHold>=0?'var(--green)':'var(--red)';
  const extremeCaveat=Math.max(Math.abs(result.worst),Math.abs(result.median),Math.abs(result.best))>=100
    ?`<div style="font-size:10px;color:var(--warn);margin-bottom:10px">&#x26A0; A result this large usually means the underlying moved sharply during one of these windows -- treat it as a sign of high volatility in that stretch, not a number to take at face value.</div>`:'';

  const exampleHist2y=S.get('hist2y_'+(isAggregate?result.recentCyclesTicker:selectedTicker));
  const toDateStr=d=>{const parsed=_parseHist2yDate(d);return parsed?parsed.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):null;};
  const runStartStr=toDateStr(exampleHist2y?.timestamps?.[result.recentRunStartIdx]);
  const runEndStr=toDateStr(exampleHist2y?.timestamps?.[result.recentRunEndIdx]);
  const runSpanStr=(runStartStr&&runEndStr)?`${runStartStr} &rarr; ${runEndStr}`:'';

  content.innerHTML=`
    <div style="font-family:var(--mono);font-size:10px;color:${isAggregate?'var(--text3)':'var(--warn)'};margin-bottom:12px">${isAggregate?'':'&#x26A0; '}${scopeLabel} &middot; ${result.sampleSize} simulated windows</div>
    ${_wheelBacktestStatBlocksHtml(result.worst,result.median,result.best)}
    ${extremeCaveat}
    ${_wheelBacktestRangeBarSvg(result.worst,result.median,result.best,target)}
    <div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-bottom:4px">worst &middot; median &middot; best of ${result.sampleSize} 1-year windows, each starting the trading day after a real monthly expiration (${monthsOut}-month cycles) &mdash; dashed line marks your target</div>
    <div style="font-size:11px;color:var(--warn);margin-bottom:14px">${_wheelBacktestTargetSentence(target,result.pctBeatTarget)}</div>
    <div style="display:flex;justify-content:space-between;font-size:10px;padding:5px 0;border-top:1px solid var(--surface3)">
      <span style="color:var(--text2)">Assignment rate</span><span style="color:var(--text)">${result.avgAssignmentRate.toFixed(0)}%</span>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10px;padding:5px 0;border-top:1px solid var(--surface3)">
      <span style="color:var(--text2)">vs. Buy &amp; Hold (same windows)</span><span style="color:${vsColor}">${result.vsBuyHold>=0?'+':''}${result.vsBuyHold.toFixed(1)}pp avg</span>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10px;padding:5px 0;border-top:1px solid var(--surface3);margin-bottom:12px">
      <span style="color:var(--text2)">Premium source</span><span style="color:var(--warn)">Realized vol + est. term structure</span>
    </div>
    <div style="font-family:var(--mono);font-size:9px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px">One Example Run${result.recentCyclesTicker?' ('+result.recentCyclesTicker+')':''}</div>
    ${runSpanStr?`<div style="font-family:var(--mono);font-size:10px;color:var(--text2);margin-bottom:3px">Window: ${runSpanStr}</div>`:''}
    <div style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-bottom:6px">The stats above pool all ${result.sampleSize} simulated windows together. This is just ONE of them -- the most recent that ran a full year -- shown cycle-by-cycle so you can see what actually happened along that specific path${result.recentRunTotalCycles>8?' (last 8 of '+result.recentRunTotalCycles+' cycles shown)':''}.</div>
    <div style="max-height:160px;overflow-y:auto">${(result.recentCycles||[]).map(t=>_wheelBacktestCycleRowHtml(t,exampleHist2y)).join('')||'<div style="font-family:var(--mono);font-size:10px;color:var(--text3);padding:6px 0">No cycles to show.</div>'}</div>
  `;
}

// ── Best Tickers ranking ─────────────────────────────────────────────────
// Always ranks across the whole watchlist regardless of the main card's
// Scope selection -- "which of my tickers looks best" is inherently a
// whole-watchlist question, distinct from "show me this one scope's
// result" that the Scope dropdown controls. Shares the Preferred
// Expiration and Target APY settings from the main card, so it stays
// consistent with whatever that's currently showing.
function _wheelBacktestRankingRowHtml(r,rank,target){
  return`<div style="padding:8px 0;border-bottom:1px solid var(--surface3)">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">
      <span style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--text3)">${rank}.</span> <span onclick="navigateToTicker('${r.ticker}')" style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--text);text-decoration:underline;cursor:pointer">${r.ticker}</span> <span onclick="_wheelBacktestViewTickerFromRanking('${r.ticker}')" style="font-size:9px;color:var(--accent);text-decoration:underline;cursor:pointer;padding:3px 4px;display:inline-block">View analysis</span>
      <span style="font-family:var(--mono);font-size:15px;font-weight:700;color:var(--accent)">${r.median>=0?'+':''}${r.median.toFixed(1)}%</span>
    </div>
    ${_wheelBacktestRangeBarSvg(r.worst,r.median,r.best,target)}
    <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:8px;color:var(--text3);margin-top:1px">
      <span>${r.worst>=0?'+':''}${r.worst.toFixed(1)}%</span>
      <span>${r.sampleSize} windows</span>
      <span>${r.best>=0?'+':''}${r.best.toFixed(1)}%</span>
    </div>
  </div>`;
}

// Selects the tapped ticker in the main card's Scope dropdown and
// re-renders it, then scrolls that card into view -- it sits above the
// ranking card, so without this the result would update off-screen and
// look like nothing happened.
function _wheelBacktestViewTickerFromRanking(ticker){
  const sel=document.getElementById('wheelbt-ticker-sel');
  if(!sel)return;
  sel.value=ticker;
  renderWheelBacktest();
  const mainCard=document.getElementById('dash-wheelbt-card');
  if(mainCard)mainCard.scrollIntoView({behavior:'smooth',block:'start'});
}

function renderWheelBacktestRanking(){
  const content=document.getElementById('wheelbt-ranking-content');
  if(!content)return;
  if(!watchlist.length){
    content.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>Watchlist is empty</div>';
    return;
  }
  const monthsOut=getWheelBacktestMonths();
  const target=getWheelBacktestTargetAPY();
  content.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>Computing...</div>';

  setTimeout(()=>{
    const result=_computeWheelBacktestAggregate(watchlist,monthsOut,target);
    _renderWheelBacktestRankingFromResult(result,target);
  },10);
}

// Pure rendering, given an already-computed result -- see
// _renderWheelBacktestFromResult above for the same pattern and the
// reasoning (avoiding a duplicate identical computation when the
// coordinator below already has this exact result on hand).
function _renderWheelBacktestRankingFromResult(result,target){
  const content=document.getElementById('wheelbt-ranking-content');
  if(!content)return;
  if(!result||!result.perTickerRanking||!result.perTickerRanking.length){
    content.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>Not enough cached price history to rank any watchlist ticker yet. Run Prefetch All or Full Refresh first, and allow time for 2 years of history to accumulate.</div>';
    return;
  }
  content.innerHTML=result.perTickerRanking.map((r,i)=>_wheelBacktestRankingRowHtml(r,i+1,target)).join('');
}

// ── Coordinator ──────────────────────────────────────────────────────────
// The single entry point for the trigger sites that refresh BOTH cards
// together (DTE change, target APY change, view-switch). Computes the
// whole-watchlist aggregate ONCE and reuses it for the ranking card and,
// when Scope is "Aggregate" (the default), the main card too -- avoiding
// the identical simulation running twice in the same breath, which is
// what independently calling renderWheelBacktest() + renderWheelBacktestRanking()
// used to do. When Scope is Starred or a single ticker, the main card
// still needs its own separate computation (genuinely different data,
// nothing to share there), so only the ranking's cost is ever saved in
// that case -- still a real, unconditional win since the ranking always
// wants the whole watchlist regardless of Scope.
function refreshWheelBacktestViews(){
  const mainContent=document.getElementById('wheelbt-content');
  const rankingContent=document.getElementById('wheelbt-ranking-content');
  const sel=document.getElementById('wheelbt-ticker-sel');
  const selectedValue=sel?.value||'';
  const isStarredMode=selectedValue==='__starred__';
  const selectedTicker=isStarredMode?'':selectedValue;
  const isAggregateScope=!selectedTicker&&!isStarredMode;
  const monthsOut=getWheelBacktestMonths();
  const target=getWheelBacktestTargetAPY();

  const apyInput=document.getElementById('wheelbt-target-apy-input');
  if(apyInput&&document.activeElement!==apyInput)apyInput.value=target;

  if(!watchlist.length){
    if(mainContent)mainContent.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>Watchlist is empty</div>';
    if(rankingContent)rankingContent.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>Watchlist is empty</div>';
    return;
  }
  if(mainContent)mainContent.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>Computing...</div>';
  if(rankingContent)rankingContent.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>Computing...</div>';

  setTimeout(()=>{
    const watchlistResult=_computeWheelBacktestAggregate(watchlist,monthsOut,target);
    _renderWheelBacktestRankingFromResult(watchlistResult,target);

    if(isAggregateScope){
      _renderWheelBacktestFromResult(watchlistResult,true,false,selectedTicker,monthsOut,target);
    }else if(isStarredMode){
      const starredList=watchlist.filter(t=>_starredTickers().has(t));
      if(!starredList.length){
        if(mainContent)mainContent.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CA;</div>No starred tickers yet -- tap the star on a ticker in the Watchlist tab to add one.</div>';
      }else{
        const starredResult=_computeWheelBacktestAggregate(starredList,monthsOut,target);
        _renderWheelBacktestFromResult(starredResult,true,true,selectedTicker,monthsOut,target);
      }
    }else{
      const tickerResult=_computeWheelBacktest(selectedTicker,monthsOut,target);
      _renderWheelBacktestFromResult(tickerResult,false,false,selectedTicker,monthsOut,target);
    }
  },10);
}
