// ============================================
// Income Engine -- patterns.js (build 555)
// Technical pattern badges, Phase 1: golden/death cross (50-day vs
// 200-day simple moving average) and new 52-week high/low.
//
// Design rules (see tests/patterns.test.js):
// - ONE shared computation (_computePatternsForTicker) feeds the watchlist
//   badge, the Ticker-tab header badge, the Patterns card and its chart, so
//   they can never disagree about what is active.
// - Always reads the RAW cached hist2y_<ticker> (unadjusted closes), never
//   the Ticker tab's transformed copy. Pattern badges must not flip with a
//   presentation toggle.
// - Every output array is index-aligned with the input closes/timestamps.
//   Nulls are never used in arithmetic (null-arithmetic bug class).
// - "N days ago" is counted from the last cached bar, so a cache that has
//   not been refreshed in weeks would claim "1d" for something weeks old.
//   Price history older than PATTERN_STALE_DAYS therefore suppresses every
//   badge and the card says how old the data is.
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
// Cached price history whose last bar is older than this many calendar
// days is stale: no badges. (A long weekend is at most ~4.)
const PATTERN_STALE_DAYS=7;

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

// Chart marker colors (Chart.js needs literal colors, not CSS variables).
const PATTERN_CHART_COLORS={price:'#e8eaf0',sma50:'#ff9800',sma200:'#7c6af7',bullish:'#00c896',bearish:'#ff4757'};

function _patternColor(bias){return bias==='bullish'?'var(--green)':'var(--red)';}
function _patIsNum(v){return typeof v==='number'&&isFinite(v);}
function _patDaysText(d){return d===0?'today':d+'d';}
// Indirection so tests can pin "now".
function _patNow(){return Date.now();}
// Epoch seconds, epoch ms, Date or ISO string -> epoch ms (null if unusable).
function _patTsMs(ts){
  if(ts==null)return null;
  let ms;
  if(ts instanceof Date)ms=ts.getTime();
  else if(typeof ts==='number')ms=ts<1e10?ts*1000:ts;
  else if(typeof ts==='object'&&typeof ts.getTime==='function')ms=ts.getTime(); // Date from another realm
  else ms=Date.parse(ts);
  return _patIsNum(ms)?ms:null;
}

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
// the badges, card and chart need out. Returns null if there is no usable
// data. opts.now pins "now" (ms); opts.series also returns the aligned
// arrays the chart draws.
function _computePatternsFromSeries(closes,timestamps,opts){
  if(!Array.isArray(closes))return null;
  let lastIdx=closes.length-1;
  while(lastIdx>=0&&!_patIsNum(closes[lastIdx]))lastIdx--; // skip an unsettled/missing latest bar
  if(lastIdx<1)return null;
  const tsAt=i=>(timestamps&&timestamps[i]!=null)?timestamps[i]:null;
  const lastClose=closes[lastIdx];
  let validBars=0;
  for(let i=0;i<=lastIdx;i++)if(_patIsNum(closes[i]))validBars++;

  // Data age, counted in calendar days from the last real bar to "now".
  const nowMs=(opts&&_patIsNum(opts.now))?opts.now:_patNow();
  const lastMs=_patTsMs(tsAt(lastIdx));
  const ageDays=lastMs==null?null:Math.max(0,Math.floor((nowMs-lastMs)/86400000));
  const stale=ageDays!=null&&ageDays>PATTERN_STALE_DAYS;

  const sma50=computeSMA(closes,50);
  const sma200=computeSMA(closes,200);
  const s50=sma50[lastIdx],s200=sma200[lastIdx];
  const out={
    validBars,lastIdx,lastClose,lastTs:tsAt(lastIdx),ageDays,stale,
    hasSMA200:s200!=null,sma50:s50,sma200:s200,
    trend:null,pctVs200:null,crosses:[],lastCross:null,whipsaw:false,
    week52:null,events:[],series:null
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
  // Stale price history: day counts would be measured from an old last bar,
  // so nothing may claim to be "recent".
  out.events=stale?[]:events;
  if(opts&&opts.series)out.series={closes,sma50,sma200,ts:timestamps||null};
  return out;
}

function _computePatternsForTicker(ticker,opts){
  try{
    const h=S.get('hist2y_'+ticker);
    if(!h||!Array.isArray(h.closes))return null;
    return _computePatternsFromSeries(h.closes,h.timestamps,opts);
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
  const sentences=[];
  if(p.trend){
    let s='The 50-day average is '+p.trend+' the 200-day';
    if(p.lastCross){
      const d=_patDateStr(p.lastCross.ts);
      s+=' (since the '+PATTERN_META[p.lastCross.type].label.toLowerCase()+(d?' on '+d:'')+')';
    }else s+=' (no cross in the cached history)';
    sentences.push(s);
  }
  // One price sentence, not two: "Price is X% above the 200-day and Y% below its 52-week closing high."
  const price=[];
  if(p.pctVs200!=null)price.push(Math.abs(p.pctVs200).toFixed(1)+'% '+(p.pctVs200>=0?'above':'below')+' the 200-day');
  if(p.week52){
    const d=p.week52.pctFromHigh;
    price.push(d>-0.05?'at its 52-week closing high':Math.abs(d).toFixed(1)+'% below its 52-week closing high');
  }
  if(price.length)sentences.push('Price is '+price.join(' and '));
  return sentences.length?sentences.join('. ')+'.':'';
}

function _patternsQuietText(p){
  const bits=['Patterns: none recent'];
  if(p.trend)bits.push('50-day '+p.trend+' 200-day');
  if(p.pctVs200!=null)bits.push('price '+(p.pctVs200>=0?'+':'-')+Math.abs(p.pctVs200).toFixed(1)+'% vs 200-day');
  return bits.join(' &middot; ');
}

// ── Chart ─────────────────────────────────────────────────────────────────

// Pure model for the chart: labels plus the aligned series and one marker
// per cross in the cached history and for the CURRENT 52-week high/low
// (every historical new high would flood the chart in an uptrend). A marker
// is "active" when it is one of the badge events. Crosses sit on the 50-day
// line; 52W markers sit on the close.
function _patternsChartModel(p){
  if(!p||!p.series||!p.hasSMA200)return null;
  const s=p.series,n=s.closes.length;
  const activeKeys=new Set(p.events.map(e=>e.kind+':'+e.idx));
  const markers=[];
  p.crosses.forEach(c=>{
    const y=s.sma50[c.idx];
    if(!_patIsNum(y))return;
    markers.push({kind:c.type,idx:c.idx,y,active:activeKeys.has(c.type+':'+c.idx),
      text:PATTERN_META[c.type].label+(_patDateStr(c.ts)?' -- '+_patDateStr(c.ts):'')});
  });
  if(p.week52){
    [['high52',p.week52.hiIdx],['low52',p.week52.loIdx]].forEach(([kind,idx])=>{
      const y=s.closes[idx];
      if(!_patIsNum(y))return;
      markers.push({kind,idx,y,active:activeKeys.has(kind+':'+idx),
        text:PATTERN_META[kind].label+' (closing)'+(_patDateStr(s.ts&&s.ts[idx])?' -- '+_patDateStr(s.ts[idx]):'')});
    });
  }
  const fmtFull=new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric'});
  const fmtMon=new Intl.DateTimeFormat('en-US',{month:'short'});
  const labels=new Array(n).fill(''),shortLabels=new Array(n).fill('');
  for(let i=0;i<n;i++){
    const ms=_patTsMs(s.ts&&s.ts[i]);
    if(ms==null)continue;
    const d=new Date(ms);
    labels[i]=fmtFull.format(d);
    shortLabels[i]=fmtMon.format(d)+" '"+String(d.getFullYear()).slice(2);
  }
  return{n,labels,shortLabels,price:s.closes,sma50:s.sma50,sma200:s.sma200,markers};
}

// Chart.js config for the model. Marker datasets are sparse line datasets
// (null everywhere except the marker bar) with showLine off. Styling follows
// the other Ticker-tab charts (tick color, grid color, legend off).
function _patternsChartConfig(m){
  const C=PATTERN_CHART_COLORS;
  const line=(label,data,color,width,dash)=>({label,data,borderColor:color,borderWidth:width,borderDash:dash||[],pointRadius:0,tension:0,fill:false,spanGaps:true});
  const markerDs=(kind,bias,style,rotation)=>{
    const color=C[bias];
    const data=new Array(m.n).fill(null),info={};
    m.markers.filter(k=>k.kind===kind).forEach(k=>{data[k.idx]=k.y;info[k.idx]=k;});
    const isActive=c=>!!(info[c.dataIndex]&&info[c.dataIndex].active);
    return{label:PATTERN_META[kind].label,data,showLine:false,markerInfo:info,
      pointStyle:style,pointRotation:rotation,
      pointRadius:c=>isActive(c)?7:4,pointHoverRadius:8,pointBorderWidth:2,pointBorderColor:color,
      pointBackgroundColor:c=>isActive(c)?color:'transparent'};
  };
  return{
    type:'line',
    data:{labels:m.labels,datasets:[
      line('Close',m.price,C.price,1.5),
      line('50-day',m.sma50,C.sma50,1,[4,3]),
      line('200-day',m.sma200,C.sma200,1,[4,3]),
      markerDs('golden','bullish','triangle',0),
      markerDs('death','bearish','triangle',180),
      markerDs('high52','bullish','circle',0),
      markerDs('low52','bearish','circle',0)
    ]},
    options:{
      responsive:true,maintainAspectRatio:false,animation:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{display:false},
        tooltip:{callbacks:{
          title:items=>items.length?m.labels[items[0].dataIndex]:'',
          label:item=>{
            const ds=item.dataset;
            if(ds.markerInfo){const k=ds.markerInfo[item.dataIndex];return k?k.text:'';}
            const v=item.parsed&&item.parsed.y;
            return _patIsNum(v)?ds.label+' $'+v.toFixed(2):'';
          }
        }}
      },
      scales:{
        x:{ticks:{color:'#555870',font:{size:9},maxTicksLimit:6,maxRotation:0,callback:v=>m.shortLabels[v]},grid:{color:'#2a2e38'}},
        y:{ticks:{color:'#555870',font:{size:9}},grid:{color:'#2a2e38'}}
      }
    }
  };
}

function _patternsDestroyChart(){
  try{if(typeof window!=='undefined'&&window._patternsChart){window._patternsChart.destroy();window._patternsChart=null;}}catch{}
}

// Built the first time the card is expanded: a Chart.js canvas inside a
// display:none container sizes wrongly, and most visits never expand it.
function _patternsEnsureChart(){
  try{
    if(typeof window==='undefined'||window._patternsChart)return;
    const card=document.getElementById('patterns-card');
    const canvas=document.getElementById('patterns-chart');
    if(!card||!canvas)return;
    const wrap=document.getElementById('patterns-chart-wrap');
    if(typeof Chart==='undefined'){
      if(wrap)wrap.innerHTML='<div style="font-family:var(--mono);font-size:10px;color:var(--text3)">Chart library not loaded.</div>';
      return;
    }
    const t=card.getAttribute('data-ticker');
    const m=_patternsChartModel(_computePatternsForTicker(t,{series:true}));
    if(!m)return;
    window._patternsChart=new Chart(canvas.getContext('2d'),_patternsChartConfig(m));
  }catch(e){console.warn('patterns chart',e);}
}

// ── Card ──────────────────────────────────────────────────────────────────

function _patternsGuideLinkHtml(kind,text){
  return'<span onclick="_patternsOpenGuide('+(kind?"'"+kind+"'":'')+')" style="font-family:var(--mono);font-size:10px;color:var(--accent3);text-decoration:underline;cursor:pointer">'+text+' &rarr;</span>';
}

// Ticker-tab card. Four states: one-line (no history / stale history /
// nothing recent, no expander at all) or a collapsed-by-default card whose
// header shows the active badge(s). Expandability is exactly "there is an
// active event".
function _patternsCardHtml(ticker){
  _patternsDestroyChart(); // the page is about to re-render; never leak the old chart
  const p=_computePatternsForTicker(ticker);
  if(!p)return'';
  const line=txt=>'<div class="card"><div style="font-family:var(--mono);font-size:11px;color:var(--text3)">'+txt+'</div></div>';
  if(p.stale){
    const d=_patDateStr(p.lastTs);
    return line('Patterns: price history ends '+(d||'a while ago')+' ('+p.ageDays+' days old) -- refresh to update');
  }
  if(!p.hasSMA200)return line('Patterns: needs 200 days of price history ('+p.validBars+' cached so far)');
  if(!p.events.length)return line(_patternsQuietText(p));

  const dot=_patternColor(p.events[0].bias);
  const pills=p.events.map(ev=>_patternPillHtml(ev,false)).join('');
  const head='<div class="gs-header" onclick="_patternsToggle()">'
    +'<div class="card-title" style="margin:0;flex-wrap:wrap;row-gap:4px"><span class="dot" style="background:'+dot+'"></span>Patterns'+pills+'</div>'
    +'<span class="gs-chevron" id="patterns-chevron">&#9658;</span></div>';

  const mono='font-family:var(--mono);';
  const asOf=_patDateStr(p.lastTs);
  let body='<div style="'+mono+'font-size:11px;color:var(--text2);line-height:1.5;margin-bottom:10px">'+_patternsStatusText(p)+'</div>';
  const C=PATTERN_CHART_COLORS;
  body+='<div id="patterns-chart-wrap" style="position:relative;height:190px"><canvas id="patterns-chart"></canvas></div>'
    +'<div style="display:flex;flex-wrap:wrap;gap:4px 12px;'+mono+'font-size:9px;color:var(--text3);margin:6px 0 10px;line-height:1.4">'
    +'<span><span style="color:'+C.price+'">&#9472;</span> Close</span>'
    +'<span><span style="color:'+C.sma50+'">&#9482;</span> 50-day</span>'
    +'<span><span style="color:'+C.sma200+'">&#9482;</span> 200-day</span>'
    +'<span><span style="color:'+C.bullish+'">&#9650;</span> golden</span>'
    +'<span><span style="color:'+C.bearish+'">&#9660;</span> death</span>'
    +'<span>&#9675; 52W high/low</span>'
    +'<span>large filled = active badge</span>'
    +(asOf?'<span>closes through '+asOf+'</span>':'')
    +'</div>';
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
    body+='<div style="margin-top:6px">'+_patternsGuideLinkHtml(ev.kind,'Definition in Guide')+'</div>';
    body+='</div>';
  });
  if(p.crosses.length){
    const recent=p.crosses.slice(-3).reverse().map(c=>{
      const d=_patDateStr(c.ts);
      return PATTERN_META[c.type].label+(d?' '+d:'');
    }).join(' &middot; ');
    body+='<div style="'+mono+'font-size:10px;color:var(--text3);margin-top:10px;padding-top:10px;border-top:1px solid var(--surface3)">Recent crosses in cached history: '+recent+'</div>';
  }
  body+='<div style="'+mono+'font-size:9px;color:var(--text3);margin-top:6px;line-height:1.5">Patterns describe what has already happened and are context, not predictions. They use unadjusted daily closes'+(asOf?' through '+asOf:'')+'.</div>';
  body+='<div style="margin-top:6px">'+_patternsGuideLinkHtml('','All pattern definitions in the Guide')+'</div>';

  const safeTicker=String(ticker).replace(/[&<>"']/g,'');
  return'<div class="card" id="patterns-card" data-ticker="'+safeTicker+'" style="scroll-margin-top:170px">'+head+'<div class="gs-body" id="patterns-body">'+body+'</div></div>';
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
  if(!isOpen)_patternsEnsureChart();
}

function _patternsOpenFromHeader(){
  const bodyEl=document.getElementById('patterns-body');
  if(bodyEl&&!bodyEl.classList.contains('open'))_patternsToggle();
  const card=document.getElementById('patterns-card');
  if(card&&card.scrollIntoView)card.scrollIntoView({behavior:'smooth',block:'start'});
}

// Jump from the card to the Guide: switch tab, open the Pattern Badges
// section, scroll to that pattern's row (or the section top) and flash it.
// Targets carry scroll-margin-top so they land below the sticky bars.
function _patternsOpenGuide(kind){
  try{
    if(typeof showTab==='function')showTab('guide');
    if(typeof openGuideSection==='function')openGuideSection('patterns');
    const go=()=>{
      const el=(kind&&document.getElementById('guide-pattern-'+kind))||document.getElementById('guide-pattern-section');
      if(!el)return;
      if(el.scrollIntoView)el.scrollIntoView({behavior:'auto',block:'start'});
      try{
        el.style.transition='background-color 0.4s';
        el.style.backgroundColor='rgba(124,106,247,0.28)';
        setTimeout(()=>{el.style.backgroundColor='';},1400);
        setTimeout(()=>{el.style.transition='';},1900);
      }catch{}
    };
    // after layout, so the section is open (and tab switched) when we measure
    if(typeof requestAnimationFrame==='function')requestAnimationFrame(go);else go();
  }catch(e){console.warn('patterns guide link',e);}
}
