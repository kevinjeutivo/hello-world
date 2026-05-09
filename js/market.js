// PutSeller Pro -- market.js
// Market tab: load and restore market data, T-bill yields, Fed funds futures.
// Globals used: WORKER_URL, S, offlineMode, tzPref
// Dependencies: helpers.js, api.js, storage.js

function fmtChg(val,chg,chgPct){
  if(!val)return'N/A';
  const color=chg>=0?'var(--green)':'var(--red)';
  const sign=chg>=0?'+':'';
  return`${val.toFixed(2)} <span style="color:${color};font-size:11px">${sign}${chg.toFixed(2)} (${sign}${chgPct?.toFixed(2)||'0.00'}%)</span>`;
}



// ─── Additional market helpers (moved from index.html) ───

async function loadMarketTab(){
  if(offlineMode){restoreMarketFromCache();return;}
  const el=document.getElementById('market-content');
  el.innerHTML='<div class="card"><div style="display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--text2)"><div class="spinner"></div>Loading market data...</div></div>';
  try{
    let sp500,nasdaq,treasury2y,isLive=true,mktTs=nowPT();
    let spLivePrice=null,nqLivePrice=null,spPrevClose=null,nqPrevClose=null;
    // Fetch each independently so one failure doesn't block the others
    try{sp500=await yahooHistory('^GSPC','3mo','1d');S.set('mkt_sp500',{timestamps:sp500.timestamps.map(d=>d.toISOString()),closes:sp500.closes,ts:mktTs});}
    catch{const cs=S.get('mkt_sp500');if(cs){sp500={timestamps:cs.timestamps.map(d=>new Date(typeof d==='number'?d*1000:d)),closes:cs.closes};isLive=false;mktTs=cs.ts;showOfflineBanner(cs.ts);}}
    try{nasdaq=await yahooHistory('^IXIC','3mo','1d');S.set('mkt_nasdaq',{timestamps:nasdaq.timestamps.map(d=>d.toISOString()),closes:nasdaq.closes,ts:mktTs});}
    catch{const cn=S.get('mkt_nasdaq');if(cn)nasdaq={timestamps:cn.timestamps.map(d=>new Date(typeof d==='number'?d*1000:d)),closes:cn.closes};}
    // 2-year Treasury: try ^USGG2YR first, fall back to ^TNX (10Y) scaled, then live quote
    try{
      treasury2y=await yahooHistory('^USGG2YR','3mo','1d');
      // Validate -- ^USGG2YR sometimes returns all-null closes
      const validCloses=treasury2y?.closes?.filter(c=>c!==null&&c>0)||[];
      if(!validCloses.length)throw new Error('No valid 2Y closes');
      S.set('mkt_2y',{timestamps:treasury2y.timestamps.map(d=>d.toISOString()),closes:treasury2y.closes,ts:mktTs});
    }catch{
      // Try live quote for 2Y yield as fallback
      try{
        const t2q=await fetch(`${WORKER_URL}/?ticker=${encodeURIComponent('^TNX')}&type=quote`).then(r=>r.json());
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
        fetch(`${WORKER_URL}/?ticker=${encodeURIComponent('^GSPC')}&type=quote`).then(r=>r.json()),
        fetch(`${WORKER_URL}/?ticker=${encodeURIComponent('^IXIC')}&type=quote`).then(r=>r.json())
      ]);
      spLivePrice=spQ?.quoteResponse?.result?.[0]?.regularMarketPrice||null;
      spPrevClose=spQ?.quoteResponse?.result?.[0]?.regularMarketPreviousClose||null;
      nqLivePrice=nqQ?.quoteResponse?.result?.[0]?.regularMarketPrice||null;
      nqPrevClose=nqQ?.quoteResponse?.result?.[0]?.regularMarketPreviousClose||null;
      if(spLivePrice)S.set('mkt_sp_live',{price:spLivePrice,prevClose:spPrevClose,ts:mktTs});
      if(nqLivePrice)S.set('mkt_nq_live',{price:nqLivePrice,prevClose:nqPrevClose,ts:mktTs});
    }catch{}
    if(!spLivePrice){const c=S.get('mkt_sp_live');if(c){spLivePrice=c.price;spPrevClose=c.prevClose;}}
    if(!nqLivePrice){const c=S.get('mkt_nq_live');if(c){nqLivePrice=c.price;nqPrevClose=c.prevClose;}}
    // Fetch CME Fed Funds futures for rate probability display
    let fedFutures=null;
    try{fedFutures=await fetchFedFundsFutures();if(fedFutures)S.set('fed_futures',{data:fedFutures,ts:mktTs});}
    catch{}
    if(!fedFutures){const cf=S.get('fed_futures');if(cf)fedFutures=cf.data;}
    // T-bill yields from US Treasury FiscalData API (via Worker, no key needed)
    let tbill3m=[],tbill6m=[],fredTs=nowPT();
    try{
      const tbills=await fetchTBills();
      tbill3m=tbills.tbill3m;tbill6m=tbills.tbill6m;
      fredTs=nowPT();
      S.set('tbills_cache',{tbill3m,tbill6m,ts:fredTs});
    }catch{
      const cd=S.get('tbills_cache');
      if(cd){tbill3m=cd.tbill3m||[];tbill6m=cd.tbill6m||[];fredTs=cd.ts||'';}
    }

    const tb3Current=tbill3m.length?tbill3m[tbill3m.length-1].value:null;
    const tb6Current=tbill6m.length?tbill6m[tbill6m.length-1].value:null;
    const tb3Yr=tbill3m.length>=252?tbill3m[tbill3m.length-252].value:tbill3m[0]?.value;
    const tb6Yr=tbill6m.length>=252?tbill6m[tbill6m.length-252].value:tbill6m[0]?.value;
    const spread=tb3Current&&tb6Current?tb6Current-tb3Current:null;
    const spreadStr=spread!==null?(spread>=0?`6M yields ${spread.toFixed(2)}bp above 3M (normal)`:`3M yields ${Math.abs(spread).toFixed(2)}bp above 6M (inverted -- market expects rate cuts)`):'';

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


    // 1Y T-bill chart data
    // tbill3m and tbill6m arrays contain ~52 weekly auctions each

    let marketNews=[];try{const news=await fh('/news?category=general');marketNews=news.slice(0,10);S.set('market_news',{items:(marketNews||[]).slice(0,15).map(n=>({headline:n.headline,summary:n.summary?n.summary.slice(0,200):null,url:n.url,source:n.source,datetime:n.datetime})),ts:nowPT()});}catch{const cn=S.get('market_news');if(cn)marketNews=cn.items||[];}

    const spLabels=sp500?.timestamps?.slice(-63).map(d=>{if(!(d instanceof Date))d=new Date(d);return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});})||[];
    const spData=sp500?.closes?.slice(-63)||[];

    el.innerHTML=`
      ${tsChip(mktTs,isLive)}
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
        const outlook=totalBps<=-50?'Markets pricing 2+ cuts':'Markets pricing 1-2 cuts over this window';
        const outlookMild=totalBps<=-25&&totalBps>-50?'Markets pricing ~1 cut':'';
        const outlookFlat=Math.abs(totalBps)<25?'Markets pricing no change':'';
        const outlookHike=totalBps>=25?'Markets pricing rate hike':'';
        const summary=outlookFlat||outlookMild||(totalBps<=-50?'Markets pricing 2+ cuts':'Markets pricing 1-2 cuts');
        return '<div class="card"><div class="card-title"><span class="dot" style="background:var(--accent2)"></span>Fed Funds Futures (CME Implied Rates)</div>'
          +'<div style="font-family:var(--mono);font-size:11px;color:var(--text3);margin-bottom:8px">30-day futures price → implied rate (100 − price). Delta vs near-month contract.</div>'
          +'<div class="options-table-wrap"><table class="options-table">'
          +'<thead><tr><th style="text-align:left">Month</th><th>Price</th><th>Implied Rate</th><th>Δ vs Now</th></tr></thead>'
          +'<tbody>'+rows+'</tbody></table></div>'
          +'<div style="font-family:var(--mono);font-size:11px;color:var(--accent);margin-top:8px">'+summary+' (next '+fedFutures.length+' months, '+Math.abs(totalBps)+'bp total)</div>'
          +'</div>';
      })()}
      <div class="card">
        <div class="card-title"><span class="dot" style="background:#64b5f6"></span>T-Bill Yields (^IRX / ^FVX)</div>
        ${tsChip(fredTs,isLive)}
        <div class="metrics-grid">
          <div class="metric-tile"><div class="metric-label">3-Month T-Bill (^IRX)</div><div class="metric-value" style="color:#64b5f6">${tb3Current?tb3Current.toFixed(3)+'%':'N/A'}</div><div class="metric-sub">${tb3Yr?`1Y ago: ${tb3Yr.toFixed(3)}% (${(tb3Current-tb3Yr)>=0?'+':''}${(tb3Current-tb3Yr).toFixed(3)}%)`:''}</div></div>
          <div class="metric-tile"><div class="metric-label">5-Year Treasury (^FVX)</div><div class="metric-value" style="color:#64b5f6">${tb6Current?tb6Current.toFixed(3)+'%':'N/A'}</div><div class="metric-sub">${tb6Yr?`1Y ago: ${tb6Yr.toFixed(3)}% (${(tb6Current-tb6Yr)>=0?'+':''}${(tb6Current-tb6Yr).toFixed(3)}%)`:''}</div></div>
          ${spread!==null?`<div class="metric-tile" style="grid-column:span 2"><div class="metric-label">3M / 6M Spread</div><div class="metric-value" style="font-size:13px">${Math.abs(spread).toFixed(2)}bp ${spread>=0?'(6M > 3M)':'(3M > 6M -- inverted)'}</div><div class="metric-sub">${spreadStr}</div></div>`:''}
        </div>
        ${tbill3m&&tbill3m.length?`<div class="chart-wrap" style="height:160px"><canvas id="tbill-chart"></canvas></div><div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:4px">52-week history of 3-month (blue) and 6-month (orange) T-bill auction rates. Source: Yahoo Finance (^IRX, ^FVX) via Cloudflare Worker. When lines converge or cross (inversion), market is pricing in Federal Reserve rate cuts ahead.</div>`:''}
      </div>
      <!-- Market indices -->
      <div class="metrics-grid">
        <div class="metric-tile" style="grid-column:span 2"><div class="metric-label">S&P 500</div><div class="metric-value" style="font-size:15px">${fmtChg(spCurrent,spChg,spChgPct)}</div></div>
        <div class="metric-tile" style="grid-column:span 2"><div class="metric-label">Nasdaq Composite</div><div class="metric-value" style="font-size:15px">${fmtChg(nqCurrent,nqChg,nqChgPct)}</div></div>
        ${vixCurrent?`<div class="metric-tile" style="grid-column:span 2;background:${vixCurrent>=30?'rgba(255,71,87,0.1)':vixCurrent>=20?'rgba(255,165,2,0.1)':'var(--surface2)'}"><div class="metric-label">VIX (from cache)</div><div class="metric-value" style="color:${vixCurrent>=30?'var(--red)':vixCurrent>=20?'var(--warn)':'var(--text)'}">${vixCurrent.toFixed(2)}</div><div class="metric-sub">${vixCurrent>=30?'FEAR SPIKE -- exceptional premium':vixCurrent>=20?'ELEVATED -- favorable for selling':'Normal conditions'}</div></div>`:''}
      </div>
      ${spLabels.length?`<div class="card"><div class="card-title"><span class="dot" style="background:#4fc3f7"></span>S&P 500 (3 months)</div><div class="chart-wrap" style="height:180px"><canvas id="sp500-chart"></canvas></div></div>`:''}
      <div class="card"><div class="card-title"><span class="dot" style="background:var(--accent2)"></span>Top Market News</div><div>${renderNewsItems(marketNews,10)}</div></div>`;

    // Render S&P 500 chart
    setTimeout(()=>{
      const ctx=document.getElementById('sp500-chart')?.getContext('2d');
      if(ctx&&spLabels.length){new Chart(ctx,{type:'line',data:{labels:spLabels,datasets:[{data:spData,borderColor:'#4fc3f7',borderWidth:1.5,pointRadius:0,tension:0.2,fill:false}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#555870',font:{size:9},maxTicksLimit:6},grid:{color:'#2a2e38'}},y:{ticks:{color:'#555870',font:{size:9}},grid:{color:'#2a2e38'}}}}});}
      // T-bill chart -- Treasury auction data, weekly frequency
      const tbCtx=document.getElementById('tbill-chart')?.getContext('2d');
      if(tbCtx&&tbill3m.length){
        // Use last 52 weekly auctions (~1 year) for chart
        const last52_3m=tbill3m.slice(-52);
        const last52_6m=tbill6m.slice(-52);
        // Build unified label set from 3M dates (auctions every week)
        const chartLabels=last52_3m.map(d=>d.date.slice(5)); // MM-DD
        // Align 6M data to same date range (6M auctions are also weekly)
        const len52=last52_3m.length;
        const aligned6m=last52_6m.slice(-len52).map(d=>d.value);
        new Chart(tbCtx,{type:'line',data:{labels:chartLabels,datasets:[
          {label:'3-Month T-bill',data:last52_3m.map(d=>d.value),borderColor:'#64b5f6',borderWidth:1.5,pointRadius:0,tension:0.3,fill:false},
          {label:'6-Month T-bill',data:aligned6m,borderColor:'#ff9800',borderWidth:1.5,pointRadius:0,tension:0.3,fill:false}
        ]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#8b8fa8',font:{size:9}}}},scales:{x:{ticks:{color:'#555870',font:{size:9},maxTicksLimit:8},grid:{color:'#2a2e38'}},y:{ticks:{color:'#555870',font:{size:9},callback:v=>v.toFixed(2)+'%'},grid:{color:'#2a2e38'}}}}});
      }
    },100);

    S.set('market_ts',{ts:nowPT()});
  }catch(err){console.warn('Market load error:',err);restoreMarketFromCache();}
}

function restoreMarketFromCache(){
  // For market tab, just trigger a fresh load attempt -- cached data will be used if offline
  loadMarketTab();
}
