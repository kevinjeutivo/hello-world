// PutSeller Pro -- api.js
// All network fetch functions: Finnhub, Yahoo Finance via Worker.
// Globals used: FINNHUB_KEY, WORKER_URL, offlineMode
// Dependencies: storage.js, helpers.js

async function fh(path){
  if(offlineMode)throw new Error('offline mode');
  if(!FINNHUB_KEY){toast('Add Finnhub key in Settings');throw new Error('No API key');}
  const r=await fetch(`https://finnhub.io/api/v1${path}&token=${FINNHUB_KEY}`);
  if(!r.ok)throw new Error(`Finnhub ${r.status}`);
  return r.json();
}

async function yahooHistory(symbol,range='6mo',interval='1d'){
  if(offlineMode)throw new Error('offline mode');
  const url=`${WORKER_URL}/?ticker=${encodeURIComponent(symbol)}&type=history&range=${range}&interval=${interval}`;
  const r=await fetch(url);if(!r.ok)throw new Error(`History proxy ${r.status}`);
  const d=await r.json();if(d.error)throw new Error(d.error);
  const result=d.chart?.result?.[0];if(!result)throw new Error('No history data');
  return{timestamps:result.timestamp.map(t=>new Date(t*1000)),closes:result.indicators.quote[0].close,volumes:result.indicators.quote[0].volume||[]};
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
  let url=`${WORKER_URL}/?ticker=${encodeURIComponent(symbol)}&type=options`;
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
  // Single call fetching 4 quoteSummary modules:
  // financialData: price targets, margins, growth
  // defaultKeyStatistics: PEG, EV/EBITDA, short interest, beta
  // earningsTrend: EPS/revenue estimates by period + revision direction
  // recommendationTrend: buy/hold/sell counts by month (Yahoo free, vs Finnhub premium)
  if(offlineMode)return null;
  try{
    const modules='financialData,defaultKeyStatistics,earningsTrend,recommendationTrend';
    const r=await fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(symbol)}&type=summary&modules=${encodeURIComponent(modules)}`);
    if(!r.ok)return null;
    const d=await r.json();
    const res=d.quoteSummary?.result?.[0];
    if(!res)return null;
    const fd=res.financialData||{};
    const ks=res.defaultKeyStatistics||{};
    const et=res.earningsTrend?.trend||[];
    const rt=res.recommendationTrend?.trend||[];
    return{
      // Price targets (financialData)
      ptMean:fd.targetMeanPrice?.raw||null,
      ptHigh:fd.targetHighPrice?.raw||null,
      ptLow:fd.targetLowPrice?.raw||null,
      ptAnalysts:fd.numberOfAnalystOpinions?.raw||null,
      // Valuation (defaultKeyStatistics)
      pegRatio:ks.pegRatio?.raw||null,
      evToEbitda:ks.enterpriseToEbitda?.raw||null,
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
      }))
    };
  }catch{return null;}
}

async function fetchPriceTarget(symbol){
  const qs=await fetchQuoteSummary(symbol);
  return qs?{ptMean:qs.ptMean,ptHigh:qs.ptHigh,ptLow:qs.ptLow,ptAnalysts:qs.ptAnalysts}:null;
}

async function fetchAfterHoursPrice(symbol){
  // Use Yahoo Finance quote endpoint (same source as yfinance stock.info)
  // This is the most reliable source for postMarketPrice and preMarketPrice.
  // The chart endpoint meta fields are unreliable for extended-hours data.
  if(offlineMode)return null;
  try{
    const r=await fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(symbol)}&type=quote`);
    if(!r.ok)return null;
    const d=await r.json();
    const q=d.quoteResponse?.result?.[0];
    if(!q)return null;
    const marketState=q.marketState||'';
    // postMarketPrice populated after 4pm ET, preMarketPrice before 9:30am ET
    // During REGULAR session, suppress extended-hours price entirely --
    // Yahoo often returns a stale prior-session value which must not be shown.
    const postPrice=q.postMarketPrice||null;
    const prePrice=q.preMarketPrice||null;
    const isExtended=marketState==='PRE'||marketState==='POST'||marketState==='POSTPOST';
    const extPrice=isExtended?(marketState==='PRE'?prePrice:postPrice):null;
    return{
      postMarketPrice:extPrice,
      postMarketChange:isExtended?(marketState==='PRE'?q.preMarketChange:q.postMarketChange):null,
      postMarketChangePct:isExtended?(marketState==='PRE'?q.preMarketChangePercent:q.postMarketChangePercent):null,
      marketState,
      hasExtended:!!extPrice,
      intradayVolume:q.regularMarketVolume||null,
      forwardPE:q.forwardPE||null,
      trailingEps:q.epsTrailingTwelveMonths||q.trailingEps||null,
      epsGrowth:null,
      ptMean:null,
      ptHigh:null,
      ptLow:null,
      ptAnalysts:null
    };
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
    const results=await Promise.all(tickers.map(t=>
      fetch(`${WORKER_URL}/?ticker=${encodeURIComponent(t)}&type=quote`)
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
