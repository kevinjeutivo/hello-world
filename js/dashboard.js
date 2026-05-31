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

      // 52W range -- from snap, fallback to hist1y
      let w52h=snap.week52High||null,w52l=snap.week52Low||null;
      let rsiVal=null,ma50=null,ma200=null,rangePos=null;
      const ch1=S.get('hist1y_'+t);
      if(ch1?.closes?.length){
        const closes=ch1.closes.filter(c=>c!=null&&c>0);
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
  const ts=nowPT();S.set('conviction_puts',{results:putResults,ts});S.set('conviction_cc',{results:ccResults,ts});
  renderDashTable('put-dashboard-content',putResults,ts,true);renderDashTable('cc-dashboard-content',ccResults,ts,true);
  document.getElementById('put-dash-ts').innerHTML=tsChip(ts,true);document.getElementById('cc-dash-ts').innerHTML=tsChip(ts,true);
  toast('Both dashboards updated',3000);
}
