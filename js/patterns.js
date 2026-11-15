// ============================================
// Income Engine -- patterns.js (build 553)
// Technical pattern badges, Phase 1: golden/death cross (50-day vs
// 200-day simple moving average) and new 52-week high/low.
//
// Design rules (see tests/patterns.test.js):
// - ONE shared computation (_computePatternsForTicker) feeds the watchlist
//   badge, the Ticker-tab header badge and the Patterns card, so the three
//   can never disagree about what is active.
// - Always reads the RAW cached hist2y_<ticker> (unadjusted closes), never
//   the Ticker tab's transformed copy, which can swap in dividend-adjusted
//   closes when the Relative Performance "Total Return" toggle is on.
//   Pattern badges must not flip with a presentation toggle.
// - Every output array is index-aligned with the input closes/timestamps.
//   Nulls are never used in arithmetic (null-arithmetic bug class).
// - Not wired into scoring. Badges are context, not signals.
// ============================================

// A cross counts as "recent" for this many trading bars (today = bar 0).
const PATTERN_CROSS_RECENT_DAYS=20;
// A new 52-week closing high/low counts as "recent" for this many bars.
const PATTERN_52W_RECENT_DAYS=5;
// Needs a full year of bars before "52-week" means anything.
const PATTERN_52W_MIN_BARS=252;
// Two crosses closer together than this are flagged as whipsaw.
const PATTERN_WHIPSAW_DAYS=60;

const PATTERN_META={
  golden:{
    label:'Golden Cross',bias:'bullish',
    meaning:"The 50-day average crossed above the 200-day average. Often read as the longer-term trend turning up. It lags: price has usually been rising for weeks already, so treat it as confirmation of a trend, not an early warning.",
    wheel:"For put selling: supportive context, since you would be taking assignment into a rising longer-term trend."
  },
  death:{
    label:'Death Cross',bias:'bearish',
    meaning:"The 50-day average crossed below the 200-day average. Often read as the longer-term trend turning down. It lags: much of the decline has usually already happened, and it can fail if price recovers.",
    wheel:"For put selling: a reason to be pickier about strikes and entry, since assignment would come into a weakening trend."
  },
  high52:{
    label:'52W High',bias:'bullish',
    meaning:"The latest close set the highest close of the past year. Often read as momentum: every holder from the past year is in profit and sellers are being absorbed. Stocks at highs can also pull back.",
    wheel:"For put selling: the trend is strong, but strikes comfortably below price still matter if a pullback comes."
  },
  low52:{
    label:'52W Low',bias:'bearish',
    meaning:"The latest close set the lowest close of the past year. Often read as weakness: every buyer from the past year is underwater. A stock that looks cheap can keep falling (a falling knife).",
    wheel:"For put selling: assignment here would mean owning a stock in a clear downtrend, which is worth extra caution."
  }
};

function _patternColor(bias){return bias==='bullish'?'var(--green)':'var(--red)';}
function _patIsNum(v){return typeof v==='number'&&isFinite(v);}
function _patDaysText(d){return d===0?'today':d+'d';}

// Simple moving average aligned with `values` (same length). out[i] is the
// mean of the last `period` NON-NULL values ending at i, and is null when
// values[i] itself is null or fewer than `period` valid values exist so far.
// Skipping nulls (instead of nulling the next `period` outputs) matters: a
// single missing bar must not blind a 200-bar average for 200 bars.
function computeSMA(values,period){
  const out=new Array(Array.isArray(values)?values.length:0).fill(null);
  if(!Array.isArray(values)||!(period>=1))return out;
  const win=[];
  for(let i=0;i<values.length;i++){
    const v=values[i];
    if(!_patIsNum(v))continue;
    win.push(v);
    if(win.length>period)win.shift();
    if(win.length===period){
      let s=0;
      for(let k=0;k<period;k++)s+=win[k];
      out[i]=s/period;
    }
  }
  return out;
}

// Index of the highest/lowest close over the last 252 bars. Deliberately the
// SAME rule as _compute52W (ticker.js): first occurrence wins on ties, so a
// close that merely equals an earlier high is not a "new" high, and the
// date agrees with the 52W tiles. tests/patterns.test.js cross-checks both.
function _patWeek52Extremes(closes){
  if(!Array.isArray(closes)||closes.length<2)return null;
  const n=Math.min(252,closes.length);
  const start=closes.length-n;
  let hi=start,lo=start;
  for(let i=start+1;i<closes.length;i++){
    if(closes[i]!=null&&(closes[hi]==null||closes[i]>closes[hi]))hi=i;
    if(closes[i]!=null&&(closes[lo]==null||closes[i]<closes[lo]))lo=i;
  }
  if(closes[hi]==null||closes[lo]==null)return null;
  return{hiIdx:hi,loIdx:lo};
}

// Crossings of `fast` over/under `slow`. A cross is a change in the sign of
// the most recent NON-ZERO difference, so touching the other line and
// bouncing back is not a cross, and the first relation seen is the starting
// state, not a cross. Differences within a tiny relative tolerance count as
// zero so float noise cannot invent a cross. A null in either array skips
// that bar; sign tracking continues across the gap, so a cross that happens
// during a gap is reported on the first valid bar after it.
function _patFindCrosses(fast,slow){
  const crosses=[];
  let lastSign=0;
  const n=Math.min(fast.length,slow.length);
  for(let i=0;i<n;i++){
    const a=fast[i],b=slow[i];
    if(!_patIsNum(a)||!_patIsNum(b))continue;
    const d=a-b;
    const tol=1e-9*Math.max(Math.abs(a),Math.abs(b),1);
    const sign=Math.abs(d)<=tol?0:(d>0?1:-1);
    if(sign===0)continue;
    if(lastSign!==0&&sign!==lastSign)crosses.push({type:sign>0?'golden':'death',idx:i});
    lastSign=sign;
  }
  return{crosses,trendSign:lastSign};
}

function _patWhipsaw(crosses){
  return crosses.length>=2&&(crosses[crosses.length-1].idx-crosses[crosses.length-2].idx)<=PATTERN_WHIPSAW_DAYS;
}

// Pure core: closes (and optional index-aligned timestamps) in, everything
// the badges and card need out. Returns null if there is no usable data.
function _computePatternsFromSeries(closes,timestamps){
  if(!Array.isArray(closes))return null;
  let lastIdx=closes.length-1;
  while(lastIdx>=0&&!_patIsNum(closes[lastIdx]))lastIdx--; // skip an unsettled/missing latest bar
  if(lastIdx<1)return null;
  const tsAt=i=>(timestamps&&timestamps[i]!=null)?timestamps[i]:null;
  const lastClose=closes[lastIdx];
  let validBars=0;
  for(let i=0;i<=lastIdx;i++)if(_patIsNum(closes[i]))validBars++;

  const sma50=computeSMA(closes,50);
  const sma200=computeSMA(closes,200);
  const s50=sma50[lastIdx],s200=sma200[lastIdx];
  const out={
    validBars,lastIdx,lastClose,lastTs:tsAt(lastIdx),
    hasSMA200:s200!=null,sma50:s50,sma200:s200,
    trend:null,pctVs200:null,crosses:[],lastCross:null,whipsaw:false,
    week52:null,events:[]
  };
  if(!out.hasSMA200)return out; // not enough history: no state, no events

  const found=_patFindCrosses(sma50,sma200);
  out.trend=found.trendSign>0?'above':(found.trendSign<0?'below':null);
  out.pctVs200=(lastClose/s200-1)*100;
  out.crosses=found.crosses.map(c=>({type:c.type,idx:c.idx,ts:tsAt(c.idx),daysAgo:lastIdx-c.idx}));
  out.lastCross=out.crosses.length?out.crosses[out.crosses.length-1]:null;
  out.whipsaw=_patWhipsaw(found.crosses);

  // Only the MOST RECENT cross can be an active badge, so a golden cross
  // quickly followed by a death cross shows the death cross, not both.
  const events=[];
  if(out.lastCross&&out.lastCross.daysAgo<PATTERN_CROSS_RECENT_DAYS){
    const c=out.lastCross;
    events.push({kind:c.type,label:PATTERN_META[c.type].label,bias:PATTERN_META[c.type].bias,daysAgo:c.daysAgo,ts:c.ts,idx:c.idx});
  }
  if(closes.length>=PATTERN_52W_MIN_BARS){
    const ext=_patWeek52Extremes(closes);
    if(ext){
      const hi=closes[ext.hiIdx],lo=closes[ext.loIdx];
      out.week52={
        high:hi,low:lo,hiIdx:ext.hiIdx,loIdx:ext.loIdx,
        hiDaysAgo:lastIdx-ext.hiIdx,loDaysAgo:lastIdx-ext.loIdx,
        pctFromHigh:(lastClose/hi-1)*100,pctFromLow:(lastClose/lo-1)*100
      };
      const w=[];
      if(out.week52.hiDaysAgo<PATTERN_52W_RECENT_DAYS)w.push({kind:'high52',label:PATTERN_META.high52.label,bias:'bullish',daysAgo:out.week52.hiDaysAgo,ts:tsAt(ext.hiIdx),idx:ext.hiIdx});
      if(out.week52.loDaysAgo<PATTERN_52W_RECENT_DAYS)w.push({kind:'low52',label:PATTERN_META.low52.label,bias:'bearish',daysAgo:out.week52.loDaysAgo,ts:tsAt(ext.loIdx),idx:ext.loIdx});
      w.sort((a,b)=>a.daysAgo-b.daysAgo);
      w.forEach(e=>events.push(e));
    }
  }
  out.events=events;
  return out;
}

function _computePatternsForTicker(ticker){
  try{
    const h=S.get('hist2y_'+ticker);
    if(!h||!Array.isArray(h.closes))return null;
    return _computePatternsFromSeries(h.closes,h.timestamps);
  }catch{return null;}
}

// ── Display ───────────────────────────────────────────────────────────────

function _patDateStr(ts){
  try{
    if(ts==null)return null;
    const s=_wheelBacktestDateStr(ts,true);
    return s||null;
  }catch{return null;}
}

// Compact bracket badge for a watchlist chip's own full-width row, matching
// _rsiTransitionBadgeHtml / _gapBadgeHtml. Shows only the top event.
function _patternWatchlistBadgeHtml(ticker){
  const p=_computePatternsForTicker(ticker);
  const ev=p&&p.events[0];
  if(!ev)return'';
  const color=_patternColor(ev.bias);
  const more=p.events.length>1?' +'+(p.events.length-1):'';
  return'<div style="font-family:var(--mono);font-size:10px">'
    +'<span style="color:'+color+';font-weight:600">['+ev.label+' &middot; '+_patDaysText(ev.daysAgo)+more+']</span>'
    +'</div>';
}

// Outlined pill (the Ex-div pill is filled teal, which green could be
// mistaken for). `clickable` makes it expand and scroll to the Patterns card.
function _patternPillHtml(ev,clickable){
  const color=_patternColor(ev.bias);
  const dateStr=_patDateStr(ev.ts);
  const title=ev.label+' -- '+(ev.daysAgo===0?'latest bar':ev.daysAgo+' trading day'+(ev.daysAgo!==1?'s':'')+' ago')+(dateStr?' ('+dateStr+')':'');
  return'<span'+(clickable?' onclick="_patternsOpenFromHeader()"':'')+' title="'+title+'" style="display:inline-flex;align-items:center;'
    +'border:1px solid '+color+';color:'+color+';background:transparent;font-family:var(--mono);font-size:9px;font-weight:700;'
    +'padding:1px 5px;border-radius:4px;margin-left:5px;vertical-align:middle;letter-spacing:0.3px;text-transform:none;'
    +(clickable?'cursor:pointer;':'')+'">'+ev.label+' &middot; '+_patDaysText(ev.daysAgo)+'</span>';
}

// Ticker-tab header badge: top event only (plus "+N"), tap to expand the card.
function _patternHeaderBadgeHtml(ticker){
  const p=_computePatternsForTicker(ticker);
  const ev=p&&p.events[0];
  if(!ev)return'';
  const pill=_patternPillHtml(ev,true);
  const more=p.events.length>1
    ?'<span onclick="_patternsOpenFromHeader()" style="font-family:var(--mono);font-size:9px;color:var(--text3);margin-left:4px;cursor:pointer;text-transform:none;letter-spacing:0">+'+(p.events.length-1)+'</span>'
    :'';
  return pill+more;
}

function _patternsStatusText(p){
  const parts=[];
  if(p.trend){
    let s='The 50-day average is '+p.trend+' the 200-day';
    if(p.lastCross){
      const d=_patDateStr(p.lastCross.ts);
      s+=' (since the '+PATTERN_META[p.lastCross.type].label.toLowerCase()+(d?' on '+d:'')+')';
    }else s+=' (no cross in the cached history)';
    parts.push(s);
  }
  if(p.pctVs200!=null)parts.push('Price is '+Math.abs(p.pctVs200).toFixed(1)+'% '+(p.pctVs200>=0?'above':'below')+' the 200-day');
  if(p.week52){
    const d=p.week52.pctFromHigh;
    parts.push(d>-0.05?'Price is at its 52-week closing high':'Price is '+Math.abs(d).toFixed(1)+'% below its 52-week closing high');
  }
  return parts.length?parts.join('. ')+'.':'';
}

function _patternsQuietText(p){
  const bits=['Patterns: none recent'];
  if(p.trend)bits.push('50-day '+p.trend+' 200-day');
  if(p.pctVs200!=null)bits.push('price '+(p.pctVs200>=0?'+':'-')+Math.abs(p.pctVs200).toFixed(1)+'% vs 200-day');
  return bits.join(' &middot; ');
}

// Ticker-tab card. Three states: one-line (no history / nothing recent, no
// expander at all) or a collapsed-by-default card whose header shows the
// active badge(s). Expandability is exactly "there is an active event".
function _patternsCardHtml(ticker){
  const p=_computePatternsForTicker(ticker);
  if(!p)return'';
  const line=txt=>'<div class="card"><div style="font-family:var(--mono);font-size:11px;color:var(--text3)">'+txt+'</div></div>';
  if(!p.hasSMA200)return line('Patterns: needs 200 days of price history ('+p.validBars+' cached so far)');
  if(!p.events.length)return line(_patternsQuietText(p));

  const dot=_patternColor(p.events[0].bias);
  const pills=p.events.map(ev=>_patternPillHtml(ev,false)).join('');
  const head='<div class="gs-header" onclick="_patternsToggle()">'
    +'<div class="card-title" style="margin:0;flex-wrap:wrap;row-gap:4px"><span class="dot" style="background:'+dot+'"></span>Patterns'+pills+'</div>'
    +'<span class="gs-chevron" id="patterns-chevron">&#9658;</span></div>';

  const mono='font-family:var(--mono);';
  let body='<div style="'+mono+'font-size:11px;color:var(--text2);line-height:1.5;margin-bottom:10px">'+_patternsStatusText(p)+'</div>';
  p.events.forEach(ev=>{
    const m=PATTERN_META[ev.kind];
    const color=_patternColor(ev.bias);
    const d=_patDateStr(ev.ts);
    const when=ev.daysAgo===0?'latest bar':ev.daysAgo+' trading day'+(ev.daysAgo!==1?'s':'')+' ago';
    body+='<div style="padding-top:10px;border-top:1px solid var(--surface3);margin-top:2px">'
      +'<div style="'+mono+'font-size:12px;font-weight:600;color:'+color+';margin-bottom:4px">'+m.label+' -- '+when+(d?' ('+d+')':'')+'</div>'
      +'<div style="'+mono+'font-size:11px;color:var(--text2);line-height:1.5">'+m.meaning+'</div>'
      +'<div style="'+mono+'font-size:11px;color:var(--text2);line-height:1.5;margin-top:4px">'+m.wheel+'</div>';
    if((ev.kind==='golden'||ev.kind==='death')&&p.whipsaw){
      body+='<div style="'+mono+'font-size:11px;color:var(--warn);line-height:1.5;margin-top:4px">Whipsaw: this is the second cross within '+PATTERN_WHIPSAW_DAYS+' trading days. Back-and-forth crossing is common when price moves sideways and weakens the signal.</div>';
    }
    body+='</div>';
  });
  if(p.crosses.length){
    const recent=p.crosses.slice(-3).reverse().map(c=>{
      const d=_patDateStr(c.ts);
      return PATTERN_META[c.type].label+(d?' '+d:'');
    }).join(' &middot; ');
    body+='<div style="'+mono+'font-size:10px;color:var(--text3);margin-top:10px;padding-top:10px;border-top:1px solid var(--surface3)">Recent crosses in cached history: '+recent+'</div>';
  }
  body+='<div style="'+mono+'font-size:9px;color:var(--text3);margin-top:6px;line-height:1.5">Patterns describe what has already happened and are context, not predictions. They use unadjusted daily closes.</div>';

  return'<div class="card" id="patterns-card">'+head+'<div class="gs-body" id="patterns-body">'+body+'</div></div>';
}

// Same collapse mechanism as the Guide sections and the Multiple History
// raw-data panel. Not persisted: the page regenerates on every render and
// the card is meant to start collapsed.
function _patternsToggle(){
  const bodyEl=document.getElementById('patterns-body');
  const chev=document.getElementById('patterns-chevron');
  if(!bodyEl)return;
  const isOpen=bodyEl.classList.contains('open');
  bodyEl.classList.toggle('open',!isOpen);
  if(chev)chev.classList.toggle('open',!isOpen);
}

function _patternsOpenFromHeader(){
  const bodyEl=document.getElementById('patterns-body');
  if(bodyEl&&!bodyEl.classList.contains('open'))_patternsToggle();
  const card=document.getElementById('patterns-card');
  if(card&&card.scrollIntoView)card.scrollIntoView({behavior:'smooth',block:'start'});
}
