// Income Engine -- api.js
// All network fetch functions: Finnhub, Yahoo Finance via Worker.
// Globals used: FINNHUB_KEY, WORKER_URL, offlineMode
// Dependencies: storage.js, helpers.js

async function fh(path){
  if(offlineMode)throw new Error('offline mode');
  if(!FINNHUB_KEY){toast('Add Finnhub key in Settings');throw new Error('No API key');}
  const r=await fetch(`https://finnhub.io/api/v1${path}&token=${FINNHUB_KEY}`);
  if(!r.ok){
    let _body='';
    try{_body=(await r.text()).slice(0,200);}catch{}
    throw new Error(`Finnhub ${r.status}${_body?': '+_body:''}`);
  }
  return r.json();
}

async function yahooHistory(symbol,range='6mo',interval='1d'){
  if(offlineMode)throw new Error('offline mode');
  // Cache-bust: history responses (esp. range=2y) can be served stale from edge/CDN
  // caches without this, since the URL is otherwise identical across days.
  const url=`${WORKER_URL}/?ticker=${encodeURIComponent(symbol)}&type=history&range=${range}&interval=${interval}&_t=${Date.now()}`;
  const r=await fetch(url);if(!r.ok)throw new Error(`History proxy ${r.status}`);
  const d=await r.json();if(d.error)throw new Error(d.error);
  const result=d.chart?.result?.[0];if(!result)throw new Error('No history data');
  const adjcloses=result.indicators.adjclose?.[0]?.adjclose||null;
  return{timestamps:result.timestamp.map(t=>new Date(t*1000)),closes:result.indicators.quote[0].close,volumes:result.indicators.quote[0].volume||[],adjcloses};
}

function slimOptionsData(json){
  // Strip Yahoo options response to only fields needed by buildOptionsTable and renderOIChart
  // Raw response can be 500KB+; slimmed version is ~50KB, well within localStorage limits
  const result=json?.optionChain?.result?.[0];
  if(!result)return json;
  const slimContract=c=>({
    strike:c.strike,
    bid:c.bid,
    ask:c.ask,
    lastPrice:c.lastPrice,
    openInterest:c.openInterest,
    volume:c.volume,
    impliedVolatility:c.impliedVolatility,
    inTheMoney:c.inTheMoney,
    expiration:c.expiration
  });
  const slimOptions=(result.options||[]).map(o=>({
    expirationDate:o.expirationDate,
    hasMiniOptions:o.hasMiniOptions,
    puts:(o.puts||[]).map(slimContract),
    calls:(o.calls||[]).map(slimContract)
  }));
  return{optionChain:{result:[{
    underlyingSymbol:result.underlyingSymbol,
    expirationDates:result.expirationDates,
    strikes:result.strikes,
    hasMiniOptions:result.hasMiniOptions,
    quote:{regularMarketPrice:result.quote?.regularMarketPrice},
    options:slimOptions
  }],error:null}};
}

async function yahooOptionsViaProxy(symbol,expiration){
  if(offlineMode)throw new Error('offline mode');
  let url=`${WORKER_URL}/?ticker=${encodeURIComponent(symbol)}&type=options&_t=${Date.now()}`;
  if(expiration)url+=`&expiration=${expiration}`;
  const r=await fetch(url);
  if(!r.ok){
    const errText=await r.text().catch(()=>'');
    throw new Error(`Options proxy ${r.status}: ${errText.slice(0,80)}`);
  }
  const json=await r.json();
  return slimOptionsData(json);
}

async function fetchQuoteSummary(symbol){
  // Single call fetching 5 quoteSummary modules:
  // financialData: price targets, margins, growth
  // defaultKeyStatistics: PEG, EV/EBITDA, short interest, beta
  // earningsTrend: EPS/revenue estimates by period + revision direction
  // recommendationTrend: buy/hold/sell counts by month (Yahoo free, vs Finnhub premium)
  // earningsHistory: past actual-vs-estimate EPS + surprise (replaces Finnhub /stock/earnings)
  if(offlineMode)return null;
  try{
    const modules='financialData,defaultKeyStatistics,earningsTrend,recommendationTrend,earningsHistory';
    const r=await fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(symbol)}&type=summary&modules=${encodeURIComponent(modules)}`);
    if(!r.ok)return null;
    const d=await r.json();
    const res=d.quoteSummary?.result?.[0];
    if(!res)return null;
    const fd=res.financialData||{};
    const ks=res.defaultKeyStatistics||{};
    const et=res.earningsTrend?.trend||[];
    const rt=res.recommendationTrend?.trend||[];
    const eh=res.earningsHistory?.history||[];
    return{
      // Price targets (financialData)
      ptMean:fd.targetMeanPrice?.raw||null,
      ptHigh:fd.targetHighPrice?.raw||null,
      ptLow:fd.targetLowPrice?.raw||null,
      ptAnalysts:fd.numberOfAnalystOpinions?.raw||null,
      // Rule of 40 inputs (financialData -- backward-looking reported financials, reliable)
      revenueGrowthYahoo:fd.revenueGrowth?.raw??null,         // decimal (0.09 = 9%)
      operatingMarginsYahoo:fd.operatingMargins?.raw??null,   // decimal (0.15 = 15%)
      freeCashflowYahoo:fd.freeCashflow?.raw??null,           // dollars
      totalRevenueYahoo:fd.totalRevenue?.raw??null,           // dollars
      // Valuation (defaultKeyStatistics)
      beta:ks.beta?.raw??null,
      pegRatio:ks.pegRatio?.raw||null,
      evToEbitda:ks.enterpriseToEbitda?.raw||null,
      totalAssets:ks.totalAssets?.raw||null,              // ETF AUM (null for stocks)
      // Short interest (defaultKeyStatistics -- more reliable than Finnhub free tier)
      shortPctFloat:ks.shortPercentOfFloat?.raw||null,
      shortRatioYahoo:ks.shortRatio?.raw||null,
      sharesShort:ks.sharesShort?.raw||null,
      // Earnings trend (array of 4 periods)
      earningsTrend:et.slice(0,4).map(p=>({
        period:p.period,
        epsMean:p.earningsEstimate?.avg?.raw||null,
        epsLow:p.earningsEstimate?.low?.raw||null,
        epsHigh:p.earningsEstimate?.high?.raw||null,
        revenueAvg:p.revenueEstimate?.avg?.raw||null,
        epsRevUp:p.earningsEstimate?.numberOfAnalystsWithEstimate?.raw||null,
        growth:p.growth?.raw||null,
        endDate:p.endDate
      })),
      // Recommendation trend (last 3 months)
      recTrend:rt.slice(0,3).map(m=>({
        period:m.period,
        strongBuy:m.strongBuy,buy:m.buy,hold:m.hold,sell:m.sell,strongSell:m.strongSell
      })),
      // Earnings history (past ~4 quarters, actual vs estimate). Surprise% is derived
      // ourselves from actual/estimate rather than trusting Yahoo's own surprisePercent
      // field, to match the exact calculation the app already used with Finnhub data.
      earningsHistoryYahoo:eh.map(h=>{
        const epsActual=h.epsActual?.raw??null;
        const epsEstimate=h.epsEstimate?.raw??null;
        const date=h.quarter?.fmt||(h.quarter?.raw?fmtDate(new Date(h.quarter.raw*1000)):null);
        return{
          date,
          epsActual,
          epsEstimate,
          surprisePercent:(epsActual!=null&&epsEstimate)?((epsActual-epsEstimate)/Math.abs(epsEstimate)*100):null
        };
      }).filter(h=>h.date)
    };
  }catch{return null;}
}

async function fetchPriceTarget(symbol){
  const qs=await fetchQuoteSummary(symbol);
  return qs?{ptMean:qs.ptMean,ptHigh:qs.ptHigh,ptLow:qs.ptLow,ptAnalysts:qs.ptAnalysts}:null;
}

async function fetchAfterHoursPrice(symbol){
  // Yahoo Finance quote endpoint -- primary source for all real-time and fundamental fields.
  // Replaces Finnhub /quote, /stock/profile2, and most of /stock/metric.
  if(offlineMode)return null;
  try{
    const r=await fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(symbol)}&type=quote&_t=${Date.now()}`);
    if(!r.ok)return null;
    const d=await r.json();
    const q=d.quoteResponse?.result?.[0];
    if(!q)return null;
    const marketState=q.marketState||'';
    const postPrice=q.postMarketPrice||null;
    const prePrice=q.preMarketPrice||null;
    const isExtended=marketState==='PRE'||marketState==='POST'||marketState==='POSTPOST';
    const isClosed=marketState==='CLOSED';
    const extPrice=marketState==='REGULAR'?null:
      isExtended?(marketState==='PRE'?prePrice:postPrice):
      isClosed?postPrice:null;
    return{
      // Extended-hours price
      postMarketPrice:extPrice,
      postMarketChange:isExtended?(marketState==='PRE'?q.preMarketChange:q.postMarketChange):(isClosed?q.postMarketChange||null:null),
      postMarketChangePct:isExtended?(marketState==='PRE'?q.preMarketChangePercent:q.postMarketChangePercent):(isClosed?q.postMarketChangePercent||null:null),
      marketState,
      hasExtended:!!extPrice,
      // Primary price fields (replaces Finnhub /quote)
      price:q.regularMarketPrice||null,
      prevClose:q.regularMarketPreviousClose||null,
      high:q.regularMarketDayHigh||null,
      low:q.regularMarketDayLow||null,
      intradayVolume:q.regularMarketVolume||null,
      // Company info (replaces Finnhub /stock/profile2)
      name:q.shortName||q.longName||null,
      marketCap:q.marketCap||null,                    // already in dollars
      // Valuation (replaces Finnhub /stock/metric)
      peRatio:q.trailingPE||null,
      forwardPE:q.forwardPE||null,
      trailingEps:q.epsTrailingTwelveMonths||q.trailingEps||null,
      dividendYield:q.trailingAnnualDividendYield??q.dividendYield??null, // decimal (0.02 = 2%)
      // 52-week range (available directly in Yahoo /quote)
      week52High:q.fiftyTwoWeekHigh||null,
      week52Low:q.fiftyTwoWeekLow||null,
      // Not in Yahoo /quote -- comes from quoteSummary defaultKeyStatistics
      epsGrowth:null,
      ptMean:null,ptHigh:null,ptLow:null,ptAnalysts:null
    };
  }catch{return null;}
}

async function fetchTopHoldings(ticker){
  if(offlineMode)return null;
  try{
    const r=await fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(ticker)}&type=summary&modules=topHoldings&_t=${Date.now()}`);
    if(!r.ok)return null;
    const d=await r.json();
    const th=d.quoteSummary?.result?.[0]?.topHoldings;
    if(!th)return null;
    // Individual holdings (equity ETFs)
    const holdings=(th.holdings||[]).map(h=>({
      symbol:h.symbol||null,
      name:h.holdingName||h.symbol||null,
      pct:h.holdingPercent?.raw!=null?+(h.holdingPercent.raw*100).toFixed(2):null
    })).filter(h=>h.name&&h.pct!=null);
    // Asset allocation (all ETFs)
    const alloc={
      cash:th.cashPosition?.raw!=null?+(th.cashPosition.raw*100).toFixed(2):null,
      stock:th.stockPosition?.raw!=null?+(th.stockPosition.raw*100).toFixed(2):null,
      bond:th.bondPosition?.raw!=null?+(th.bondPosition.raw*100).toFixed(2):null,
      other:th.otherPosition?.raw!=null?+(th.otherPosition.raw*100).toFixed(2):null,
    };
    const hasAlloc=Object.values(alloc).some(v=>v!=null&&v!==0);
    // Bond characteristics (bond/options ETFs)
    const bh=th.bondHoldings;
    const bond=bh?{
      maturity:bh.maturity?.raw!=null?+bh.maturity.raw.toFixed(2):null,
      duration:bh.duration?.raw!=null?+bh.duration.raw.toFixed(2):null,
    }:null;
    // Bond ratings
    const ratings=th.bondRatings?.length
      ?th.bondRatings.map(r=>{const k=Object.keys(r)[0];return{label:k.replace(/_/g,' '),pct:+(r[k].raw*100).toFixed(2)};})
      :[];
    if(!holdings.length&&!hasAlloc)return null;
    return{holdings,alloc:hasAlloc?alloc:null,bond,ratings};
  }catch{return null;}
}

async function fetchNews(ticker){
  const to=fmtDate(new Date());const from=fmtDate(addDays(new Date(),-7));
  return fh(`/company-news?symbol=${ticker}&from=${from}&to=${to}`);
}

async function fetchFedFundsFutures(){
  // CME 30-Day Fed Funds Futures -- Yahoo Finance tickers:
  // ZQF26=F (Jan 2026), ZQG26=F (Feb), ZQH26=F (Mar), ZQJ26=F (Apr), ZQK26=F (May)
  // ZQM26=F (Jun), ZQN26=F (Jul), ZQQ26=F (Aug), ZQU26=F (Sep), ZQV26=F (Oct)
  // Convention: implied rate = 100 - futures price
  // Current year month codes: F=Jan G=Feb H=Mar J=Apr K=May M=Jun N=Jul Q=Aug U=Sep V=Oct X=Nov Z=Dec
  if(offlineMode)return null;
  try{
    const now=new Date();
    const yr=now.getFullYear();
    const mo=now.getMonth(); // 0-indexed
    // Month codes for futures contracts
    const codes=['F','G','H','J','K','M','N','Q','U','V','X','Z'];
    // Build tickers for next 6 months starting from current month
    const tickers=[];
    for(let i=0;i<6;i++){
      const d=new Date(yr,mo+i,1);
      const y=d.getFullYear().toString().slice(2);
      const c=codes[d.getMonth()];
      tickers.push(`ZQ${c}${y}.CBT`);
    }
    // Fetch quotes for all 6 contracts in parallel
    const _fft=Date.now();
    const results=await Promise.all(tickers.map(t=>
      fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(t)}&type=quote&_t=${_fft}`)
        .then(r=>r.json())
        .catch(()=>null)
    ));
    const contracts=[];
    results.forEach((d,i)=>{
      const q=d?.quoteResponse?.result?.[0];
      if(!q)return;
      const price=q.regularMarketPrice||null;
      if(!price||price<90)return; // sanity check -- valid futures are 95-100
      const impliedRate=parseFloat((100-price).toFixed(3));
      const contractDate=new Date(yr,mo+i,1);
      contracts.push({
        ticker:tickers[i],
        month:contractDate.toLocaleDateString('en-US',{month:'short',year:'numeric'}),
        price,
        impliedRate
      });
    });
    if(!contracts.length)return null;
    // Compute implied cut/hike probabilities between consecutive months
    // Current effective fed funds rate from most recent contract or ^IRX
    return contracts;
  }catch{return null;}
}

async function fetchTBills(){
  // Yahoo Finance T-bill index tickers via existing Worker history proxy:
  //   ^IRX = 13-week (3-month) T-bill yield index -- daily closing rate
  //   ^FVX = 5-year Treasury yield (closest Yahoo has to 6-month for context)
  // Yahoo expresses these as percentage points (e.g. 4.82 = 4.82%).
  // We divide by 10 because Yahoo stores them as tenths of a percent internally
  // -- actually Yahoo ^IRX returns the annualized discount rate directly as a %
  // so no division needed. Check: if value ~480, divide by 100. If ~4.8, use as-is.
  const [hist3m, hist5y] = await Promise.all([
    yahooHistory('^IRX', '1y', '1d'),
    yahooHistory('^FVX', '1y', '1d')
  ]);
  // ^IRX values from Yahoo are in percent (e.g. 4.82 means 4.82%)
  // but sometimes returned as tenths (48.2). Normalize: if median > 20, divide by 10.
  function normalizeYield(closes) {
    const valid = closes.filter(c => c !== null && c > 0);
    if (!valid.length) return closes;
    const median = valid.sort((a,b)=>a-b)[Math.floor(valid.length/2)];
    const factor = median > 20 ? 10 : 1;
    return closes.map(c => c !== null ? c / factor : null);
  }
  const norm3m = normalizeYield(hist3m.closes);
  const norm5y = normalizeYield(hist5y.closes);
  const tbill3m = hist3m.timestamps
    .map((ts, i) => ({date: ts.toISOString().split('T')[0], value: norm3m[i]}))
    .filter(d => d.value !== null);
  const tbill6m = hist5y.timestamps
    .map((ts, i) => ({date: ts.toISOString().split('T')[0], value: norm5y[i]}))
    .filter(d => d.value !== null);
  return {tbill3m, tbill6m, label3m:'3-Month T-Bill (^IRX)', label6m:'5-Year Treasury (^FVX)'};
}
