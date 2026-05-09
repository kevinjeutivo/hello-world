// PutSeller Pro -- helpers.js
// Utility functions: date/time, math, formatting, display helpers.
// Globals used: tzPref, S, watchlist, WORKER_URL, vixThreshold
// Dependencies: storage.js (S)

function applyFontSize(size){
  const px=size+'px';
  // Set the CSS variable so any var(--base-font) references stay in sync.
  document.documentElement.style.setProperty('--base-font',px);
  // iOS Safari does not reliably re-cascade a CSS variable change into the
  // computed font-size of the <html> element itself.  Setting fontSize
  // directly on documentElement is the only approach that works consistently
  // across all WebKit versions, including Safari on iPhone 13 mini.
  document.documentElement.style.fontSize=px;
}

function nowInTZ(){
  const opts={timeZone:tzPref==='PT'?'America/Los_Angeles':tzPref==='UTC'?'UTC':Intl.DateTimeFormat().resolvedOptions().timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false};
  const s=new Date().toLocaleString('en-US',opts);
  const tzLabel=tzPref==='PT'?'PT':tzPref==='UTC'?'UTC':'local';
  return s+' '+tzLabel;
}

function nowPT(){return nowInTZ();}

function daysUntilDate(dateStr){
  if(!dateStr)return null;
  try{
    const tz=tzPref==='PT'?'America/Los_Angeles':tzPref==='UTC'?'UTC':Intl.DateTimeFormat().resolvedOptions().timeZone;
    const fmt=new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'});
    const todayParts=fmt.formatToParts(new Date());
    const ty=todayParts.find(p=>p.type==='year').value;
    const tm=todayParts.find(p=>p.type==='month').value;
    const td=todayParts.find(p=>p.type==='day').value;
    const todayStr=ty+'-'+tm+'-'+td;
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

function relAge(tsStr){
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

function tsChip(ts,isLive){
  const cls=isLive?'live':'stale';
  const age=relAge(ts);
  const ageStr=age?` (${age})`:'';
  const isoTs=new Date().toISOString();
  return `<div class="ts-chip ${cls}" data-ts-iso="${isoTs}" data-ts-display="${ts||''}">${isLive?'live':'cached'} ${ts||'unknown'}${ageStr}</div>`;
}

function fmtTS(ts){
  if(!ts)return'unknown';
  const age=relAge(ts);
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

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

function avg(arr){const v=arr.filter(x=>x!==null&&!isNaN(x));return v.length?v.reduce((a,b)=>a+b,0)/v.length:null;}

function stdDev(arr){const a=avg(arr);if(a===null)return null;const v=arr.filter(x=>x!==null&&!isNaN(x));return Math.sqrt(v.reduce((s,x)=>s+(x-a)**2,0)/v.length);}

function computeRSI(closes,period=14){const result=[];for(let i=0;i<closes.length;i++){if(i<period){result.push(null);continue;}const sl=closes.slice(i-period,i+1);let g=0,l=0;for(let j=1;j<sl.length;j++){const d=sl[j]-sl[j-1];if(d>0)g+=d;else l-=d;}const ag=g/period,al=l/period;if(al===0){result.push(100);continue;}result.push(100-100/(1+ag/al));}return result.filter(v=>v!==null);}

function formatStrike(x){return x===Math.floor(x)?x.toString():x.toFixed(2);}

function fmtCap(v){if(!v)return'N/A';if(v>=1e12)return`$${(v/1e12).toFixed(2)}T`;if(v>=1e9)return`$${(v/1e9).toFixed(2)}B`;if(v>=1e6)return`$${(v/1e6).toFixed(2)}M`;return`$${v}`;}

function computeVolumeProfile(closes,volumes,nBuckets=40,topN=5){const pairs=closes.map((c,i)=>[c,volumes[i]]).filter(([c,v])=>c&&v);if(!pairs.length)return{levels:[],centers:[],vols:[]};const allC=pairs.map(p=>p[0]);const mn=Math.min(...allC),mx=Math.max(...allC);const edges=Array.from({length:nBuckets+1},(_,i)=>mn+(mx-mn)*i/nBuckets);const centers=edges.slice(0,-1).map((e,i)=>(e+edges[i+1])/2);const bvols=new Array(nBuckets).fill(0);pairs.forEach(([price,vol])=>{let idx=edges.slice(1).findIndex(e=>price<=e);if(idx<0)idx=nBuckets-1;bvols[idx]+=vol;});const topIdxs=[...bvols.entries()].sort((a,b)=>b[1]-a[1]).slice(0,topN).map(e=>e[0]);return{levels:topIdxs.map(i=>centers[i]).sort((a,b)=>a-b),centers,vols:bvols};}

function getRoundNumbers(price,w=0.25){const low=price*(1-w),high=price*(1+w);const step=price>=500?50:price>=100?25:price>=50?10:5;const rounds=[];let v=Math.floor(low/step)*step;while(v<=high){if(v>=low&&v<=high)rounds.push(v);v+=step;}return rounds;}

function computeIVR(ticker,w52h,w52l,price){try{const cached=S.get('options_'+ticker);const res=cached?.data?.optionChain?.result?.[0];if(!res)return null;const opts=res.options?.[0];if(!opts)return null;const atm=[...(opts.puts||[]),...(opts.calls||[])].filter(o=>Math.abs(o.strike-price)/price<0.05&&o.impliedVolatility>0);if(!atm.length)return null;const currentIV=avg(atm.map(o=>o.impliedVolatility));if(!w52h||!w52l||w52h<=w52l)return null;const rangeVol=(w52h-w52l)/w52l;return Math.min(100,Math.max(0,(currentIV/(rangeVol*0.6))*50));}catch{return null;}}

function ivrInfo(val){if(val===null)return{badge:'',guidance:'IV rank not available -- fetch options data to compute.'};if(val<30)return{badge:`<span class="ivr-badge ivr-low">Low IV (${val.toFixed(0)})</span>`,guidance:`IVR ${val.toFixed(0)}: Options historically cheap. Premiums thin -- consider waiting for a volatility uptick.`};if(val<60)return{badge:`<span class="ivr-badge ivr-normal">Normal IV (${val.toFixed(0)})</span>`,guidance:`IVR ${val.toFixed(0)}: Normal historical IV. Standard conditions for premium collection.`};if(val<80)return{badge:`<span class="ivr-badge ivr-elevated">Elevated IV (${val.toFixed(0)})</span>`,guidance:`IVR ${val.toFixed(0)}: IV elevated -- above-average premium opportunity. Good time to sell options.`};return{badge:`<span class="ivr-badge ivr-high">High IV (${val.toFixed(0)})</span>`,guidance:`IVR ${val.toFixed(0)}: IV very high. Exceptional premiums -- driven by recent volatility or upcoming event.`};}

const POS_WORDS=['beat','beats','surge','surges','upgrade','upgrades','raises','record','strong','soar','gain','rally','top'];
const NEG_WORDS=['miss','misses','cut','cuts','downgrade','downgrades','warning','weak','fall','drop','investigation','recall','decline','loss'];

function newsSentiment(h){const l=h.toLowerCase();if(POS_WORDS.some(w=>l.includes(w)))return{dot:'pos',css:'color:var(--green)'};if(NEG_WORDS.some(w=>l.includes(w)))return{dot:'neg',css:'color:var(--red)'};return{dot:'neu',css:'color:var(--text3)'};}

function sentDot(s){return s.dot==='pos'?'&#x1F7E2;':s.dot==='neg'?'&#x1F534;':'&#x26AA;';}

function renderNewsItems(newsArr,maxItems=5){if(!newsArr||!newsArr.length)return'<div style="font-family:var(--mono);font-size:11px;color:var(--text3);padding:8px 0">No recent news available</div>';const items=newsArr.slice(0,maxItems);const pos=items.filter(n=>newsSentiment(n.headline).dot==='pos').length;const neg=items.filter(n=>newsSentiment(n.headline).dot==='neg').length;return`<div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:8px">${items.length} articles -- ${pos} positive, ${neg} negative</div>`+items.map(n=>{const s=newsSentiment(n.headline);return`<div class="news-item"><div class="news-headline"><span style="${s.css}">${sentDot(s)}</span> <a href="${n.url}" target="_blank" rel="noopener">${n.headline}</a></div><div class="news-meta">${n.source} -- ${relTime(n.datetime)}</div>${n.summary?`<div class="news-summary">${n.summary.slice(0,120)}...</div>`:''}</div>`;}).join('');}
