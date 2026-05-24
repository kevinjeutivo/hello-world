// PutSeller Pro -- etf.js
// ETF tab: load, render charts, toggle span.
// Globals used: WORKER_URL, S
// Dependencies: helpers.js, storage.js

function renderEtfChart(ticker,color,labels,data,totalReturn){
  const ctx=document.getElementById('etf-chart-'+ticker)?.getContext('2d');
  if(!ctx||!labels||!labels.length)return;
  if(window._etfCharts&&window._etfCharts[ticker]){window._etfCharts[ticker].destroy();}
  if(!window._etfCharts)window._etfCharts={};
  const datasets=[{label:'Price',data,borderColor:color,borderWidth:1.5,pointRadius:0,tension:0.2,fill:false}];
  if(totalReturn&&totalReturn.length){
    datasets.push({label:'Total Return',data:totalReturn,borderColor:'#ffd32a',borderWidth:1.5,pointRadius:0,tension:0.2,fill:false,borderDash:[4,3]});
  }
  window._etfCharts[ticker]=new Chart(ctx,{type:'line',data:{labels,datasets},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:datasets.length>1,labels:{color:'#8b8fa8',font:{size:9},boxWidth:20}}},scales:{x:{ticks:{color:'#555870',font:{size:9},maxTicksLimit:6},grid:{color:'#2a2e38'}},y:{ticks:{color:'#555870',font:{size:9}},grid:{color:'#2a2e38'}}}}});
}

function toggleEtfSpan(ticker,span){
  const btn6=document.getElementById('etf-btn-6m-'+ticker);
  const btn1=document.getElementById('etf-btn-1y-'+ticker);
  if(btn6)btn6.style.opacity=span==='6m'?'1':'0.4';
  if(btn1)btn1.style.opacity=span==='1y'?'1':'0.4';
  // Use in-memory data if available (post live-fetch), otherwise fall back to localStorage
  const mem=window._etfChartData&&window._etfChartData[ticker];
  const cached=S.get('etf_tr_'+ticker);
  // Determine ETF color from in-memory or a reasonable default per ticker
  const etfColors={'SPYI':'#00d4aa','NBOS':'#7c6af7'};
  const color=(mem&&mem.color)||etfColors[ticker]||'#4fc3f7';
  if(span==='6m'){
    const labels=mem?.labels6m||cached?.chartLabels6m||[];
    const data=mem?.data6m||cached?.chartData6m||[];
    const tr=mem?.tr6m||cached?.totalReturn||[];
    if(!labels.length){toast('6M ETF data not available',2000);return;}
    renderEtfChart(ticker,color,labels,data,tr);
    updateEtfReturnTiles(ticker,mem?.priceRetPct6m||cached?.priceRetPct,mem?.totalRetPct6m||cached?.totalRetPct,'6M');
  }else{
    const labels=mem?.labels1y||cached?.labels1y||[];
    const data=mem?.data1y||cached?.data1y||[];
    const tr=mem?.tr1y||cached?.tr1y||[];
    if(!labels.length){toast('1Y ETF data not cached -- tap Refresh ETF Data first',3000);return;}
    renderEtfChart(ticker,color,labels,data,tr);
    updateEtfReturnTiles(ticker,mem?.priceRetPct1y||cached?.priceRetPct1y,mem?.totalRetPct1y||cached?.totalRetPct1y,'1Y');
  }
}

function updateEtfReturnTiles(ticker,priceRetPct,totalRetPct,span){
  const prEl=document.getElementById('etf-price-ret-'+ticker);
  const trEl=document.getElementById('etf-total-ret-'+ticker);
  if(prEl&&priceRetPct!=null){
    prEl.innerHTML='<div class="metric-label">Price Return ('+span+')</div>'
      +'<div class="metric-value" style="color:'+(priceRetPct>=0?'var(--green)':'var(--red)')+'">'+(priceRetPct>=0?'+':'')+priceRetPct.toFixed(1)+'%</div>'
      +'<div class="metric-sub">NAV change only</div>';
  }
  if(trEl&&totalRetPct!=null){
    trEl.innerHTML='<div class="metric-label">Total Return ('+span+')</div>'
      +'<div class="metric-value" style="color:'+(totalRetPct>=0?'var(--green)':'var(--red)')+'">'+(totalRetPct>=0?'+':'')+totalRetPct.toFixed(1)+'%</div>'
      +'<div class="metric-sub">Price + distributions. Spread = yield collected.</div>';
  }
}

async function loadETFTab(){
  if(!navigator.onLine&&!offlineMode){toast('Offline -- showing cached ETF data',2500);restoreETFFromCache();return;}
  if(offlineMode){restoreETFFromCache();return;}
  const el=document.getElementById('etf-content');
  el.innerHTML='<div class="card"><div style="display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--text2)"><div class="spinner"></div>Loading ETF data...</div></div>';
  const etfChartQueue=[];
  const etfs=[
    {ticker:'SPYI',name:'NEOS S&P 500 High Income ETF',strategy:'Covered calls on S&P 500 components. Targets high monthly income while maintaining equity-like upside participation. Monthly distributions.',color:'#00d4aa'},
    {ticker:'NBOS',name:'Roundhill N-Buffer Outcome Strategy',strategy:'Put-writing strategy providing monthly income with defined downside buffers on the S&P 500. Monthly distributions.',color:'#ff6b35'}
  ];
  let html='';
  for(const etf of etfs){
    try{
      let snap,hist6mo,distributions=[],trailingYield=null,isLive=true;
      const snapKey='snap_etf_'+etf.ticker;const histKey='hist_etf_'+etf.ticker;const divKey='div_etf_'+etf.ticker;
      try{
        const[quote,metrics]=await Promise.all([fh(`/quote?symbol=${etf.ticker}`),fh(`/stock/metric?symbol=${etf.ticker}&metric=all`)]);
        snap={ticker:etf.ticker,price:quote.c,change:quote.c-quote.pc,changePct:((quote.c-quote.pc)/quote.pc*100),week52High:metrics.metric?.['52WeekHigh']||null,week52Low:metrics.metric?.['52WeekLow']||null,dividendYield:metrics.metric?.dividendYieldIndicatedAnnual||null,ts:nowPT()};
        S.set(snapKey,snap);
      }catch{const c=S.get(snapKey);if(c){snap=c;isLive=false;showOfflineBanner(c.ts);}else snap=null;}
      try{hist6mo=await yahooHistory(etf.ticker,'1y','1d');S.set(histKey,{timestamps:hist6mo.timestamps.map(d=>d.toISOString()),closes:hist6mo.closes,ts:nowPT()});}
      catch{const ch=S.get(histKey);if(ch)hist6mo={timestamps:ch.timestamps.map(d=>new Date(d)),closes:ch.closes};}
      try{
        // Fetch ETF distribution history from Yahoo Finance via Worker
        // Yahoo returns dividend events in chart response events.dividends field
        const divResponse=await fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(etf.ticker)}&type=dividends&range=3y`);
        if(divResponse.ok){
          const divData=await divResponse.json();
          const events=divData.chart?.result?.[0]?.events?.dividends;
          if(events){
            // events is an object keyed by unix timestamp
            const divList=Object.values(events)
              .sort((a,b)=>b.date-a.date)
              .slice(0,24)
              .map(d=>({
                date:new Date(d.date*1000).toISOString().split('T')[0],
                amount:d.amount
              }));
            distributions=divList;
            S.set(divKey,{distributions,ts:nowPT()});
            // Trailing 12-month yield: sum last 12 distributions / current price
            const last12=divList.slice(0,12);
            const total=last12.reduce((s,d)=>s+(d.amount||0),0);
            if(snap?.price&&total>0)trailingYield=(total/snap.price*100).toFixed(2);
          }
        }
        if(!distributions.length)throw new Error('no div data');
      }catch{const cd=S.get(divKey);if(cd){distributions=cd.distributions||[];const total=distributions.slice(0,12).reduce((s,d)=>s+(d.amount||0),0);if(snap?.price&&total>0)trailingYield=(total/snap.price*100).toFixed(2);}}
      const chartLabels=hist6mo?hist6mo.timestamps.slice(-126).map(d=>{if(!(d instanceof Date))d=new Date(d);return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});}):[];
      const chartData=hist6mo?hist6mo.closes.slice(-126):[];
      // Compute total return series: price + cumulative distributions reinvested
      // Map distribution dates to cumulative sum, then add to price on each date
      let totalReturnData=[];
      if(hist6mo&&hist6mo.timestamps&&distributions.length){
        let cumDist=0;
        const distByDate={};
        distributions.forEach(d=>{if(d.date&&d.amount)distByDate[d.date]=(distByDate[d.date]||0)+d.amount;});
        totalReturnData=hist6mo.timestamps.slice(-126).map((ts,i)=>{
          if(!(ts instanceof Date))ts=new Date(ts);
          const dateStr=ts.toISOString().split('T')[0];
          if(distByDate[dateStr])cumDist+=distByDate[dateStr];
          const price=chartData[i];
          return price!=null?price+cumDist:null;
        });
      }
      // Compute price return % and total return % over chart period
      const firstPrice=chartData.find(p=>p!=null);
      const lastPrice=[...chartData].reverse().find(p=>p!=null);
      const priceRetPct=firstPrice&&lastPrice?((lastPrice-firstPrice)/firstPrice*100):null;
      const firstTR=totalReturnData.find(p=>p!=null);
      const lastTR=totalReturnData.length?[...totalReturnData].reverse().find(p=>p!=null):null;
      const totalRetPct=firstTR&&lastTR?((lastTR-firstTR)/firstTR*100):null;
      const chgColor=snap?(snap.change>=0?'var(--green)':'var(--red)'):'var(--text2)';
      const chgSign=snap?(snap.change>=0?'+':''):'';
      html+=`<div class="card" style="border-left:4px solid ${etf.color}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
          <div><div style="font-family:var(--sans);font-size:20px;font-weight:700;color:${etf.color}">${etf.ticker}</div><div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:2px">${etf.name}</div></div>
          <div style="text-align:right">${snap?`<div style="font-family:var(--mono);font-size:18px;font-weight:500">$${snap.price.toFixed(2)}</div><div style="font-family:var(--mono);font-size:11px;color:${chgColor}">${chgSign}${snap.change?.toFixed(2)} (${chgSign}${snap.changePct?.toFixed(2)}%)</div>`:'<div style="font-family:var(--mono);color:var(--text3)">No data</div>'}</div>
        </div>
        ${tsChip(snap?.ts||'',isLive)}
        <div class="metrics-grid" style="margin-bottom:10px">
          <div class="metric-tile" style="grid-column:span 2"><div class="metric-label">Trailing 12-Month Distribution Yield</div><div class="metric-value" style="color:${etf.color};font-size:20px">${trailingYield?trailingYield+'%':'N/A'}</div><div class="metric-sub">${trailingYield?`Sum of last ${Math.min(12,distributions.length)} distributions / current price. Compare to your T-bill yield for risk premium context.`:'Fetch live data to compute distribution yield.'}</div></div>
          <div class="metric-tile" id="etf-price-ret-${etf.ticker}">${priceRetPct!=null?`<div class="metric-label">Price Return (6M)</div><div class="metric-value" style="color:${priceRetPct>=0?'var(--green)':'var(--red)'}">${priceRetPct>=0?'+':''}${priceRetPct.toFixed(1)}%</div><div class="metric-sub">NAV change only</div>`:''}</div>
          <div class="metric-tile" id="etf-total-ret-${etf.ticker}">${totalRetPct!=null?`<div class="metric-label">Total Return (6M)</div><div class="metric-value" style="color:${totalRetPct>=0?'var(--green)':'var(--red)'}">${totalRetPct>=0?'+':''}${totalRetPct.toFixed(1)}%</div><div class="metric-sub">Price + distributions. Spread = yield collected.</div>`:''}</div>
          <div class="metric-tile"><div class="metric-label">Annualized Yield (indicated)</div><div class="metric-value" style="font-size:13px">${snap?.dividendYield?snap.dividendYield.toFixed(2)+'%':'N/A'}</div></div>
          <div class="metric-tile"><div class="metric-label">52W High / Low</div><div class="metric-value" style="font-size:11px">$${snap?.week52High?.toFixed(2)||'N/A'} / $${snap?.week52Low?.toFixed(2)||'N/A'}</div></div>
        </div>
        <div class="commentary" style="margin-bottom:10px;font-size:11px">${etf.strategy}</div>
        ${fundDesc?`<div class="commentary" style="margin-bottom:10px;font-size:11px">${fundDesc.length>300?fundDesc.slice(0,300)+'…':fundDesc}</div>`:''}
    ${distributions.length?`<div style="margin-bottom:10px"><div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:6px">Recent Distributions</div>${distributions.slice(0,6).map(d=>`<div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:11px;padding:4px 0;border-bottom:1px solid var(--border)"><span style="color:var(--text2)">${d.date}</span><span style="color:${etf.color}">$${d.amount?.toFixed(4)||'N/A'}</span></div>`).join('')}</div>`:'<div style="font-family:var(--mono);font-size:11px;color:var(--text3);margin-bottom:10px">Distribution history not available from data provider. Check fund website for latest distributions.</div>'}
        ${chartLabels.length?`<div class="card-title" style="margin-bottom:6px"><span class="dot" style="background:${etf.color}"></span>6-Month Price</div><div style="display:flex;gap:6px;margin-bottom:4px">
          <button class="btn btn-secondary" style="font-size:10px;padding:2px 8px" onclick="toggleEtfSpan('${etf.ticker}','6m')" id="etf-btn-6m-${etf.ticker}">6M</button>
          <button class="btn btn-secondary" style="font-size:10px;padding:2px 8px;opacity:0.4" onclick="toggleEtfSpan('${etf.ticker}','1y')" id="etf-btn-1y-${etf.ticker}">1Y</button>
        </div>
        <div class="chart-wrap" style="height:140px"><canvas id="etf-chart-${etf.ticker}"></canvas></div>`:''}
      </div>`;
      // Store chart data for rendering after all HTML is injected
      // Also compute 1Y series for the toggle
      const labels1y=hist6mo?hist6mo.timestamps.map(d=>{if(!(d instanceof Date))d=new Date(d);return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});}):[];
      const data1y=hist6mo?hist6mo.closes:[];
      // Total return for 1Y
      let totalReturn1y=[];
      if(hist6mo&&hist6mo.timestamps&&distributions.length){
        let cumDist1y=0;
        const distByDate1y={};
        distributions.forEach(d=>{if(d.date&&d.amount)distByDate1y[d.date]=(distByDate1y[d.date]||0)+d.amount;});
        totalReturn1y=hist6mo.timestamps.map((ts,i)=>{
          if(!(ts instanceof Date))ts=new Date(ts);
          const dateStr=ts.toISOString().split('T')[0];
          if(distByDate1y[dateStr])cumDist1y+=distByDate1y[dateStr];
          const price=data1y[i];
          return price!=null?price+cumDist1y:null;
        });
      }
      const first1y=data1y.find(p=>p!=null);const last1y=[...data1y].reverse().find(p=>p!=null);
      const priceRetPct1y=first1y&&last1y?((last1y-first1y)/first1y*100):null;
      const firstTR1y=totalReturn1y.find(p=>p!=null);const lastTR1y=totalReturn1y.length?[...totalReturn1y].reverse().find(p=>p!=null):null;
      const totalRetPct1y=firstTR1y&&lastTR1y?((lastTR1y-firstTR1y)/firstTR1y*100):null;
      // Cache total return series and return metrics for offline restore
      S.set('etf_tr_'+etf.ticker,{
        totalReturn:totalReturnData,
        priceRetPct,totalRetPct,
        chartLabels6m:chartLabels,
        chartData6m:chartData,
        labels1y,data1y,tr1y:totalReturn1y,
        priceRetPct1y,totalRetPct1y,
        ts:nowPT()
      });
      etfChartQueue.push({ticker:etf.ticker,color:etf.color,labels:chartLabels,data:chartData,totalReturn:totalReturnData,priceRetPct,totalRetPct,labels1y,data1y,tr1y:totalReturn1y,priceRetPct1y,totalRetPct1y});
    }catch(err){html+=`<div class="card"><div style="font-family:var(--mono);font-size:12px;color:var(--red)">${etf.ticker}: ${err.message}</div></div>`;}
  }
  el.innerHTML=html;
  S.set('etf_rendered',{html,ts:nowPT()});
  // Render all ETF charts after HTML is in DOM -- use requestAnimationFrame to ensure paint
  window._etfChartData=window._etfChartData||{};


  function renderNextEtfChart(queue,idx){
    if(idx>=queue.length)return;
    const{ticker,color,labels,data,totalReturn,priceRetPct,totalRetPct,labels1y,data1y,tr1y,priceRetPct1y,totalRetPct1y}=queue[idx];
    // Store full year data for toggle
    window._etfChartData[ticker]={color,labels6m:labels,data6m:data,tr6m:totalReturn,priceRetPct6m:priceRetPct,totalRetPct6m:totalRetPct,labels1y,data1y,tr1y,priceRetPct1y,totalRetPct1y};
    requestAnimationFrame(()=>{
      renderEtfChart(ticker,color,labels,data,totalReturn);
      renderNextEtfChart(queue,idx+1);
    });
  }
  renderNextEtfChart(etfChartQueue,0);
}

function restoreETFFromCache(){
  // Restore _etfChartData from localStorage so toggleEtfSpan works offline
  if(!window._etfChartData)window._etfChartData={};
  ['SPYI','NBOS'].forEach(ticker=>{
    const tr=S.get('etf_tr_'+ticker);
    if(tr&&!window._etfChartData[ticker]){
      const etfColors={'SPYI':'#00d4aa','NBOS':'#7c6af7'};
      window._etfChartData[ticker]={
        color:etfColors[ticker]||'#4fc3f7',
        labels6m:tr.chartLabels6m||[],data6m:tr.chartData6m||[],tr6m:tr.totalReturn||[],
        priceRetPct6m:tr.priceRetPct,totalRetPct6m:tr.totalRetPct,
        labels1y:tr.labels1y||[],data1y:tr.data1y||[],tr1y:tr.tr1y||[],
        priceRetPct1y:tr.priceRetPct1y,totalRetPct1y:tr.totalRetPct1y
      };
    }
  });
  const cached=S.get('etf_rendered');
  if(cached?.html){
    document.getElementById('etf-content').innerHTML=cached.html;
    setTimeout(refreshTsChipAges,200);
    // Use renderEtfChart (global) with cached total return data
    setTimeout(()=>{
      ['SPYI','NBOS'].forEach(ticker=>{
        const cd=window._etfChartData&&window._etfChartData[ticker];
        if(!cd||!cd.labels6m||!cd.labels6m.length)return;
        renderEtfChart(ticker,cd.color,cd.labels6m,cd.data6m,cd.tr6m);
      });
    },150);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ETF RESEARCH SANDBOX
// Analyze up to 5 ad-hoc ETF tickers for comparison with SPYI/NBOS.
// Completely isolated from income calculations.
// Storage keys: etf_research_tickers (array), etf_research_TICKER (per-ticker cache)
// ═══════════════════════════════════════════════════════════════════════════

const _SB_MAX=5;
const _SB_KEY='etf_research_tickers';
const _SB_COLOR='#4fc3f7'; // sandbox accent color

function _sbTickers(){return S.get(_SB_KEY)||[];}
function _sbSave(arr){S.set(_SB_KEY,arr);}

// ── Fetch ─────────────────────────────────────────────────────────────────

async function _sbFetch(ticker){
  let snap=null,hist6mo=null,distributions=[],trailingYield=null;

  let fundName=ticker,fundDesc='';
  try{
    const[quote,metrics]=await Promise.all([
      fh(`/quote?symbol=${ticker}`),
      fh(`/stock/metric?symbol=${ticker}&metric=all`)
    ]);
    snap={ticker,price:quote.c,change:quote.c-quote.pc,
      changePct:((quote.c-quote.pc)/quote.pc*100),
      week52High:metrics.metric?.['52WeekHigh']||null,
      week52Low:metrics.metric?.['52WeekLow']||null,
      dividendYield:metrics.metric?.dividendYieldIndicatedAnnual||null,
      ts:nowPT()};
  }catch{
    const c=S.get('etf_research_'+ticker);
    if(c?.snap){snap=c.snap;fundName=c.fundName||ticker;fundDesc=c.fundDesc||'';}
  }
  // Fetch fund name and description from Yahoo assetProfile
  try{
    const pr=await fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(ticker)}&type=summary&modules=assetProfile,summaryDetail&_t=${Date.now()}`);
    if(pr.ok){
      const pj=await pr.json();
      const ap=pj?.quoteSummary?.result?.[0]?.assetProfile||{};
      const sd=pj?.quoteSummary?.result?.[0]?.summaryDetail||{};
      // longName from quoteType is better -- try quoteType module too
      fundName=ap.longName||snap?.longName||ticker;
      fundDesc=ap.longBusinessSummary||'';
    }
  }catch{}
  // Fallback: try quoteType for longName
  if(fundName===ticker){
    try{
      const qr=await fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(ticker)}&type=summary&modules=quoteType&_t=${Date.now()}`);
      if(qr.ok){const qj=await qr.json();fundName=qj?.quoteSummary?.result?.[0]?.quoteType?.longName||ticker;}
    }catch{}
  }
  if(snap){snap.fundName=fundName;snap.fundDesc=fundDesc;}

  try{
    hist6mo=await yahooHistory(ticker,'1y','1d');
  }catch{
    const c=S.get('etf_research_'+ticker);
    if(c?.hist)hist6mo={timestamps:c.hist.timestamps.map(d=>new Date(d)),closes:c.hist.closes};
  }

  try{
    const r=await fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(ticker)}&type=dividends&range=3y`);
    if(r.ok){
      const j=await r.json();
      const ev=j.chart?.result?.[0]?.events?.dividends;
      if(ev){
        const divList=Object.values(ev).sort((a,b)=>b.date-a.date).slice(0,24)
          .map(d=>({date:new Date(d.date*1000).toISOString().split('T')[0],amount:d.amount}));
        distributions=divList;
        const total=divList.slice(0,12).reduce((s,d)=>s+(d.amount||0),0);
        if(snap?.price&&total>0)trailingYield=(total/snap.price*100).toFixed(2);
      }
    }
    if(!distributions.length)throw new Error('no div');
  }catch{
    const c=S.get('etf_research_'+ticker);
    if(c?.distributions){
      distributions=c.distributions;
      const total=distributions.slice(0,12).reduce((s,d)=>s+(d.amount||0),0);
      if(snap?.price&&total>0)trailingYield=(total/snap.price*100).toFixed(2);
    }
  }

  // Persist cache
  S.set('etf_research_'+ticker,{
    snap,fundName,fundDesc,
    hist:hist6mo?{timestamps:hist6mo.timestamps.map(d=>d instanceof Date?d.toISOString():d),closes:hist6mo.closes}:null,
    distributions,trailingYield,ts:nowPT()
  });

  return{snap,hist6mo,distributions,trailingYield,fundName,fundDesc};
}

// ── Tile HTML builder ─────────────────────────────────────────────────────

function _sbBuildTile(ticker,snap,hist6mo,distributions,trailingYield,isLive,fundName,fundDesc){
  fundName=fundName||snap?.fundName||ticker;
  fundDesc=fundDesc||snap?.fundDesc||'';
  const color=_SB_COLOR;
  const chgColor=snap?(snap.change>=0?'var(--green)':'var(--red)'):'var(--text2)';
  const chgSign=snap?(snap.change>=0?'+':''):'';

  const chartLabels=hist6mo?hist6mo.timestamps.slice(-126).map(d=>{
    if(!(d instanceof Date))d=new Date(d);
    return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  }):[];
  const chartData=hist6mo?hist6mo.closes.slice(-126):[];

  let totalReturnData=[];
  if(hist6mo&&distributions.length){
    let cum=0;const byDate={};
    distributions.forEach(d=>{if(d.date&&d.amount)byDate[d.date]=(byDate[d.date]||0)+d.amount;});
    totalReturnData=hist6mo.timestamps.slice(-126).map((ts,i)=>{
      if(!(ts instanceof Date))ts=new Date(ts);
      const ds=ts.toISOString().split('T')[0];
      if(byDate[ds])cum+=byDate[ds];
      return chartData[i]!=null?chartData[i]+cum:null;
    });
  }

  const fp=chartData.find(p=>p!=null),lp=[...chartData].reverse().find(p=>p!=null);
  const priceRetPct=fp&&lp?((lp-fp)/fp*100):null;
  const ft=totalReturnData.find(p=>p!=null),lt=[...totalReturnData].reverse().find(p=>p!=null);
  const totalRetPct=ft&&lt?((lt-ft)/ft*100):null;

  // 1Y data for toggle
  const labels1y=hist6mo?hist6mo.timestamps.map(d=>{
    if(!(d instanceof Date))d=new Date(d);
    return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
  }):[];
  const data1y=hist6mo?hist6mo.closes:[];
  let tr1y=[];
  if(hist6mo&&distributions.length){
    let cum1y=0;const bd1y={};
    distributions.forEach(d=>{if(d.date&&d.amount)bd1y[d.date]=(bd1y[d.date]||0)+d.amount;});
    tr1y=hist6mo.timestamps.map((ts,i)=>{
      if(!(ts instanceof Date))ts=new Date(ts);
      const ds=ts.toISOString().split('T')[0];
      if(bd1y[ds])cum1y+=bd1y[ds];
      return data1y[i]!=null?data1y[i]+cum1y:null;
    });
  }
  const fp1y=data1y.find(p=>p!=null),lp1y=[...data1y].reverse().find(p=>p!=null);
  const priceRetPct1y=fp1y&&lp1y?((lp1y-fp1y)/fp1y*100):null;
  const ft1y=tr1y.find(p=>p!=null),lt1y=[...tr1y].reverse().find(p=>p!=null);
  const totalRetPct1y=ft1y&&lt1y?((lt1y-ft1y)/ft1y*100):null;

  // Store for chart render (6M and 1Y)
  if(!window._sbChartData)window._sbChartData={};
  window._sbChartData[ticker]={color,
    labels6m:chartLabels,data6m:chartData,tr6m:totalReturnData,priceRetPct6m:priceRetPct,totalRetPct6m:totalRetPct,
    labels1y,data1y,tr1y,priceRetPct1y,totalRetPct1y};

  return `<div class="card" id="sb-tile-${ticker}" style="border-left:4px solid ${color};margin-bottom:10px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <div style="font-family:var(--mono);font-size:9px;background:rgba(79,195,247,0.12);color:${color};padding:2px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:0.5px">&#x1F9EA; Research Sandbox — not included in income calculations</div>
      <button onclick="sbRemove('${ticker}')" style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;line-height:1;padding:2px 6px">&times;</button>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
      <div>
        <div style="font-family:var(--sans);font-size:20px;font-weight:700;color:${color}">${ticker}</div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-top:2px">${fundName!==ticker?fundName:''}</div>
      </div>
      <div style="text-align:right">
        ${snap?`<div style="font-family:var(--mono);font-size:18px;font-weight:500">$${snap.price.toFixed(2)}</div>
        <div style="font-family:var(--mono);font-size:11px;color:${chgColor}">${chgSign}${snap.change?.toFixed(2)} (${chgSign}${snap.changePct?.toFixed(2)}%)</div>`
        :'<div style="font-family:var(--mono);color:var(--text3)">No price data</div>'}
      </div>
    </div>
    ${tsChip(snap?.ts||'',isLive)}
    <div class="metrics-grid" style="margin-bottom:10px">
      <div class="metric-tile" style="grid-column:span 2">
        <div class="metric-label">Trailing 12-Month Distribution Yield</div>
        <div class="metric-value" style="color:${color};font-size:20px">${trailingYield?trailingYield+'%':'N/A'}</div>
        <div class="metric-sub">${trailingYield?`Sum of last ${Math.min(12,distributions.length)} distributions / current price`:'No distribution data available'}</div>
      </div>
      <div class="metric-tile">
        ${priceRetPct!=null?`<div class="metric-label">Price Return (6M)</div>
        <div class="metric-value" style="color:${priceRetPct>=0?'var(--green)':'var(--red)'}">${priceRetPct>=0?'+':''}${priceRetPct.toFixed(1)}%</div>
        <div class="metric-sub">NAV change only</div>`:''}
      </div>
      <div class="metric-tile">
        ${totalRetPct!=null?`<div class="metric-label">Total Return (6M)</div>
        <div class="metric-value" style="color:${totalRetPct>=0?'var(--green)':'var(--red)'}">${totalRetPct>=0?'+':''}${totalRetPct.toFixed(1)}%</div>
        <div class="metric-sub">Price + distributions reinvested</div>`:''}
      </div>
      <div class="metric-tile">
        <div class="metric-label">Annualized Yield (indicated)</div>
        <div class="metric-value" style="font-size:13px">${snap?.dividendYield?snap.dividendYield.toFixed(2)+'%':'N/A'}</div>
      </div>
      <div class="metric-tile">
        <div class="metric-label">52W High / Low</div>
        <div class="metric-value" style="font-size:11px">$${snap?.week52High?.toFixed(2)||'N/A'} / $${snap?.week52Low?.toFixed(2)||'N/A'}</div>
      </div>
    </div>
    ${distributions.length
      ?`<div style="margin-bottom:10px">
          <div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:6px">Recent Distributions</div>
          ${distributions.slice(0,6).map(d=>`<div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:11px;padding:4px 0;border-bottom:1px solid var(--border)"><span style="color:var(--text2)">${d.date}</span><span style="color:${color}">$${d.amount?.toFixed(4)||'N/A'}</span></div>`).join('')}
        </div>`
      :'<div style="font-family:var(--mono);font-size:11px;color:var(--text3);margin-bottom:10px">No distribution history from data provider.</div>'}
    ${chartLabels.length
      ?`<div class="card-title" style="margin-bottom:6px"><span class="dot" style="background:${color}"></span>Price</div>
        <div style="display:flex;gap:6px;margin-bottom:4px">
          <button class="btn btn-secondary" style="font-size:10px;padding:2px 8px" id="sb-btn-6m-${ticker}" onclick="sbToggleSpan('${ticker}','6m')">6M</button>
          <button class="btn btn-secondary" style="font-size:10px;padding:2px 8px;opacity:0.4" id="sb-btn-1y-${ticker}" onclick="sbToggleSpan('${ticker}','1y')">1Y</button>
        </div>
        <div class="chart-wrap" style="height:140px"><canvas id="sb-chart-${ticker}"></canvas></div>`
      :''}
  </div>`;
}

function _sbRenderChart(ticker){
  const d=window._sbChartData?.[ticker];
  if(!d||!d.labels.length)return;
  const ctx=document.getElementById('sb-chart-'+ticker)?.getContext('2d');
  if(!ctx)return;
  if(!window._sbCharts)window._sbCharts={};
  if(window._sbCharts[ticker])window._sbCharts[ticker].destroy();
  const datasets=[{label:'Price',data:d.data,borderColor:d.color,borderWidth:1.5,pointRadius:0,tension:0.2,fill:false}];
  if(d.totalReturn.length)datasets.push({label:'Total Return',data:d.totalReturn,borderColor:'#ffd32a',borderWidth:1.5,pointRadius:0,tension:0.2,fill:false,borderDash:[4,3]});
  window._sbCharts[ticker]=new Chart(ctx,{
    type:'line',data:{labels:d.labels,datasets},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:datasets.length>1,labels:{color:'#8b8fa8',font:{size:9},boxWidth:20}}},
      scales:{x:{ticks:{color:'#555870',font:{size:9},maxTicksLimit:6},grid:{color:'#2a2e38'}},
              y:{ticks:{color:'#555870',font:{size:9}},grid:{color:'#2a2e38'}}}}
  });
}

// ── Public actions ────────────────────────────────────────────────────────

function sbToggleSpan(ticker,span){
  const btn6=document.getElementById('sb-btn-6m-'+ticker);
  const btn1=document.getElementById('sb-btn-1y-'+ticker);
  if(btn6)btn6.style.opacity=span==='6m'?'1':'0.4';
  if(btn1)btn1.style.opacity=span==='1y'?'1':'0.4';
  const d=window._sbChartData?.[ticker];
  if(!d)return;
  const labels=span==='6m'?d.labels6m:d.labels1y;
  const data=span==='6m'?d.data6m:d.data1y;
  const tr=span==='6m'?d.tr6m:d.tr1y;
  if(!labels||!labels.length){toast(span.toUpperCase()+' data not available',2000);return;}
  const ctx=document.getElementById('sb-chart-'+ticker)?.getContext('2d');
  if(!ctx)return;
  if(window._sbCharts?.[ticker])window._sbCharts[ticker].destroy();
  if(!window._sbCharts)window._sbCharts={};
  const datasets=[{label:'Price',data,borderColor:d.color,borderWidth:1.5,pointRadius:0,tension:0.2,fill:false}];
  if(tr&&tr.length)datasets.push({label:'Total Return',data:tr,borderColor:'#ffd32a',borderWidth:1.5,pointRadius:0,tension:0.2,fill:false,borderDash:[4,3]});
  window._sbCharts[ticker]=new Chart(ctx,{type:'line',data:{labels,datasets},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:datasets.length>1,labels:{color:'#8b8fa8',font:{size:9},boxWidth:20}}},scales:{x:{ticks:{color:'#555870',font:{size:9},maxTicksLimit:6},grid:{color:'#2a2e38'}},y:{ticks:{color:'#555870',font:{size:9}},grid:{color:'#2a2e38'}}}}});
}

async function sbAnalyze(){
  const input=document.getElementById('sb-input');
  const ticker=(input?.value||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(!ticker){toast('Enter a ticker symbol');return;}

  const tickers=_sbTickers();
  if(tickers.includes(ticker)){toast(ticker+' is already in the sandbox');return;}
  if(tickers.length>=_SB_MAX){toast('Sandbox limit is '+_SB_MAX+' ETFs — remove one first',3000);return;}

  // Persist ticker immediately so it survives a crash
  tickers.push(ticker);
  _sbSave(tickers);
  if(input)input.value='';

  // Insert loading tile
  const container=document.getElementById('sb-tiles');
  if(container){
    const div=document.createElement('div');
    div.id='sb-tile-'+ticker;
    div.className='card';
    div.style.borderLeft='4px solid '+_SB_COLOR;
    div.style.marginBottom='10px';
    div.innerHTML='<div style="display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--text2)"><div class="spinner"></div>Loading '+ticker+'...</div>';
    container.appendChild(div);
  }

  try{
    const{snap,hist6mo,distributions,trailingYield,fundName,fundDesc}=await _sbFetch(ticker);
    const html=_sbBuildTile(ticker,snap,hist6mo,distributions,trailingYield,true,fundName,fundDesc);
    const existing=document.getElementById('sb-tile-'+ticker);
    if(existing){existing.outerHTML=html;}
    requestAnimationFrame(()=>_sbRenderChart(ticker));
  }catch(err){
    const el=document.getElementById('sb-tile-'+ticker);
    if(el)el.innerHTML=`<div style="font-family:var(--mono);font-size:12px;color:var(--red)">${ticker}: ${err.message}</div>`;
  }
}

function sbRemove(ticker){
  // Remove from persisted list
  _sbSave(_sbTickers().filter(t=>t!==ticker));
  // Clear cache
  S.del('etf_research_'+ticker);
  // Destroy chart
  if(window._sbCharts?.[ticker]){window._sbCharts[ticker].destroy();delete window._sbCharts[ticker];}
  if(window._sbChartData?.[ticker])delete window._sbChartData[ticker];
  // Remove tile
  document.getElementById('sb-tile-'+ticker)?.remove();
  toast(ticker+' removed from sandbox');
}

function restoreSandboxFromCache(){
  const tickers=_sbTickers();
  const container=document.getElementById('sb-tiles');
  if(!container||!tickers.length)return;
  container.innerHTML='';
  tickers.forEach(ticker=>{
    const c=S.get('etf_research_'+ticker);
    if(!c)return;
    const hist6mo=c.hist?{timestamps:c.hist.timestamps.map(d=>new Date(d)),closes:c.hist.closes}:null;
    const html=_sbBuildTile(ticker,c.snap,hist6mo,c.distributions||[],c.trailingYield,false,c.fundName,c.fundDesc);
    const wrap=document.createElement('div');wrap.innerHTML=html;
    container.appendChild(wrap.firstChild);
    requestAnimationFrame(()=>_sbRenderChart(ticker));
  });
}
