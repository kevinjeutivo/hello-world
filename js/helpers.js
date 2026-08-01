// Income Engine -- helpers.js
// Utility functions: date/time, math, formatting, display helpers.
// Globals used: tzPref, S, watchlist, WORKER_URL, vixThreshold
// Dependencies: storage.js (S)

function applyFontSize(size){
  // All font sizes in this app are hardcoded in px (in app.css and inline
  // styles), so changing the root font-size has no effect on them.
  // Instead we scale the entire #app container using CSS zoom, which is
  // a WebKit original and is fully supported on iOS Safari.  zoom scales
  // EVERYTHING uniformly -- text, borders, padding, charts -- with no
  // changes required to any px values anywhere in the codebase.
  //
  // Base size is 19 (the default option).  Zoom = selected / 19.
  // Examples: 15px -> 0.789, 19px -> 1.000, 26px -> 1.368, 36px -> 1.895
  const BASE=19;
  const zoom=parseFloat(size)/BASE;
  const app=document.getElementById('app');
  if(app){
    app.style.transform='';
    app.style.width='';
    app.style.zoom=zoom;
    app.style.transformOrigin='top left';
    // Update nav/acct-bar positioning when zoom changes
    if(typeof _updateHeaderTop==='function') _updateHeaderTop();
  }
  // Keep the CSS variable updated for any code that reads it.
  document.documentElement.style.setProperty('--base-font',size+'px');
}

function nowInTZ(){
  const opts={timeZone:tzPref==='PT'?'America/Los_Angeles':tzPref==='UTC'?'UTC':Intl.DateTimeFormat().resolvedOptions().timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false};
  const s=new Date().toLocaleString('en-US',opts);
  const tzLabel=tzPref==='PT'?'PT':tzPref==='UTC'?'UTC':'local';
  return s+' '+tzLabel;
}

function nowPT(){return nowInTZ();}

// Returns today's date as 'YYYY-MM-DD' in the user's configured display
// timezone (tzPref) -- for user-facing labels like "Today"/"Yesterday"/"3
// days ago". Deliberately different from _todayET(): that one is for
// correctness-critical comparisons tied to when market events actually
// happen (market close, BMO/AMC timing), while this one reflects what the
// user themselves would call "today" on their own clock. A label should
// never read "Yesterday" for something that, on the user's own chosen
// timezone, is still today.
function _todayLocal(){
  const tz=tzPref==='PT'?'America/Los_Angeles':tzPref==='UTC'?'UTC':Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}

function daysUntilDate(dateStr){
  if(!dateStr)return null;
  try{
    const todayStr=_todayLocal();
    if(dateStr===todayStr)return 0;
    const d1=new Date(todayStr+'T12:00:00Z');
    const d2=new Date(dateStr+'T12:00:00Z');
    return Math.round((d2-d1)/86400000);
  }catch{return null;}
}

function ordinal(n){
  const abs=Math.abs(Math.round(n));
  const mod100=abs%100;
  const mod10=abs%10;
  if(mod100>=11&&mod100<=13)return abs+'th';
  if(mod10===1)return abs+'st';
  if(mod10===2)return abs+'nd';
  if(mod10===3)return abs+'rd';
  return abs+'th';
}

// Computes a human-readable "X ago" label. Prefers `epoch` (a numeric
// Date.now()-style timestamp) when provided -- plain subtraction, no
// timezone ambiguity at all. Falls back to re-parsing the display string
// when no epoch is available (for cache objects not yet migrated to carry
// one), preserving existing behavior for those rather than breaking them.
// The string-reparse fallback has a known limitation: it silently uses
// whatever timezone the device currently considers "local" at the moment of
// parsing, which can diverge from what was used when the string was
// originally written (e.g. if the device's timezone changed since, such as
// during travel). Passing epoch avoids that limitation entirely.
function relAge(tsStr,epoch){
  if(epoch!=null){
    try{
      const diff=(Date.now()-epoch)/1000;
      if(diff<60)return'just now';
      if(diff<3600)return Math.round(diff/60)+'m ago';
      if(diff<86400)return Math.round(diff/3600)+'h ago';
      return Math.round(diff/86400)+'d ago';
    }catch{return'';}
  }
  if(!tsStr)return'';
  try{
    const clean=tsStr.replace(/ PT$| UTC$| local$/,'').trim();
    const d=new Date(clean);
    if(isNaN(d.getTime()))return'';
    const diff=(Date.now()-d.getTime())/1000;
    if(diff<60)return'just now';
    if(diff<3600)return Math.round(diff/60)+'m ago';
    if(diff<86400)return Math.round(diff/3600)+'h ago';
    return Math.round(diff/86400)+'d ago';
  }catch{return'';}
}

function tsChip(ts,isLive,epoch){
  const cls=isLive?'live':'stale';
  const age=relAge(ts,epoch);
  const ageStr=age?` (${age})`:'';
  const isoTs=new Date().toISOString();
  const epochAttr=epoch!=null?` data-ts-epoch="${epoch}"`:'';
  return `<div class="ts-chip ${cls}" data-ts-iso="${isoTs}" data-ts-display="${ts||''}"${epochAttr}>${isLive?'live':'cached'} ${ts||'unknown'}${ageStr}</div>`;
}

function fmtTS(ts,epoch){
  if(!ts)return'unknown';
  const age=relAge(ts,epoch);
  const ageStr=age?` (${age})`:'';
  return ts.replace(/ PT$| UTC$| local$/,'')+' '+ageLabel()+ageStr;
}

function tzLabel(){return tzPref==='PT'?'PT':tzPref==='UTC'?'UTC':'local';}

function ageLabel(){return tzPref==='PT'?'PT':tzPref==='UTC'?'UTC':'local';}

function relTime(ts){
  try{const d=new Date(typeof ts==='number'?ts*1000:ts);const diff=(Date.now()-d)/1000;if(diff<3600)return Math.round(diff/60)+'m ago';if(diff<86400)return Math.round(diff/3600)+'h ago';return Math.round(diff/86400)+'d ago';}catch{return String(ts);}
}

function fmtDate(d){return d.toISOString().split('T')[0];}

function addDays(d,n){const r=new Date(d);r.setDate(r.getDate()+n);return r;}
// Returns true if we're within market hours through 1 hour after close
// (9:30am ET open through 5:00pm ET, since market closes 4:00pm ET).
// Used to decide cache-freshness TTLs: a short TTL during this window since
// prices are actively moving, unlimited (always serve cache) outside it --
// after-hours/weekend data doesn't change, and the 1hr buffer past close
// gives Yahoo's official close print time to settle. Shared by ticker.js
// (per-ticker snap freshness) and market.js (market tab price/yield/futures
// freshness) -- news freshness is intentionally NOT gated by this, since news
// can break at any hour regardless of whether the market itself is open.
function _isMarketActiveWindow(){
  try{
    const now=new Date();
    const etFmt=new Intl.DateTimeFormat('en-US',{
      timeZone:'America/New_York',
      weekday:'short',hour:'numeric',minute:'numeric',hour12:false
    });
    const parts=etFmt.formatToParts(now);
    const etWeekday=parts.find(p=>p.type==='weekday').value; // 'Mon'..'Sun'
    if(etWeekday==='Sat'||etWeekday==='Sun')return false; // weekends always outside active window
    const etHour=parseInt(parts.find(p=>p.type==='hour').value);
    const etMin=parseInt(parts.find(p=>p.type==='minute').value);
    const etMins=etHour*60+etMin;
    const openMins=9*60+30;  // 9:30am ET
    const closeBufferMins=17*60; // 5:00pm ET (4:00pm close + 1hr buffer)
    return etMins>=openMins&&etMins<closeBufferMins;
  }catch{return true;} // default to live-fetch behavior on error
}

// Builds earnings_hist_<ticker> -- the data that drives the ticker page's
// earnings-event chart markers ("gap-estimated"/"auto-confirmed"/"time-estimated").
// Two independent parts:
//
// Part 1: backward-steps from the next known confirmed earnings date in
// ~91-day increments to estimate each of the last 8 quarters, refining each
// estimate via the largest nearby price gap, and upgrading to the confirmed
// cache's real date wherever one matches. Requires both hist2y and a known
// next-earnings anchor, since it needs somewhere to start counting back from.
//
// Part 2: backfills any earnings_confirmed_ entry from roughly the last 100
// days that isn't already represented by Part 1's results, regardless of
// whether Part 1 ran at all. This exists because Part 1's anchor requirement
// meant a just-happened, already-confirmed earnings event couldn't appear
// until Finnhub had posted the *next* quarter's date -- sometimes days or
// weeks later -- even though the just-happened event's real date was already
// sitting correctly in earnings_confirmed_ the whole time.
//
// Called identically from ticker.js (per-ticker view/refresh) and
// prefetch.js (watchlist loop) -- previously these carried two independent,
// near-duplicate copies of Part 1's logic, and prefetch.js's copy was
// missing the confirmed-cache checks entirely, meaning frequent Prefetch All
// runs could silently overwrite a correctly-resolved entry with a weaker one.
function _buildEarningsHistory(ticker){
  const t=ticker;
  try{
    const h2raw=S.get('hist2y_'+t);
    const snap=S.get('snap_'+t);
    const nextEarnings=snap?.earningsDate||null;
    const today=_todayET();
    const confirmed=S.get('earnings_confirmed_'+t)||[];
    let results=[];

    // ── Part 1: backward-stepping + gap refinement ──────────────────────────
    if(h2raw?.closes?.length>=60&&nextEarnings){
      const closes=h2raw.closes;
      const timestamps=h2raw.timestamps;
      const closeDates=timestamps.map(ts=>new Date(ts*1000).toISOString().split('T')[0]);

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

      let anchor=new Date(nextEarnings+'T12:00:00Z');
      for(let q=0;q<8;q++){
        anchor=new Date(anchor.getTime()-91*86400000);
        const est=anchor.toISOString().split('T')[0];
        if(est>=today)continue; // skip if still in future

        const estIdx=closeDates.reduce((best,d,i)=>
          Math.abs(new Date(d)-new Date(est))<Math.abs(new Date(closeDates[best])-new Date(est))?i:best,0);

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
        const _confCacheSlot=confirmed.find(c=>Math.abs(new Date(c.date)-new Date(est))<26*86400000);

        if(_confCacheSlot){
          results.push({date:_confCacheSlot.date,hour:_confCacheSlot.hour||null,gapPct:null,direction:null,source:'auto-confirmed'});
        }else if(bestGap&&bestGap.gapPct>=3){
          results.push({date:bestGap.date,hour:null,gapPct:bestGap.gapPct,direction:bestGap.direction,source:'gap-estimated'});
        }else{
          const fallbackDate=closeDates[estIdx];
          if(fallbackDate&&fallbackDate<today){
            results.push({date:fallbackDate,hour:null,gapPct:null,direction:null,source:'time-estimated'});
          }
        }
      }

      // Apply confirmed cache corrections to backward-stepped estimates
      // (priority 2 -- above gap estimate, below manual override)
      results.forEach(entry=>{
        if(entry.override)return; // manual override takes absolute precedence
        const _cmatch=confirmed.find(c=>Math.abs(new Date(c.date)-new Date(entry.date))<26*86400000);
        if(_cmatch){
          entry.date=_cmatch.date;
          entry.hour=_cmatch.hour||null;
          entry.source='auto-confirmed';
        }
      });
    }

    // ── Part 2: direct backfill from confirmed cache (no anchor required) ───
    const backfillCutoff=new Date();backfillCutoff.setDate(backfillCutoff.getDate()-100);
    confirmed.forEach(c=>{
      if(!c.date||!(c.date<today))return; // only already-passed dates
      const cDate=new Date(c.date);
      if(cDate<backfillCutoff)return;
      const already=results.find(r=>Math.abs(new Date(r.date)-cDate)<26*86400000);
      if(!already){
        results.push({date:c.date,hour:c.hour||null,gapPct:null,direction:null,source:'auto-confirmed'});
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
  }catch{}
}

// Decides which after-hours (pre/post-market) fields a fresh snap should
// use. Yahoo's own extended-hours quote data typically stops being
// populated once the after-hours session itself ends (around 8pm ET) --
// well before a US evening user might next refresh -- so a live fetch late
// at night would otherwise silently erase a still-relevant after-hours
// price the moment Yahoo stops reporting it. This carries the previous
// snap's after-hours fields forward through the overnight closed period
// (matching how the iPhone Stocks app keeps showing it), but correctly
// clears them once a new trading session has genuinely started (PRE or
// REGULAR), since an old after-hours price from yesterday would be
// misleading once new trading has resumed. Shared by all three refresh
// paths (loadTicker, refreshSingleTicker, prefetch.js).
function _resolvePostMarketFields(freshQuote,prevSnap){
  const freshState=freshQuote?.marketState||null;
  if(freshQuote?.postMarketPrice!=null){
    return{
      marketState:freshState,
      postMarketPrice:freshQuote.postMarketPrice,
      postMarketChange:freshQuote.postMarketChange||null,
      postMarketChangePct:freshQuote.postMarketChangePct||null
    };
  }
  if(freshState==='PRE'||freshState==='REGULAR'){
    return{marketState:freshState,postMarketPrice:null,postMarketChange:null,postMarketChangePct:null};
  }
  if(prevSnap?.postMarketPrice!=null){
    return{
      marketState:prevSnap.marketState||freshState,
      postMarketPrice:prevSnap.postMarketPrice,
      postMarketChange:prevSnap.postMarketChange||null,
      postMarketChangePct:prevSnap.postMarketChangePct||null
    };
  }
  return{marketState:freshState,postMarketPrice:null,postMarketChange:null,postMarketChangePct:null};
}

// Returns today's date as 'YYYY-MM-DD' in US Eastern time -- the timezone
// actual market/earnings events are anchored to (market open/close, BMO/AMC
// timing). Used throughout the earnings pipeline in place of
// fmtDate(new Date()) (which is always UTC) for same-day/past-date
// comparisons, since UTC's calendar day rolls over hours before ET's,
// silently breaking those comparisons during evening hours in any US
// timezone west of UTC.
function _todayET(){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}

// Companion to _todayET() -- returns the same "today" as an actual Date
// object (midnight ET, as a precise UTC instant), for comparisons that need
// Date arithmetic rather than string equality. Correctly adapts to EST vs
// EDT by reading the current UTC offset directly rather than hardcoding it.
function _todayETStart(){
  const dateStr=_todayET();
  const offsetFmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',timeZoneName:'shortOffset'});
  const offsetPart=offsetFmt.formatToParts(new Date()).find(p=>p.type==='timeZoneName')?.value||'GMT-5';
  const offsetHours=parseInt(offsetPart.replace('GMT',''))||-5;
  const offsetStr=(offsetHours<=0?'-':'+')+String(Math.abs(offsetHours)).padStart(2,'0')+':00';
  return new Date(dateStr+'T00:00:00'+offsetStr);
}

// Mines Finnhub calendar entries that are today or in the past into
// earnings_confirmed_<ticker>, deduping against existing entries (within a
// 4-day window, to tolerate minor date-shift noise between sources) and
// evicting anything beyond the _EARN_EVICT_DAYS retention window. Shared by
// all three refresh paths (loadTicker, refreshSingleTicker, prefetch.js) --
// previously three separate copies of this exact logic existed, which is
// how a same-day date-comparison bug ended up fixed in two copies but
// missed in the third during an earlier pass.
function _supplementConfirmedEarnings(ticker,earningsCalendar){
  try{
    const conf=S.get('earnings_confirmed_'+ticker)||[];
    const cutoff=new Date();cutoff.setDate(cutoff.getDate()-_EARN_EVICT_DAYS);
    let changed=false;
    (earningsCalendar||[]).filter(e=>e.date&&e.date<=_todayET()).forEach(e=>{
      if(new Date(e.date)<cutoff)return;
      if(!conf.some(c=>Math.abs(new Date(c.date)-new Date(e.date))<4*86400000)){
        conf.push({date:e.date,hour:e.hour||null,addedTs:nowPT()});changed=true;
      }
    });
    if(changed)S.set('earnings_confirmed_'+ticker,conf.filter(c=>new Date(c.date)>=cutoff));
  }catch{}
}

// Remove options_exp_<ticker>_<date> keys where <date> has already passed --
// an expired option chain has zero future value. Previously these only got
// cleaned up when a ticker was removed from the watchlist entirely, so for
// any ticker that stays on the watchlist, old per-expiry keys accumulated
// forever as monthly expirations rolled forward. Safe regardless of whatever
// "current" expiration set is in play: a held position can't have a past
// expDate without already having been auto-evicted elsewhere in the app, so
// this doesn't need to reconcile against any specific selection to be correct.
function _pruneExpiredOptionExpiries(ticker){
  try{
    const prefix='options_exp_'+ticker+'_';
    const today=fmtDate(new Date());
    Object.keys(localStorage).filter(k=>k.startsWith(prefix)).forEach(k=>{
      const date=k.slice(prefix.length);
      if(date&&date<today)S.del(k);
    });
  }catch{}
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

function avg(arr){const v=arr.filter(x=>x!==null&&!isNaN(x));return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;}

function stdDev(arr){const a=avg(arr);if(a===null)return null;const v=arr.filter(x=>x!==null&&!isNaN(x));return Math.sqrt(v.reduce((s,x)=>s+(x-a)**2,0)/v.length);}

function computeRSI(closes,period=14){const result=[];for(let i=0;i<closes.length;i++){if(i<period){result.push(null);continue;}const sl=closes.slice(i-period,i+1);let g=0,l=0;for(let j=1;j<sl.length;j++){const d=sl[j]-sl[j-1];if(d>0)g+=d;else l-=d;}const ag=g/period,al=l/period;if(al===0){result.push(100);continue;}result.push(100-100/(1+ag/al));}return result.filter(v=>v!==null);}

// Backtests RSI as a signal: for each historical episode where RSI crossed
// into oversold (<30) or overbought (>70) territory, computes the stock's
// forward return over several windows, compared against a baseline of the
// same ticker's average forward return from any random day. Counts
// TRANSITIONS into a zone, not every day spent in it, since RSI typically
// stays under 30 for several consecutive days during one episode -- treating
// each of those days as a separate "occurrence" would inflate the sample
// with observations that aren't actually independent. Cache-only, no new
// fetches -- reads only from already-cached hist2y_.
const RSI_BACKTEST_WINDOWS=[5,10,20];
const RSI_OVERSOLD_THRESHOLD=30,RSI_OVERBOUGHT_THRESHOLD=70;

function _computeRSIBacktestForTicker(ticker){
  try{
    const h2=S.get('hist2y_'+ticker);
    if(!h2?.closes?.length||h2.closes.length<80)return null; // need enough history for RSI + forward windows to be meaningful
    const closes=h2.closes;
    const rsiPeriod=14;
    const rsi=computeRSI(closes,rsiPeriod); // rsi[k] corresponds to closes[k+rsiPeriod]

    const fwdReturn=(closeIdx,n)=>{
      const from=closes[closeIdx],to=closes[closeIdx+n];
      if(from==null||to==null||from<=0)return null;
      return(to-from)/from*100;
    };

    // Detect episodes: both entering a zone (first day RSI crosses in, not
    // every day spent there) and leaving it (first day RSI crosses back out).
    // Entering measures "what happens once a stock looks stretched"; leaving
    // measures "what happens once that stretched condition has actually
    // resolved" -- a genuinely different question, since RSI can stay
    // oversold for a while during an ongoing decline (entering doesn't mean
    // the move is over).
    const oversoldEnterIdx=[],oversoldExitIdx=[];
    const overboughtEnterIdx=[],overboughtExitIdx=[];
    let wasOversold=false,wasOverbought=false;
    for(let k=0;k<rsi.length;k++){
      const closeIdx=k+rsiPeriod;
      const v=rsi[k];
      const isOversold=v<RSI_OVERSOLD_THRESHOLD;
      const isOverbought=v>RSI_OVERBOUGHT_THRESHOLD;
      if(isOversold&&!wasOversold)oversoldEnterIdx.push(closeIdx);
      if(!isOversold&&wasOversold)oversoldExitIdx.push(closeIdx);
      if(isOverbought&&!wasOverbought)overboughtEnterIdx.push(closeIdx);
      if(!isOverbought&&wasOverbought)overboughtExitIdx.push(closeIdx);
      wasOversold=isOversold;
      wasOverbought=isOverbought;
    }

    const summarize=(idxList,n)=>{
      const rets=idxList.map(idx=>fwdReturn(idx,n)).filter(r=>r!=null);
      if(!rets.length)return null;
      const avgReturn=rets.reduce((a,b)=>a+b,0)/rets.length;
      const pctPositive=rets.filter(r=>r>0).length/rets.length*100;
      return{count:rets.length,avgReturn,pctPositive};
    };

    const baselineFor=(n)=>{
      const rets=[];
      for(let i=0;i<closes.length-n;i++){
        const r=fwdReturn(i,n);
        if(r!=null)rets.push(r);
      }
      if(!rets.length)return null;
      return rets.reduce((a,b)=>a+b,0)/rets.length;
    };

    const buildDirection=(idxList)=>{
      const d={occurrences:idxList.length,windows:{}};
      RSI_BACKTEST_WINDOWS.forEach(n=>{
        const s=summarize(idxList,n);
        const baseline=baselineFor(n);
        d.windows[n]=s?{...s,baseline,excess:baseline!=null?s.avgReturn-baseline:null}:null;
      });
      return d;
    };

    return{
      ticker,totalDays:closes.length,
      oversoldEnter:buildDirection(oversoldEnterIdx),
      oversoldExit:buildDirection(oversoldExitIdx),
      overboughtEnter:buildDirection(overboughtEnterIdx),
      overboughtExit:buildDirection(overboughtExitIdx)
    };
  }catch{return null;}
}

// Pools raw episodes (not per-ticker averages) across every ticker in a
// given list, for a much larger combined sample size than any single ticker
// could offer alone. Same cache-only, zero-new-fetch design as the
// per-ticker version.
function _computeRSIBacktestAggregate(tickers){
  const CATEGORIES=['oversoldEnter','oversoldExit','overboughtEnter','overboughtExit'];
  const pooled={};
  CATEGORIES.forEach(cat=>{
    pooled[cat]={};
    RSI_BACKTEST_WINDOWS.forEach(n=>{pooled[cat][n]=[];});
  });
  const baselinePooled={};
  RSI_BACKTEST_WINDOWS.forEach(n=>{baselinePooled[n]=[];});
  let tickersWithData=0;
  const totalEpisodes={oversoldEnter:0,oversoldExit:0,overboughtEnter:0,overboughtExit:0};

  tickers.forEach(t=>{
    try{
      const h2=S.get('hist2y_'+t);
      if(!h2?.closes?.length||h2.closes.length<80)return;
      const closes=h2.closes;
      const rsiPeriod=14;
      const rsi=computeRSI(closes,rsiPeriod);
      tickersWithData++;

      const fwdReturn=(closeIdx,n)=>{
        const from=closes[closeIdx],to=closes[closeIdx+n];
        if(from==null||to==null||from<=0)return null;
        return(to-from)/from*100;
      };

      const idxByCat={oversoldEnter:[],oversoldExit:[],overboughtEnter:[],overboughtExit:[]};
      let wasOversold=false,wasOverbought=false;
      for(let k=0;k<rsi.length;k++){
        const closeIdx=k+rsiPeriod;
        const v=rsi[k];
        const isOversold=v<RSI_OVERSOLD_THRESHOLD;
        const isOverbought=v>RSI_OVERBOUGHT_THRESHOLD;
        if(isOversold&&!wasOversold)idxByCat.oversoldEnter.push(closeIdx);
        if(!isOversold&&wasOversold)idxByCat.oversoldExit.push(closeIdx);
        if(isOverbought&&!wasOverbought)idxByCat.overboughtEnter.push(closeIdx);
        if(!isOverbought&&wasOverbought)idxByCat.overboughtExit.push(closeIdx);
        wasOversold=isOversold;
        wasOverbought=isOverbought;
      }
      CATEGORIES.forEach(cat=>{totalEpisodes[cat]+=idxByCat[cat].length;});

      RSI_BACKTEST_WINDOWS.forEach(n=>{
        CATEGORIES.forEach(cat=>{
          idxByCat[cat].forEach(idx=>{const r=fwdReturn(idx,n);if(r!=null)pooled[cat][n].push(r);});
        });
        for(let i=0;i<closes.length-n;i++){
          const r=fwdReturn(i,n);
          if(r!=null)baselinePooled[n].push(r);
        }
      });
    }catch{}
  });

  const summarizePool=(arr)=>{
    if(!arr.length)return null;
    const avgReturn=arr.reduce((a,b)=>a+b,0)/arr.length;
    const pctPositive=arr.filter(r=>r>0).length/arr.length*100;
    return{count:arr.length,avgReturn,pctPositive};
  };

  const result={tickersWithData,tickersTotal:tickers.length};
  CATEGORIES.forEach(cat=>{
    const d={occurrences:totalEpisodes[cat],windows:{}};
    RSI_BACKTEST_WINDOWS.forEach(n=>{
      const s=summarizePool(pooled[cat][n]);
      const baseline=summarizePool(baselinePooled[n])?.avgReturn;
      d.windows[n]=s?{...s,baseline,excess:baseline!=null?s.avgReturn-baseline:null}:null;
    });
    result[cat]=d;
  });

  return result;
}

function formatStrike(x){return x===Math.floor(x)?x.toString():x.toFixed(2);}

function fmtCap(v){if(!v)return'N/A';if(v>=1e12)return`$${(v/1e12).toFixed(2)}T`;if(v>=1e9)return`$${(v/1e9).toFixed(2)}B`;if(v>=1e6)return`$${(v/1e6).toFixed(2)}M`;return`$${v}`;}

function computeVolumeProfile(closes,volumes,nBuckets=40,topN=5){const pairs=closes.map((c,i)=>[c,volumes[i]]).filter(([c,v])=>c&&v);if(!pairs.length)return{levels:[],centers:[],vols:[]};const allC=pairs.map(p=>p[0]);const mn=Math.min(...allC),mx=Math.max(...allC);const edges=Array.from({length:nBuckets+1},(_,i)=>mn+(mx-mn)*i/nBuckets);const centers=edges.slice(0,-1).map((e,i)=>(e+edges[i+1])/2);const bvols=new Array(nBuckets).fill(0);pairs.forEach(([price,vol])=>{let idx=edges.slice(1).findIndex(e=>price<=e);if(idx<0)idx=nBuckets-1;bvols[idx]+=vol;});const topIdxs=[...bvols.entries()].sort((a,b)=>b[1]-a[1]).slice(0,topN).map(e=>e[0]);return{levels:topIdxs.map(i=>centers[i]).sort((a,b)=>a-b),centers,vols:bvols};}

function getRoundNumbers(price,w=0.25){const low=price*(1-w),high=price*(1+w);const step=price>=500?50:price>=100?25:price>=50?10:5;const rounds=[];let v=Math.floor(low/step)*step;while(v<=high){if(v>=low&&v<=high)rounds.push(v);v+=step;}return rounds;}

// computeIVR: Historical Volatility Rank (HVR)
// Compares today's 21-day realized volatility against its own 1-year range.
// Apples-to-apples comparison eliminates the volatility risk premium bias.
// Returns 0-100 where 100 = current vol at 1-year high, 0 = at 1-year low.
// Falls back to price-range proxy if hist2y not yet cached.
function computeIVR(ticker,w52h,w52l,price){
  try{
    // ── Primary: HVR from hist2y rolling realized volatility ─────────────
    const h2=S.get('hist2y_'+ticker);
    if(h2?.closes?.length>=63){
      const closes=h2.closes.filter(c=>c!=null&&c>0);
      if(closes.length>=63){
        // Daily log returns
        const logRet=[];
        for(let i=1;i<closes.length;i++){
          if(closes[i]>0&&closes[i-1]>0)logRet.push(Math.log(closes[i]/closes[i-1]));
        }
        // Rolling 21-day annualized HRV for each day
        const win=21;const annFactor=Math.sqrt(252);
        const hrvs=[];
        for(let i=win;i<=logRet.length;i++){
          const slice=logRet.slice(i-win,i);
          const m=slice.reduce((s,v)=>s+v,0)/win;
          const variance=slice.reduce((s,v)=>s+(v-m)*(v-m),0)/(win-1);
          hrvs.push(Math.sqrt(variance)*annFactor);
        }
        // Use last 252 windows (1 year) for the range
        const hrvWindow=hrvs.slice(-252);
        if(hrvWindow.length>=21){
          const currentHRV=hrvWindow[hrvWindow.length-1]; // most recent 21-day HRV
          const minHRV=Math.min(...hrvWindow);
          const maxHRV=Math.max(...hrvWindow);
          if(maxHRV>minHRV){
            // HVR: where does current realized vol sit in its own 1-year range?
            const hvr=(currentHRV-minHRV)/(maxHRV-minHRV)*100;
            return Math.min(100,Math.max(0,Math.round(hvr)));
          }
        }
      }
    }

    // ── Fallback: capped price-range proxy if hist2y not yet cached ───────
    // Cap rangeVol at 0.8 (80%) to prevent distortion from momentum stocks
    if(!w52h||!w52l||w52h<=w52l)return null;
    const rangeVol=Math.min((w52h-w52l)/w52l,0.8);
    // Get current ATM IV from options chain for fallback
    const cached=S.get('options_'+ticker);
    const res=cached?.data?.optionChain?.result?.[0];
    if(!res)return null;
    const opts=res.options?.[0];if(!opts)return null;
    const atm=[...(opts.puts||[]),...(opts.calls||[])]
      .filter(o=>Math.abs(o.strike-price)/price<0.05&&o.impliedVolatility>0);
    if(!atm.length)return null;
    const currentIV=avg(atm.map(o=>o.impliedVolatility));
    return Math.min(100,Math.max(0,Math.round((currentIV/(rangeVol*0.6))*50)));

  }catch{return null;}
}

// Returns full HVR series aligned to hist2y timestamps for charting.
// Each value is 0-100 (where current 21-day HRV sits in its 1-year min-max range).
// Returns null if insufficient data.
// ── Earnings confirmed cache helpers ─────────────────────────────────────────
// earnings_pending_TICKER: future dates seen by the app, waiting to be promoted
// earnings_confirmed_TICKER: past dates promoted after they passed
// Both persist across watchlist removals. Eviction: 730 days + 10 day buffer.

const _EARN_EVICT_DAYS = 740;

// Save a future earnings date to the pending cache.
// If an entry exists within ±10 days, update it (Finnhub may correct date slightly).
// Only saves future dates.
function saveEarningsPending(ticker, date, hour){
  if(!ticker||!date)return;
  try{
    if(new Date(date)<=new Date())return; // only save future dates
    const pending=S.get('earnings_pending_'+ticker)||[];
    const existIdx=pending.findIndex(p=>Math.abs(new Date(p.date)-new Date(date))<11*86400000);
    if(existIdx>=0){
      // Update existing entry with latest Finnhub data
      pending[existIdx]={date,hour:hour||null,savedTs:nowPT()};
    }else{
      pending.push({date,hour:hour||null,savedTs:nowPT()});
    }
    // Keep only the 4 most recent pending entries (safety limit)
    pending.sort((a,b)=>b.date.localeCompare(a.date));
    S.set('earnings_pending_'+ticker,pending.slice(0,4));
  }catch{}
}

// Promote any pending dates that have now passed into the confirmed cache.
// Call on every fetch. Returns true if any entries were promoted.
function promoteEarningsPending(ticker){
  try{
    const today=_todayET();
    const pending=S.get('earnings_pending_'+ticker)||[];
    if(!pending.length)return false;
    const cutoff=new Date();cutoff.setDate(cutoff.getDate()-_EARN_EVICT_DAYS);
    const confirmed=S.get('earnings_confirmed_'+ticker)||[];
    let changed=false;
    const stillPending=[];
    pending.forEach(p=>{
      if(p.date<=today){
        // Date has passed -- promote to confirmed
        if(new Date(p.date)>=cutoff){
          const alreadyHave=confirmed.some(c=>Math.abs(new Date(c.date)-new Date(p.date))<4*86400000);
          if(!alreadyHave){
            confirmed.push({date:p.date,hour:p.hour||null,addedTs:nowPT()});
            changed=true;
          }
        }
        // Don't keep in pending -- it's been handled
      }else{
        stillPending.push(p); // still future -- keep in pending
      }
    });
    if(changed){
      const fresh=confirmed.filter(c=>new Date(c.date)>=cutoff);
      S.set('earnings_confirmed_'+ticker,fresh);
    }
    // Update pending (remove promoted entries)
    if(stillPending.length!==pending.length){
      S.set('earnings_pending_'+ticker,stillPending);
    }
    return changed;
  }catch{return false;}
}

// Parse an addedTs string (format: "MM/DD/YYYY, HH:MM PT/UTC/local") into a
// Date for comparison. Returns null if unparseable.
function _parseAddedTs(ts){
  if(!ts)return null;
  const m=String(ts).match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if(!m)return null;
  return new Date(Date.UTC(+m[3],+m[1]-1,+m[2]));
}

// One-time-in-spirit (but flagless) cleanup: a bug live from v251 through v256
// fed Yahoo's fiscal PERIOD-END dates into earnings_confirmed_ instead of
// announcement dates. Rather than guessing from what a date's value looks like
// (a real earnings date could, rarely, land near a quarter boundary -- that's
// not a safe signal to delete on), this filters by *when* each entry was
// written: only entries added during the actual window the buggy code was
// live (2026-07-14 through 2026-07-18, generously covering the session this
// shipped in) are removed. Everything older -- including months or years of
// genuine confirmed dates -- is structurally untouched, since its addedTs
// can never fall in that window. Safe to call on every init: it's anchored
// to a fixed historical range, so it naturally stops matching anything once
// enough real time has passed, with no flag or export bookkeeping needed.
// Can be deleted outright in a few months once this window is long past.
function purgeContaminatedConfirmedEarnings(){
  try{
    const winStart=new Date(Date.UTC(2026,6,14)),winEnd=new Date(Date.UTC(2026,6,18));
    Object.keys(localStorage).filter(k=>k.startsWith('earnings_confirmed_')).forEach(k=>{
      const arr=S.get(k)||[];
      const clean=arr.filter(e=>{
        const added=_parseAddedTs(e.addedTs);
        return !(added&&added>=winStart&&added<=winEnd);
      });
      if(clean.length!==arr.length)S.set(k,clean);
    });
  }catch{}
}

function computeHVRSeries(ticker,preloadedHist2y){
  try{
    const h2=preloadedHist2y||S.get('hist2y_'+ticker);
    if(!h2?.closes?.length||h2.closes.length<63)return null;
    const closes=h2.closes;
    const timestamps=h2.timestamps;

    // Daily log returns (aligned to closes)
    const logRet=[];
    const logRetIdx=[]; // which close index each return corresponds to
    for(let i=1;i<closes.length;i++){
      if(closes[i]!=null&&closes[i]>0&&closes[i-1]!=null&&closes[i-1]>0){
        logRet.push(Math.log(closes[i]/closes[i-1]));
        logRetIdx.push(i);
      }
    }
    if(logRet.length<42)return null;

    // Rolling 21-day annualized HRV
    const win=21;const annFactor=Math.sqrt(252);
    const hrvs=[];
    const hrvTsIdx=[];
    for(let i=win;i<=logRet.length;i++){
      const slice=logRet.slice(i-win,i);
      const m=slice.reduce((s,v)=>s+v,0)/win;
      const variance=slice.reduce((s,v)=>s+(v-m)*(v-m),0)/(win-1);
      hrvs.push(Math.sqrt(variance)*annFactor);
      hrvTsIdx.push(logRetIdx[i-1]); // timestamp index in closes array
    }

    // Compute rolling 1-year min/max for normalization (252 windows)
    const hvrSeries=[];
    const hvrTimestamps=[];
    for(let i=0;i<hrvs.length;i++){
      const window=hrvs.slice(Math.max(0,i-251),i+1);
      const minH=Math.min(...window);
      const maxH=Math.max(...window);
      const normalized=maxH>minH?Math.min(100,Math.max(0,Math.round((hrvs[i]-minH)/(maxH-minH)*100))):50;
      hvrSeries.push(normalized);
      hvrTimestamps.push(timestamps[hrvTsIdx[i]]);
    }
    return{values:hvrSeries,timestamps:hvrTimestamps};
  }catch{return null;}
}

function ivrInfo(val){
  // Unified IVR scale used throughout the app:
  // <30 Low | 30-49 Normal | 50-69 Elevated | >=70 High
  if(val===null)return{badge:'',guidance:'IV rank not available -- fetch options data to compute.'};
  if(val<30)return{badge:`<span class="ivr-badge ivr-low">Low Vol (${val.toFixed(0)})</span>`,guidance:`Vol Rank ${val.toFixed(0)}: Stock moving less than usual. Premiums relatively thin.`};
  if(val<50)return{badge:`<span class="ivr-badge ivr-normal">Normal Vol (${val.toFixed(0)})</span>`,guidance:`Vol Rank ${val.toFixed(0)}: Realized volatility in normal range. Standard conditions for premium collection.`};
  if(val<70)return{badge:`<span class="ivr-badge ivr-elevated">Elevated Vol (${val.toFixed(0)})</span>`,guidance:`Vol Rank ${val.toFixed(0)}: Stock moving more than usual. Above-average premium opportunity.`};
  return{badge:`<span class="ivr-badge ivr-high">High Vol (${val.toFixed(0)})</span>`,guidance:`Vol Rank ${val.toFixed(0)}: Stock at high end of its volatility range. Exceptional premiums -- tread carefully on naked puts.`};
}

const POS_WORDS=['beat','beats','surge','surges','upgrade','upgrades','raises','record','strong','soar','gain','rally','top'];
const NEG_WORDS=['miss','misses','cut','cuts','downgrade','downgrades','warning','weak','fall','drop','investigation','recall','decline','loss'];

function newsSentiment(h){const l=h.toLowerCase();if(POS_WORDS.some(w=>l.includes(w)))return{dot:'pos',css:'color:var(--green)'};if(NEG_WORDS.some(w=>l.includes(w)))return{dot:'neg',css:'color:var(--red)'};return{dot:'neu',css:'color:var(--text3)'};}

function sentDot(s){return s.dot==='pos'?'&#x1F7E2;':s.dot==='neg'?'&#x1F534;':'&#x26AA;';}

function renderNewsItems(newsArr,maxItems=5){if(!newsArr||!newsArr.length)return'<div style="font-family:var(--mono);font-size:11px;color:var(--text3);padding:8px 0">No recent news available</div>';const items=newsArr.slice(0,maxItems);const pos=items.filter(n=>newsSentiment(n.headline).dot==='pos').length;const neg=items.filter(n=>newsSentiment(n.headline).dot==='neg').length;return`<div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:8px">${items.length} articles -- ${pos} positive, ${neg} negative</div>`+items.map(n=>{const s=newsSentiment(n.headline);return`<div class="news-item"><div class="news-headline"><span style="${s.css}">${sentDot(s)}</span> <a href="${n.url}" target="_blank" rel="noopener">${n.headline}</a></div><div class="news-meta">${n.source} -- ${relTime(n.datetime)}</div>${n.summary?`<div class="news-summary">${n.summary.slice(0,120)}...</div>`:''}</div>`;}).join('');}

// ── Debug log (rolling 20 entries, displayed in Settings) ─────────────────────
window._dbgLog = [];
function dbgLog(msg){
  const ts = new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  window._dbgLog.unshift('['+ts+'] '+msg);
  if(window._dbgLog.length > 20) window._dbgLog.pop();
}
function clearDbgLog(){ window._dbgLog = []; refreshDbgLogDisplay(); }
function refreshDbgLogDisplay(){
  const el = document.getElementById('debug-log-entries');
  if(!el) return;
  el.innerHTML = window._dbgLog.length
    ? window._dbgLog.map(l=>'<div style="border-bottom:1px solid var(--border);padding:3px 0;word-break:break-all">'+l+'</div>').join('')
    : '<div style="color:var(--text3)">No entries yet.</div>';
}
