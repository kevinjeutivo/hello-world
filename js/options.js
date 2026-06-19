// PutSeller Pro -- options.js

// Validate options data before caching -- rejects synthetic/after-hours placeholder data.
// Yahoo returns geometric IV values (50%, 25%, 12.5%...) and zero OI when market is closed.
function _validateOptionsData(data){
  const result=data?.optionChain?.result?.[0];
  if(!result)return{valid:false,reason:'no result'};
  // Check across ALL expirations returned in the main chain, not just options[0].
  // The first expiry may be a near-dated weekly with zero OI (e.g. post-earnings),
  // while the monthly expirations the user cares about have substantial OI.
  const allOptions=result.options||[];
  if(!allOptions.length)return{valid:false,reason:'no options'};
  const allContracts=allOptions.flatMap(o=>[...(o.puts||[]),...(o.calls||[])]);
  if(!allContracts.length)return{valid:false,reason:'empty chain'};

  // Check synthetic halving IV pattern across all contracts.
  // Yahoo returns exactly 0.5, 0.25, 0.125, 0.0625, 0.03125 as after-hours placeholders.
  const SYNTH_IV_VALS=new Set([0.5,0.25,0.125,0.0625,0.03125,0.015625]);
  const ivValues=allContracts.map(c=>c.impliedVolatility).filter(v=>v!=null&&v>0);
  if(ivValues.length>=3){
    const syntheticCount=ivValues.filter(v=>SYNTH_IV_VALS.has(Math.round(v*1e6)/1e6)).length;
    const syntheticRatio=syntheticCount/ivValues.length;
    if(syntheticRatio>0.4){
      // Synthetic IV confirmed -- also check OI to be sure
      const totalOI=allContracts.reduce((s,c)=>s+(c.openInterest||0),0);
      return{valid:false,reason:'synthetic data: '+Math.round(syntheticRatio*100)+'% halving IV'+(totalOI===0?' + zero OI':'')};
    }
  }

  // Additional check: if >80% of contracts have zero bid AND zero ask, likely synthetic
  const zeroBidAsk=allContracts.filter(c=>(c.bid==null||c.bid===0)&&(c.ask==null||c.ask===0)).length;
  if(allContracts.length>=5&&zeroBidAsk/allContracts.length>0.8){
    return{valid:false,reason:'synthetic data: '+Math.round(zeroBidAsk/allContracts.length*100)+'% zero bid/ask'};
  }

  return{valid:true,reason:'ok'};
}

// ── Options cache write-protection window ────────────────────────────────────
// Returns true if the current ET time is within the live options window
// (market open 9:30am ET through the user-configured cutoff hour, default 6pm ET).
// Outside this window, existing same-day good cache is preserved.
function _isOptionsLiveWindow(){
  try{
    const cutoffHourET=parseInt(S.get('options_cutoff_et')||'18');
    const now=new Date();
    const etFmt=new Intl.DateTimeFormat('en-US',{
      timeZone:'America/New_York',
      hour:'numeric',minute:'numeric',hour12:false
    });
    const parts=etFmt.formatToParts(now);
    const etHour=parseInt(parts.find(p=>p.type==='hour').value);
    const etMin=parseInt(parts.find(p=>p.type==='minute').value);
    const etMins=etHour*60+etMin;
    const openMins=9*60+30;   // 9:30am ET
    const cutoffMins=cutoffHourET*60; // e.g. 18:00 ET
    return etMins>=openMins&&etMins<cutoffMins;
  }catch{return true;} // default to allowing write on error
}

// Returns true if the existing cached options were written during the most recent
// trading session's live window. Protects good data written yesterday (or Friday)
// from being overwritten during overnight/pre-market/weekend hours.
function _hasGoodSameDayCache(cacheKey){
  const existing=S.get(cacheKey);
  if(!existing||existing.synthetic)return false;
  const ts=existing.ts;
  if(!ts)return false;
  try{
    const written=new Date(String(ts).replace(/ PT$| UTC$| local$/,'').trim());
    if(isNaN(written.getTime()))return false;
    // Good cache is valid until the NEXT trading session's live window opens
    // (9:30am ET on the next trading day). Until then, preserve it.
    // Strategy: if we are currently outside the live window, the cache written
    // during any prior live window (up to 5 calendar days ago to cover weekends)
    // is considered good and worth preserving.
    const now=new Date();
    const ageMs=now.getTime()-written.getTime();
    const ageDays=ageMs/86400000;
    // Cache older than 5 days is always stale (covers long weekends)
    if(ageDays>5)return false;
    // Cache written during a live window is good -- check it was written
    // between 9:30am and the cutoff on its day
    const writtenET=written.toLocaleTimeString('en-US',{
      timeZone:'America/New_York',hour:'numeric',minute:'numeric',hour12:false
    });
    const parts=writtenET.split(':');
    const wHour=parseInt(parts[0]),wMin=parseInt(parts[1]);
    const wMins=wHour*60+wMin;
    const cutoffHourET=parseInt(S.get('options_cutoff_et')||'18');
    // Was it written during the live window on its day?
    return wMins>=570&&wMins<(cutoffHourET*60);
  }catch{return false;}
}


// Returns true if the options cache is fresh enough that a network fetch can be
// skipped entirely. Conditions for skipping:
//   1. Cache exists, is non-synthetic, and was written during a live window
//   2. The most recent trading session's live window has NOT opened since the cache was written
//      (i.e. we're in the same session or no new session has started since last fetch)
// Always fetches if cache is >5 days old (multi-day gap / user returning after absence).
function _shouldSkipOptionsFetch(cacheKey){
  try{
    const existing=S.get(cacheKey);
    if(!existing||existing.synthetic)return false; // no cache or synthetic -- must fetch
    const ts=existing.ts;
    if(!ts)return false;
    const written=new Date(String(ts).replace(/ PT$| UTC$| local$/,'').trim());
    if(isNaN(written.getTime()))return false;

    const now=new Date();
    const ageMs=now.getTime()-written.getTime();
    if(ageMs>5*86400000)return false; // >5 days old -- always fetch

    const cutoffHourET=parseInt(S.get('options_cutoff_et')||'18');

    // Helper: get ET hour+min from a Date
    const etParts=d=>{
      const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'numeric',weekday:'short',hour12:false}).formatToParts(d);
      return{hour:parseInt(p.find(x=>x.type==='hour').value),min:parseInt(p.find(x=>x.type==='minute').value),weekday:p.find(x=>x.type==='weekday').value};
    };

    const w=etParts(written);
    const wMins=w.hour*60+w.min;
    const openMins=9*60+30; // 9:30am ET
    const cutoffMins=cutoffHourET*60;

    // Was cache written during a live window?
    const writtenInLiveWindow=wMins>=openMins&&wMins<cutoffMins&&w.weekday!=='Sat'&&w.weekday!=='Sun';
    if(!writtenInLiveWindow)return false; // cache not from a live window -- fetch

    // Has a new trading session opened since the cache was written?
    // Find the most recent 9:30am ET on a weekday on or before now
    const nowET=etParts(now);
    const nowMins=nowET.hour*60+nowET.min;

    // Count trading days between written date and now
    // Simple approach: if written today and no new session has opened, skip
    const writtenDate=written.toLocaleDateString('en-US',{timeZone:'America/New_York'});
    const todayDate=now.toLocaleDateString('en-US',{timeZone:'America/New_York'});
    const sameDay=writtenDate===todayDate;

    // If currently inside the live window, always allow fetch --
    // user may want freshest after-hours data before their configured cutoff
    const nowInLiveWindow=nowMins>=openMins&&nowMins<cutoffMins&&nowET.weekday!=='Sat'&&nowET.weekday!=='Sun';
    if(nowInLiveWindow)return false; // inside live window -- always fetch

    // Outside live window: skip if cache is from the same day's session
    if(sameDay)return true; // same day, outside window -- cache is the best available

    // Different day -- check if a new session has opened since the cache was written
    const isWeekday=nowET.weekday!=='Sat'&&nowET.weekday!=='Sun';
    const newSessionOpenedToday=isWeekday&&nowMins>=openMins;

    if(newSessionOpenedToday){
      // A new trading session has opened since the cache was written -- fetch fresh
      return false;
    }

    // No new session has opened (overnight, weekend, pre-market) -- skip
    return true;

  }catch{return false;} // on any error, default to fetching
}

// Options tab: load, build table, OI chart.
// Globals used: currentTicker, currentMode, selectedExpirations, currentOptionsData, WORKER_URL, S
// Dependencies: helpers.js, api.js, storage.js

function updateSlider(id){
  const slider=document.getElementById(id);
  const label=document.getElementById(id+'-val');
  if(!slider||!label)return;
  label.textContent=slider.value+'%';
  saveOptionsPrefs();
  if(currentOptionsData)buildOptionsTable();
}

function clearOptionsState(){
  document.getElementById('exp-section').style.display='none';
  document.getElementById('options-content').innerHTML='';
  document.getElementById('options-earnings-warn').innerHTML='';
  document.getElementById('oi-chart-section').style.display='none';
  const oia=document.getElementById('oi-analysis');if(oia)oia.innerHTML='';
  currentExpirations=[];selectedExpirations=[];currentOptionsData=null;lastOptionsTickerLoaded='';cachedOIRows=null;
  if(window._oiChart){window._oiChart.destroy();window._oiChart=null;}
}

function setMode(mode){
  currentMode=mode;
  document.getElementById('mode-puts').classList.toggle('active',mode==='puts');
  document.getElementById('mode-calls').classList.toggle('active',mode==='calls');
  loadOptionsPrefs(); // swap sliders to mode-specific saved values
  // Auto-rebuild table and OI chart if a chain is already loaded for THIS ticker
  // Guard also checks dropdown value matches loaded ticker to avoid rebuilding
  // with previous ticker's data while a new ticker is still loading
  const optSel=document.getElementById('options-ticker-select')?.value||'';
  if(currentOptionsData&&lastOptionsTickerLoaded&&optSel===lastOptionsTickerLoaded){
    buildOptionsTable();
  }
}

function toggleExp(e){
  if(selectedExpirations.includes(e)){selectedExpirations=selectedExpirations.filter(x=>x!==e);document.getElementById('chip-'+e)?.classList.remove('selected');}
  else{selectedExpirations.push(e);document.getElementById('chip-'+e)?.classList.add('selected');}
  // Instantly rebuild table and OI chart when chain already loaded for current ticker
  const optSelT=document.getElementById('options-ticker-select')?.value||'';
  if(currentOptionsData&&lastOptionsTickerLoaded&&optSelT===lastOptionsTickerLoaded)buildOptionsTable();
}

function loadOptionsPrefs(){
  // Load for current mode, with sensible defaults per mode
  const defBelow=currentMode==='puts'?'20':'5';
  const defAbove=currentMode==='puts'?'5':'20';
  const pb=S.get(`opts_pct_below_${currentMode}`)||defBelow;
  const pa=S.get(`opts_pct_above_${currentMode}`)||defAbove;
  const ha=S.get(`opts_hl_apy_${currentMode}`)||'12';
  document.getElementById('pct-below').value=pb;
  document.getElementById('pct-below-val').textContent=pb+'%';
  document.getElementById('pct-above').value=pa;
  document.getElementById('pct-above-val').textContent=pa+'%';
  document.getElementById('highlight-apy').value=ha;
}

function saveOptionsPrefs(){
  S.set(`opts_pct_below_${currentMode}`,document.getElementById('pct-below').value);
  S.set(`opts_pct_above_${currentMode}`,document.getElementById('pct-above').value);
  S.set(`opts_hl_apy_${currentMode}`,document.getElementById('highlight-apy').value);
}

async function loadOptionsForTicker(){
  const t=document.getElementById('options-ticker-select').value;if(!t){clearOptionsState();return;}
  // Repair: clear any synthetic per-expiry cache written outside the live window
  // so stale synthetic data doesn't display as real data
  if(!_isOptionsLiveWindow()){
    try{
      const _mainCache=S.get('options_'+t);
      if(_mainCache&&!_mainCache.synthetic){
        const _yr=_mainCache.data?.optionChain?.result?.[0];
        (_yr?.expirationDates||[]).forEach(_ets=>{
          const _ed=new Date(_ets*1000).toISOString().split('T')[0];
          const _ek='options_exp_'+t+'_'+_ed;
          const _ec=S.get(_ek);
          if(_ec?.synthetic){
            console.log(t+' '+_ed+': clearing synthetic per-expiry cache');
            S.del(_ek);
          }
        });
      }
    }catch{}
  }
  if(t!==currentTicker){currentTicker=t;S.set('last_ticker',t);document.getElementById('ticker-select').value=t;document.getElementById('ticker-content').innerHTML='<div class="empty"><div class="empty-icon">&#x1F4C8;</div>Ticker changed -- visit Ticker tab to reload</div>';}
  // Always clear stale OI chart and cached rows before fetching new ticker data
  // This prevents the previous ticker's OI chart from showing while new data loads
  cachedOIRows=null;
  document.getElementById('oi-chart-section').style.display='none';
  if(window._oiChart){window._oiChart.destroy();window._oiChart=null;}
  lastOptionsTickerLoaded=t;
  document.getElementById('exp-section').style.display='none';
  document.getElementById('options-content').innerHTML=`<div class="card"><div style="display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--text2)"><div class="spinner"></div>Loading options for ${t}...</div></div>`;
  try{
    let data,isLive=true,fetchTs=nowPT();
    let _debugPath='';
    const _skipFetch=_shouldSkipOptionsFetch('options_'+t);
    if(_skipFetch){
      // Cache is fresh from the most recent session -- skip network call entirely
      const cached=S.get('options_'+t);
      if(!cached)throw new Error('No options data available');
      data=cached.data;isLive=false;fetchTs=cached.ts;
      _debugPath='skipped fetch -- cache fresh from session (cached ts: '+cached.ts+')';
      console.log(t+': options loaded from cache (fresh session data)');
    }else{
      // Fetch live options data
      try{data=await yahooOptionsViaProxy(t);
        const _inWindow=_isOptionsLiveWindow();
        const _hasSameDay=_hasGoodSameDayCache('options_'+t);
        const _optVal=_validateOptionsData(data);
        if(_optVal.valid){
          // Validation passed -- write regardless of live window.
          // The window check was designed to block synthetic after-hours placeholder
          // data, but _validateOptionsData already catches that. If validation passes,
          // the data is real and should always overwrite stale cache.
          S.set('options_'+t,{data:slimOptionsData(data),ts:fetchTs});
          _debugPath='live fetch valid -- wrote fresh cache (ts: '+fetchTs+')';
        }else if(!_inWindow&&_hasSameDay){
          // Outside window AND validation failed -- preserve same-day cache
          // since the fresh fetch is synthetic/empty and we have something better.
          data=S.get('options_'+t).data;
          _debugPath='outside live window, fetch INVALID ('+_optVal.reason+') -- kept same-day cache';
        }else if(!S.get('options_'+t)){
          S.set('options_'+t,{data:slimOptionsData(data),ts:fetchTs,synthetic:true});
          _debugPath='live fetch INVALID ('+_optVal.reason+'), no prior cache -- wrote synthetic-flagged data anyway';
        }else{
          data=S.get('options_'+t).data;
          _debugPath='live fetch INVALID ('+_optVal.reason+') -- preserved existing good cache, discarded fresh fetch';
        }
      }catch(e){const cached=S.get('options_'+t);if(cached){data=cached.data;isLive=false;fetchTs=cached.ts;showOfflineBanner(cached.ts);_debugPath='fetch threw ('+(e?.message||'unknown error')+') -- fell back to cache';}else throw new Error('No options data available');}
    }
    if(S.get('debug_options_fetch')==='true')toast(t+' options: '+_debugPath,6000);
    currentOptionsData=data;
    const yr=data?.optionChain?.result?.[0];
    // Keep original Unix timestamps alongside date strings so we can pass
    // the exact timestamp back to Yahoo when fetching per-expiration data.
    // Yahoo is strict about timestamp matching -- using a converted date string
    // causes empty options arrays to be returned.
    const rawExpTimestamps=yr?.expirationDates||[];
    const allExpPairs=rawExpTimestamps.map(ts=>({
      ts,
      date:new Date(ts*1000).toISOString().split('T')[0]
    }));
    // Prefer standard monthly expirations (3rd Fri/Thu, 15th-21st)
    let monthlyPairs=allExpPairs.filter(p=>{const d=new Date(p.date+'T12:00:00Z');return(d.getUTCDay()===5||d.getUTCDay()===4)&&d.getUTCDate()>=15&&d.getUTCDate()<=21;}).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);
    if(monthlyPairs.length===0){
      const twoWeeksOut=Date.now()+14*86400000;
      monthlyPairs=allExpPairs.filter(p=>p.ts*1000>=twoWeeksOut).sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);
      if(monthlyPairs.length===0)monthlyPairs=allExpPairs.sort((a,b)=>a.date.localeCompare(b.date)).slice(0,3);
    }
    const monthly=monthlyPairs.map(p=>p.date);
    currentExpirations=monthly;selectedExpirations=[...monthly];
    // Per-expiry chains: skip fetch if main options were skipped (cache fresh)
    // Otherwise fetch all expiries in parallel
    if(!_skipFetch){
      await Promise.all(monthlyPairs.map(async pair=>{
        const _expKey='options_exp_'+t+'_'+pair.date;
        // Only apply the skip check when the main chain was served from cache.
        // If we just fetched the main chain live, force-refresh all per-expiry
        // chains too -- they share the same underlying data and must stay in sync.
        if(_skipFetch&&_shouldSkipOptionsFetch(_expKey))return;
        try{
          const ed=await yahooOptionsViaProxy(t,String(pair.ts));
          const _expInWindow=_isOptionsLiveWindow();
          const _expHasSameDay=_hasGoodSameDayCache(_expKey);
          const _expVal=_validateOptionsData(ed);
          if(_expVal.valid){
            // Validation passed -- write regardless of live window.
            S.set(_expKey,{...ed,ts:nowPT()});
            if(S.get('debug_options_fetch')==='true')toast(t+' '+pair.date+': exp fetch valid -- wrote fresh',4000);
          }else if(!_expInWindow&&_expHasSameDay){
            // Outside window AND invalid -- preserve same-day cache.
            if(S.get('debug_options_fetch')==='true')toast(t+' '+pair.date+': outside window, fetch INVALID ('+_expVal.reason+') -- kept same-day cache',5000);
          }else{
            const _existing=S.get(_expKey);
            const ok=_existing&&!_existing.synthetic;
            if(!ok){S.set(_expKey,{...ed,ts:nowPT(),synthetic:true});if(S.get('debug_options_fetch')==='true')toast(t+' '+pair.date+': exp INVALID ('+_expVal.reason+') no prior cache -- wrote synthetic',5000);}
            else{if(S.get('debug_options_fetch')==='true')toast(t+' '+pair.date+': exp INVALID ('+_expVal.reason+') -- kept stale cache',5000);console.warn(t+' '+pair.date+': rejecting fresh fetch ('+_expVal.reason+'), preserving cache from '+(_existing?.ts||'unknown ts'));}
          }
        }catch(e){if(S.get('debug_options_fetch')==='true')toast(t+' '+pair.date+': exp fetch ERROR: '+(e?.message||'unknown'),5000);console.warn(t+' '+pair.date+': exp fetch error',e?.message);}
      }));
    }
    const chipsEl=document.getElementById('exp-chips');
    chipsEl.innerHTML=monthly.map(e=>{
      const _ec=S.get('options_exp_'+t+'_'+e);
      const _ecTs=_ec?.ts;
      const _ecAge=_ecTs?relAge(_ecTs):'';
      const _ecTitle=_ecTs?('Cached '+_ecTs+(_ecAge?' ('+_ecAge+')':'')):'No timestamp (legacy cache)';
      return`<div class="exp-chip selected" id="chip-${e}" onclick="toggleExp('${e}')" title="${_ecTitle}">${e}</div>`;
    }).join('');
    document.getElementById('exp-section').style.display='block';
    loadOptionsPrefs();
    // Check for OI data availability -- show amber box if missing
    const hasOI=yr?.options?.[0]?.puts?.some(p=>(p.openInterest||0)>0)||yr?.options?.[0]?.calls?.some(c=>(c.openInterest||0)>0);
    if(!hasOI){
      const lastGood=S.get('options_'+t);
      document.getElementById('options-content').innerHTML=`<div class="oi-empty-box">Open Interest data is currently unavailable. This is normal when markets are closed -- OI data typically refreshes when the market opens the following business day.${lastGood?.ts?` Last known data: ${lastGood.ts} (${relAge(lastGood.ts)}).`:''} Load the options chain and the table will still show strikes and premiums; OI will appear as 0 until data refreshes.</div>`;
    }else{
      document.getElementById('options-content').innerHTML='';
    }
    if(!isLive){document.getElementById('options-content').innerHTML+=`<div style="font-family:var(--mono);font-size:10px;color:var(--warn);margin-bottom:8px">Cached options from ${fetchTs}${relAge(fetchTs)?' ('+relAge(fetchTs)+')':''}</div>`;}
    // Warn if options data is significantly newer than the ticker price snapshot
    const snapTs=S.get('snap_'+t)?.ts||'';
    if(isLive&&snapTs){
      try{
        const optAge=0;// just fetched
        const snapD=new Date(snapTs.replace(/ PT$| UTC$| local$/,'').trim());
        const snapAgeMins=isNaN(snapD.getTime())?0:(Date.now()-snapD.getTime())/60000;
        if(snapAgeMins>30){
          document.getElementById('options-content').innerHTML+=
            '<div style="background:rgba(255,165,2,0.08);border:1px solid rgba(255,165,2,0.3);border-radius:8px;padding:8px 12px;font-family:var(--mono);font-size:11px;color:var(--warn);margin-bottom:8px">'
            +'Note: options chain is live but ticker price ($'+S.get('snap_'+t)?.price?.toFixed(2)+') is from '+snapTs+' ('+(Math.round(snapAgeMins/60)*1)+'h ago). APY and % OTM use the cached price. Reload the Ticker tab for the latest price.'
            +'</div>';
        }
      }catch{}
    }
    const snap=S.get('snap_'+t);
    if(snap?.earningsDate){const today=new Date(),earningsD=new Date(snap.earningsDate);const warns=monthly.filter(e=>{const ed=new Date(e);return today<earningsD&&earningsD<=ed;});const timing=snap.earningsHour==='bmo'?' (before open)':snap.earningsHour==='amc'?' (after close)':'';const warnEl=document.getElementById('options-earnings-warn');warnEl.innerHTML=warns.length?`<div class="earnings-warn">Earnings on ${snap.earningsDate}${timing} falls within ${warns.join(', ')} window. Elevated assignment risk.</div>`:'';}
    lastOptionsTickerLoaded=t;
    // Auto-render the table now that data, chips, and prefs are all ready.
    // Without this, a fresh fetch after tab navigation is never reflected until
    // the user manually taps "Load / Refresh Options Chain".
    if(snap?.price) buildOptionsTable();
  }catch(err){document.getElementById('options-content').innerHTML=`<div class="card"><div style="font-family:var(--mono);font-size:12px;color:var(--red)">Error: ${err.message}</div></div>`;}
}

function restoreOIChartFromCache(){if(!lastOptionsTickerLoaded)return;const snap=S.get('snap_'+lastOptionsTickerLoaded);if(snap?.price){if(cachedOIRows){document.getElementById('oi-chart-section').style.display='block';renderOIChart(cachedOIRows,snap.price,lastOptionsTickerLoaded);}if(currentOptionsData)buildOptionsTable();}}

function buildOptionsTable(){
  const t=document.getElementById('options-ticker-select').value;if(!t||!currentOptionsData)return;
  const snap=S.get('snap_'+t);const currentPrice=snap?.price;if(!currentPrice){toast('Load ticker snapshot first');return;}
  const pctBelow=parseInt(document.getElementById('pct-below').value);
  const pctAbove=parseInt(document.getElementById('pct-above').value);
  const lowerBound=currentPrice*(1-pctBelow/100),upperBound=currentPrice*(1+pctAbove/100);
  const hlApy=parseFloat(document.getElementById('highlight-apy').value)||12;
  const today=new Date();const rows=[];
  for(const exp of selectedExpirations){
    const expCached=S.get('options_exp_'+t+'_'+exp);const res=expCached?.optionChain?.result?.[0];if(!res)continue;
    const expD=new Date(exp+'T12:00:00Z');const dte=Math.max(Math.round((expD-today)/86400000),1);
    const proc=(contracts,isCall)=>{if(!contracts)return;contracts.forEach(o=>{const s=o.strike||0;if(s<lowerBound||s>upperBound)return;const bid=o.bid||0,ask=o.ask||0,last=o.lastPrice||0,oi=o.openInterest||0,vol=o.volume||0,iv=o.impliedVolatility||0;const premium=(bid>0?bid:last)*100;const apy=isCall?premium/(currentPrice*100)*(365/dte)*100:premium/(s*100)*(365/dte)*100;const pctOTM=isCall?(s-currentPrice)/currentPrice*100:(currentPrice-s)/currentPrice*100;rows.push({expDate:exp,strike:s,bid,ask,last,premium,apy,oi,vol,iv,dte,pctOTM});});};
    if(currentMode==='puts')proc(res.options?.[0]?.puts,false);else proc(res.options?.[0]?.calls,true);
  }
  rows.sort((a,b)=>a.expDate.localeCompare(b.expDate)||a.strike-b.strike);
  if(!rows.length){document.getElementById('options-content').innerHTML='<div class="card"><div class="empty"><div class="empty-icon">&#x1F50D;</div>No options found in selected range</div></div>';document.getElementById('oi-chart-section').style.display='none';return;}
  cachedOIRows=rows;
    // Build rows HTML with:
  //   1. Colored expiration group header (date, DTE, color matches OI chart)
  //   2. Earnings banner inserted where earnings date falls relative to expirations
  //   3. Current-price separator within each group
  const expirations=[...new Set(rows.map(r=>r.expDate))].sort();
  let tableBodyHTML='';
  // today is already declared above in buildOptionsTable scope

  // Earnings info for banner
  const snap_for_opts=S.get('snap_'+t);
  const earningsDateStr=snap_for_opts?.earningsDate||null;
  const earningsHourStr=snap_for_opts?.earningsHour||null;
  const earningsTiming=earningsHourStr==='bmo'?' BMO':earningsHourStr==='amc'?' AMC':'';
  const earningsD=earningsDateStr?new Date(earningsDateStr+'T12:00:00Z'):null;
  let earningsBannerInserted=false;

  function earningsBanner(){
    if(!earningsDateStr||earningsBannerInserted)return'';
    earningsBannerInserted=true;
    const daysAway=daysUntilDate(earningsDateStr)??Math.round((earningsD-today)/86400000);
    return `<tr><td colspan="7" style="padding:0;border:none"><div style="background:rgba(255,165,2,0.1);border-left:3px solid rgba(255,165,2,0.7);padding:5px 10px;font-family:var(--mono);font-size:10px;color:var(--warn);font-weight:600">&#x1F4C5; Earnings ${earningsDateStr}${earningsTiming} &middot; ${daysAway}d away</div></td></tr>`;
  }

  const priceSepRow=`<tr><td colspan="7" style="padding:0;border:none">
    <div style="background:rgba(79,195,247,0.12);border-top:2px solid #4fc3f7;border-bottom:2px solid #4fc3f7;
    padding:4px 8px;font-family:var(--mono);font-size:10px;color:#4fc3f7;font-weight:600;text-align:center;letter-spacing:0.5px">
    NOW $${currentPrice.toFixed(2)}</div></td></tr>`;

  function rowHTML(r){
    const hl=r.apy>=hlApy;
    const apyCls=r.apy>=hlApy*1.5?'apy-cell great':r.apy>=hlApy?'apy-cell':'';
    return `<tr class="${hl?'highlighted':''}">
      <td>${r.expDate}<br><span style="color:var(--accent);font-size:12px">$${formatStrike(r.strike)}</span></td>
      <td style="color:var(--text2)">${r.pctOTM.toFixed(1)}%</td>
      <td><span style="display:block">$${r.bid.toFixed(2)}</span><span style="display:block;color:var(--text3);font-size:10px">$${r.ask.toFixed(2)}</span></td>
      <td>$${r.premium.toFixed(0)}</td>
      <td class="${apyCls}">${r.apy.toFixed(1)}%</td>
      <td>${r.oi.toLocaleString()}</td>
      <td>${(r.iv*100).toFixed(1)}%</td></tr>`;
  }

  expirations.forEach((exp,ei)=>{
    const expRows=rows.filter(r=>r.expDate===exp).sort((a,b)=>a.strike-b.strike);
    const expD=new Date(exp+'T12:00:00Z');
    const dte=Math.max(Math.round((expD-today)/86400000),0);
    const expColor=EXP_COLORS[ei%EXP_COLORS.length];
    // Format expiration date for display
    const expLabel=expD.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});

    // Insert earnings banner BEFORE this expiration header if earnings falls before this expiry
    // and has not been inserted yet
    if(earningsD&&!earningsBannerInserted&&earningsD<expD){
      tableBodyHTML+=earningsBanner();
    }

    // Expiration group header row -- pre-compute RGB to avoid regex inside template literal
    const hx=expColor.replace('#','');
    const er=parseInt(hx.substring(0,2),16);
    const eg=parseInt(hx.substring(2,4),16);
    const eb=parseInt(hx.substring(4,6),16);
    tableBodyHTML+='<tr><td colspan="7" style="padding:0;border:none"><div style="background:rgba('+er+','+eg+','+eb+',0.12);border-left:4px solid '+expColor+';border-top:1px solid '+expColor+'44;padding:6px 10px;font-family:var(--mono);font-size:11px;color:'+expColor+';font-weight:600;display:flex;justify-content:space-between;align-items:center"><span>'+expLabel+'</span><span style="font-size:13px;letter-spacing:0.5px">DTE: '+dte+'</span></div></td></tr>';

    // Insert earnings banner INSIDE this group if earnings falls within this expiry window
    // (after prev expiry and before this expiry -- already checked above for between-group case)
    // Here check if earnings is AFTER prev expiry but this is first group (no prev expiry)
    if(earningsD&&!earningsBannerInserted&&earningsD<=expD){
      tableBodyHTML+=earningsBanner();
    }

    // Current price separator
    const sepIdx=expRows.findIndex(r=>r.strike>currentPrice);
    if(sepIdx===-1){
      expRows.forEach(r=>{tableBodyHTML+=rowHTML(r);});
      tableBodyHTML+=priceSepRow;
    }else if(sepIdx===0){
      tableBodyHTML+=priceSepRow;
      expRows.forEach(r=>{tableBodyHTML+=rowHTML(r);});
    }else{
      expRows.forEach((r,i)=>{
        if(i===sepIdx)tableBodyHTML+=priceSepRow;
        tableBodyHTML+=rowHTML(r);
      });
    }
  });

  // Earnings banner after all expirations if not yet inserted
  if(earningsD&&!earningsBannerInserted){tableBodyHTML+=earningsBanner();}
  const tableHTML=`<div class="card"><div class="card-title"><span class="dot"></span>${currentMode==='puts'?'Put':'Call'} Options -- ${t} @ $${currentPrice.toFixed(2)}</div>${(()=>{const optCache=S.get('options_'+t);const optTs=optCache?.ts||'';if(!optTs)return'';const isOptLive=optTs&&(Date.now()-new Date(optTs.replace(/ PT$| UTC$| local$/,'').trim()).getTime())<900000;return tsChip(optTs,isOptLive);})()}<div class="options-table-wrap"><table class="options-table"><thead><tr><th>Exp / Strike</th><th>% OTM</th><th>Bid/Ask</th><th>Premium</th><th>APY</th><th>OI</th><th>IV</th></tr></thead><tbody>${tableBodyHTML}</tbody></table></div></div>`;
  document.getElementById('options-content').innerHTML=tableHTML;renderOIChart(rows,currentPrice,t);
}

function renderOIChart(rows,currentPrice,t){
  const section=document.getElementById('oi-chart-section');section.style.display='block';
  const strikes=[...new Set(rows.map(r=>r.strike))].sort((a,b)=>a-b);
  const exps=[...new Set(rows.map(r=>r.expDate))].filter(e=>selectedExpirations.includes(e)).sort();

  const labels=strikes.map(s=>'$'+formatStrike(s));
  const nearestIdx=strikes.reduce((bi,s,i)=>Math.abs(s-currentPrice)<Math.abs(strikes[bi]-currentPrice)?i:bi,0);
  const hexDatasets=exps.map((exp,ei)=>{const hex=EXP_COLORS[ei%EXP_COLORS.length];const data=strikes.map(s=>{const row=rows.find(r=>r.strike===s&&r.expDate===exp);return row?row.oi:0;});return{label:exp,data,backgroundColor:strikes.map(s=>{const otm=currentMode==='puts'?s<=currentPrice:s>currentPrice;return otm?hex+'bb':hex+'44';}),borderRadius:2,stack:'oi'};});
  const cached=S.get('options_'+t);
  document.getElementById('oi-ts').innerHTML=tsChip(cached?.ts||nowPT(),!!cached?.ts);
  const legendEl=document.getElementById('oi-legend');if(legendEl){legendEl.innerHTML=exps.map((exp,ei)=>`<div style="display:flex;align-items:center;gap:4px;font-family:var(--mono);font-size:10px;color:var(--text2)"><div style="width:10px;height:10px;border-radius:2px;background:${EXP_COLORS[ei%EXP_COLORS.length]}"></div>${exp}</div>`).join('');}
  const ctx=document.getElementById('oi-chart').getContext('2d');
  if(window._oiChart){window._oiChart.destroy();window._oiChart=null;}
  // Use requestAnimationFrame to ensure canvas is ready after destroy
  requestAnimationFrame(()=>{
  window._oiChart=new Chart(ctx,{type:'bar',data:{labels,datasets:hexDatasets},options:{responsive:true,maintainAspectRatio:false,layout:{padding:{top:20}},plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()} OI`,afterLabel:ctx=>{const s=strikes[ctx.dataIndex];const pct=currentMode==='puts'?((currentPrice-s)/currentPrice*100).toFixed(1):((s-currentPrice)/currentPrice*100).toFixed(1);return`${pct}% OTM`;}}}},scales:{x:{stacked:true,ticks:{color:'#555870',font:{size:9},maxRotation:45},grid:{color:'#2a2e38'}},y:{stacked:true,ticks:{color:'#555870',font:{size:9}},grid:{color:'#2a2e38'}}}},plugins:[{id:'currentPriceLine',afterDraw(chart){const c=chart.ctx,xA=chart.scales.x,yA=chart.scales.y;const x=xA.getPixelForValue(nearestIdx);c.save();c.beginPath();c.moveTo(x,yA.top+18);c.lineTo(x,yA.bottom);c.lineWidth=2;c.strokeStyle='#4fc3f7';c.setLineDash([5,4]);c.stroke();c.setLineDash([]);c.fillStyle='#4fc3f7';c.font='bold 10px DM Mono,monospace';c.textAlign='center';c.fillText('$'+currentPrice.toFixed(0),x,yA.top+14);c.restore();}}]});
  const byS=strikes.map((s,i)=>({strike:s,oi:hexDatasets.reduce((sum,ds)=>sum+(ds.data[i]||0),0)}));
  const oiEl=document.getElementById('oi-analysis');
  if(oiEl){let html='';
    if(currentMode==='puts'){const below=byS.filter(x=>x.strike<=currentPrice);if(below.length){const max=below.reduce((b,x)=>x.oi>b.oi?x:b,below[0]);const pct=((currentPrice-max.strike)/currentPrice*100).toFixed(1);const guide=pct<5?'Very close -- high assignment risk. Consider a wider strike.':pct<=12?'Ideal 5-12% OTM zone -- good balance of premium and safety.':'Deep OTM -- premium thin. Consider a closer strike.';html=`<div class="commentary" style="margin-top:10px">Put OI Analysis:
Highest OI below price: $${formatStrike(max.strike)} (${pct}% OTM) with ${max.oi.toLocaleString()} contracts.
Market makers must buy shares if price falls here -- natural support floor. Target your put at or just above $${formatStrike(max.strike)}.
${guide}
Bars stacked by expiration (see legend). Blue dashed line = current price $${currentPrice.toFixed(2)}.</div>`;}}
    else{const above=byS.filter(x=>x.strike>currentPrice);if(above.length){const max=above.reduce((b,x)=>x.oi>b.oi?x:b,above[0]);const pct=((max.strike-currentPrice)/currentPrice*100).toFixed(1);const guide=pct<5?'Very close -- high early assignment risk. Consider wider.':pct<=12?'Ideal 5-12% OTM zone -- good buffer before assignment.':'Deep OTM -- premium thin. Consider a closer strike.';html=`<div class="commentary" style="margin-top:10px">Call OI Analysis:
Highest OI above price: $${formatStrike(max.strike)} (${pct}% OTM) with ${max.oi.toLocaleString()} contracts.
Market makers must sell shares if price rises here -- natural resistance ceiling. Target your covered call at or just below $${formatStrike(max.strike)}.
${guide}
Bars stacked by expiration (see legend). Blue dashed line = current price $${currentPrice.toFixed(2)}.</div>`;}}
    oiEl.innerHTML=html;
  }
  }); // end requestAnimationFrame
}
