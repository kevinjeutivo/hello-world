// PutSeller Pro -- dashboard.js
// Conviction dashboards: run scoring, render cards.
// Globals used: watchlist, currentMode, S, WORKER_URL
// Dependencies: helpers.js, scoring.js, storage.js

function compBarColor(v){return v>=2?'#00d4aa':v===1?'#4fc3f7':v===0?'#555870':'#ff4757';}

// 9 component definitions split into two rows: 4 on top, 5 on bottom.
// Labels sit below their respective bar, consistent with the existing convention.
const COMP_DEFS=[
  {key:'ivr',   label:'IVR'},
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
    return'<div style="background:'+bg+';border:1px solid '+bc+';border-left:4px solid '+bc+';border-radius:10px;padding:12px;margin-bottom:10px;cursor:pointer" onclick="selectTickerFromWatchlist(\''+r.ticker+'\')">'
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

async function runDashboards(skipOnlineCheck=false){
  if(!FINNHUB_KEY){toast('Add Finnhub key in Settings');return;}
  if(!skipOnlineCheck){
    if(!navigator.onLine&&!offlineMode){toast('Offline -- conviction data unchanged',3000);return;}
    if(offlineMode){toast('Offline mode -- disable in Settings to fetch live data',3000);return;}
  }
  const btn=document.getElementById('run-dashboard-btn');btn.disabled=true;
  document.getElementById('dashboard-progress').style.display='block';
  const targetAPY=parseFloat(document.getElementById('target-apy').value)||12;
  const putResults=[],ccResults=[];
  for(let i=0;i<watchlist.length;i++){
    const t=watchlist[i];
    document.getElementById('dash-progress-bar').style.width=Math.round((i/watchlist.length)*100)+'%';
    document.getElementById('dash-progress-label').textContent=`Scoring ${t} (${i+1}/${watchlist.length})...`;
    try{
      const[quote,metrics,earnings]=await Promise.all([fh(`/quote?symbol=${t}`),fh(`/stock/metric?symbol=${t}&metric=all`),fh(`/calendar/earnings?symbol=${t}&from=${fmtDate(new Date())}&to=${fmtDate(addDays(new Date(),180))}`)]);
      const price=quote.c,w52h=metrics.metric?.['52WeekHigh'],w52l=metrics.metric?.['52WeekLow'];
      const futureEarnings2=(earnings?.earningsCalendar||[]).filter(e=>e.date>=fmtDate(new Date())).sort((a,b)=>a.date.localeCompare(b.date));
      const earningsDate=futureEarnings2[0]?.date||null;const earningsHour=futureEarnings2[0]?.hour||null;
      let rsiVal=null,ma50=null,ma200=null,rangePos=null;
      try{const hist=await yahooHistory(t,'1y','1d');const closes=hist.closes.filter(c=>c!==null);const rsi=computeRSI(closes);rsiVal=rsi[rsi.length-1];ma50=avg(closes.slice(-50));ma200=avg(closes.slice(-200));if(w52h&&w52l&&w52h>w52l)rangePos=(price-w52l)/(w52h-w52l);}catch{}
      const ivrVal=computeIVR(t,w52h,w52l,price);const ivr=ivrInfo(ivrVal);
      const snap=S.get('snap_'+t)||{};
      let pRS=null,pExp=null,pApy=null,cRS=null,cExp=null,cApy=null;
      try{const today=new Date();const oc=S.get('options_'+t);const yr=oc?.data?.optionChain?.result?.[0];if(yr&&price){const expDates=(yr.expirationDates||[]).map(ts=>new Date(ts*1000).toISOString().split('T')[0]);for(const exp of expDates.slice(0,3)){const ec=S.get('options_exp_'+t+'_'+exp);const res=ec?.optionChain?.result?.[0];if(!res)continue;const expD=new Date(exp+'T12:00:00Z');const dte=Math.max(Math.round((expD-today)/86400000),1);if(dte<25||dte>100)continue;if(!pRS&&res.options?.[0]?.puts){const puts=res.options[0].puts.filter(p=>{const s=p.strike,bid=p.bid||0,last=p.lastPrice||0,prem=(bid>0?bid:last)*100,apy=prem/(s*100)*(365/dte)*100,pct=(price-s)/price*100;return s<price&&pct>=4&&pct<=18&&apy>=targetAPY*0.7&&(p.openInterest||0)>=50;});if(puts.length){const best=puts.reduce((b,p)=>{const apyA=((p.bid||0)>0?p.bid:p.lastPrice||0)*100/(p.strike*100)*(365/dte)*100;const apyB=((b.bid||0)>0?b.bid:b.lastPrice||0)*100/(b.strike*100)*(365/dte)*100;return Math.abs(apyA-targetAPY)<Math.abs(apyB-targetAPY)?p:b;});const prem=((best.bid||0)>0?best.bid:best.lastPrice||0)*100;pRS='$'+formatStrike(best.strike);pExp=exp;pApy=(prem/(best.strike*100)*(365/dte)*100).toFixed(1)+'%';}}if(!cRS&&res.options?.[0]?.calls){const calls=res.options[0].calls.filter(c=>{const s=c.strike,bid=c.bid||0,last=c.lastPrice||0,prem=(bid>0?bid:last)*100,apy=prem/(price*100)*(365/dte)*100,pct=(s-price)/price*100;return s>price&&pct>=4&&pct<=18&&apy>=targetAPY*0.7&&(c.openInterest||0)>=50;});if(calls.length){const best=calls.reduce((b,c)=>{const apyA=((c.bid||0)>0?c.bid:c.lastPrice||0)*100/(price*100)*(365/dte)*100;const apyB=((b.bid||0)>0?b.bid:b.lastPrice||0)*100/(price*100)*(365/dte)*100;return Math.abs(apyA-targetAPY)<Math.abs(apyB-targetAPY)?c:b;});const prem=((best.bid||0)>0?best.bid:best.lastPrice||0)*100;cRS='$'+formatStrike(best.strike);cExp=exp;cApy=(prem/(price*100)*(365/dte)*100).toFixed(1)+'%';}}if(pRS&&cRS)break;}}}catch{}
      const earningsTiming=earningsHour==='bmo'?' (before open)':earningsHour==='amc'?' (after close)':'';
      const earningsDisplay=earningsDate?earningsDate+earningsTiming:null;
      // OI gravity gap -- max put OI strike below price
      let oiGapPct=null;
      try{
        const optCache=S.get('options_'+t);
        const opts=optCache?.data?.optionChain?.result?.[0];
        if(opts&&price>0){
          const nearOpts=opts.options?.[0];
          if(nearOpts?.puts?.length){
            const maxOIPut=nearOpts.puts.reduce((best,p)=>(!best||(p.openInterest||0)>(best.openInterest||0))?p:best,null);
            if(maxOIPut?.strike)oiGapPct=(price-maxOIPut.strike)/price*100;
          }
        }
      }catch{}
      // OI gap for calls -- max call OI strike above price
      let callOiGapPct=null;
      try{
        const optCache2=S.get('options_'+t);
        const opts2=optCache2?.data?.optionChain?.result?.[0];
        if(opts2&&price>0){
          const nearOpts2=opts2.options?.[0];
          if(nearOpts2?.calls?.length){
            const maxOICall=nearOpts2.calls.filter(c=>c.strike>price).reduce((best,c)=>(!best||(c.openInterest||0)>(best.openInterest||0))?c:best,null);
            if(maxOICall?.strike)callOiGapPct=(maxOICall.strike-price)/price*100;
          }
        }
      }catch{}
      const ps=scorePuts({price,rsiVal,ma50,ma200,rangePos,earningsDate:earningsDisplay,recStrike:pRS,expiration:pExp,estApy:pApy,ivrVal,ptMean:snap.ptMean||null,beta:snap.beta||null,oiGapPct});
      const cs=scoreCalls({price,rsiVal,ma50,ma200,rangePos,earningsDate:earningsDisplay,recStrike:cRS,expiration:cExp,estApy:cApy,ivrVal,ptMean:snap.ptMean||null,beta:snap.beta||null,oiGapPct:callOiGapPct});
      const common={ticker:t,price,ivrBadge:ivr.badge,ivrVal,earningsDate:earningsDisplay};
      putResults.push({...common,...ps});ccResults.push({...common,...cs});
    }catch{const e={ticker:t,price:null,score:-99,signal:'error',factors:'Data unavailable',narrative:'',ivrBadge:'',earningsDate:null,recStrike:'--',expiration:'--',estApy:'--'};putResults.push({...e});ccResults.push({...e});}
    if(i<watchlist.length-1)await sleep(800);
  }
  document.getElementById('dash-progress-bar').style.width='100%';
  document.getElementById('dash-progress-label').textContent='Done!';
  setTimeout(()=>{document.getElementById('dashboard-progress').style.display='none';},1500);
  btn.disabled=false;
  putResults.sort((a,b)=>b.score-a.score);ccResults.sort((a,b)=>b.score-a.score);
  const validPuts=putResults.filter(r=>r.signal!=='error');
  const validCC=ccResults.filter(r=>r.signal!=='error');
  if(validPuts.length===0&&validCC.length===0){
    toast('Network error -- cached dashboards preserved',3500);
    const cp=S.get('conviction_puts'),cc=S.get('conviction_cc');
    if(cp)renderDashTable('put-dashboard-content',cp.results,cp.ts,false);
    if(cc)renderDashTable('cc-dashboard-content',cc.results,cc.ts,false);
    return;
  }
  const ts=nowPT();S.set('conviction_puts',{results:putResults,ts});S.set('conviction_cc',{results:ccResults,ts});
  renderDashTable('put-dashboard-content',putResults,ts,true);renderDashTable('cc-dashboard-content',ccResults,ts,true);
  document.getElementById('put-dash-ts').innerHTML=tsChip(ts,true);document.getElementById('cc-dash-ts').innerHTML=tsChip(ts,true);
  toast('Both dashboards updated',3000);
}
