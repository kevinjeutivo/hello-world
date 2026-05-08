// PutSeller Pro -- ui.js
// UI helpers: market banner, status indicators, toast, tab navigation.
// Globals used: tzPref, offlineMode, vixThreshold, currentTicker, watchlist, S
// Dependencies: helpers.js, storage.js

function isNYSEHoliday(etDateObj){
  // Takes a Date object, checks holiday in ET
  const fmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
  const parts=fmt.formatToParts(etDateObj);
  const y=parts.find(p=>p.type==='year').value;
  const mo=parts.find(p=>p.type==='month').value;
  const da=parts.find(p=>p.type==='day').value;
  return NYSE_HOLIDAYS.has(`${y}-${mo}-${da}`);
}

function getETComponents(){
  // Use Intl.DateTimeFormat to reliably extract ET time components on all browsers
  const now=new Date();
  const fmt=new Intl.DateTimeFormat('en-US',{
    timeZone:'America/New_York',
    hour:'2-digit',minute:'2-digit',second:'2-digit',
    weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',
    hour12:false
  });
  const parts=fmt.formatToParts(now);
  const get=type=>parseInt(parts.find(p=>p.type===type)?.value||'0');
  const getStr=type=>parts.find(p=>p.type===type)?.value||'';
  let hour=get('hour');
  // Intl hour12:false returns 24 for midnight on some platforms -- normalize
  if(hour===24)hour=0;
  const min=get('minute');
  const sec=get('second');
  const weekday=getStr('weekday'); // 'Sun','Mon',...
  const isWeekend=(weekday==='Sun'||weekday==='Sat');
  return{now,hour,min,sec,isWeekend,totalMins:hour*60+min};
}

function getMarketState(){
  const et=getETComponents();
  const{now,hour,min,sec,isWeekend,totalMins}=et;
  if(isWeekend)return{state:'closed',reason:'weekend',now,sec};
  if(isNYSEHoliday(now))return{state:'closed',reason:'holiday',now,sec};
  // Market hours ET: open 9:30 (570 mins) to 16:00 (960 mins)
  if(totalMins>=570&&totalMins<960)return{state:'open',totalMins,sec,now};
  if(totalMins>=240&&totalMins<570)return{state:'premarket',totalMins,sec,now};
  if(totalMins>=960&&totalMins<1200)return{state:'afterhours',totalMins,sec,now};
  return{state:'closed',reason:'overnight',now,sec};
}

function minsToHHMM(m){const h=Math.floor(m/60);const mm=m%60;return h>0?`${h}h ${mm}m`:`${mm}m`;}

function secsToMMSS(s){return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}

function etTimeToDisplay(etHour,etMin){
  // Build a Date object for today at the given ET hour:min
  const now=new Date();
  // Get today's date in ET
  const etFmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
  const etParts=etFmt.formatToParts(now);
  const etY=etParts.find(p=>p.type==='year').value;
  const etMo=etParts.find(p=>p.type==='month').value;
  const etDa=etParts.find(p=>p.type==='day').value;
  // Create a UTC date for this ET time today
  // ET is UTC-4 (EDT) or UTC-5 (EST). Use Intl to get the offset indirectly.
  const etMidnight=new Date(`${etY}-${etMo}-${etDa}T${String(etHour).padStart(2,'0')}:${String(etMin).padStart(2,'0')}:00`);
  // Display in chosen timezone
  const tz=tzPref==='PT'?'America/Los_Angeles':tzPref==='UTC'?'UTC':Intl.DateTimeFormat().resolvedOptions().timeZone;
  const displayFmt=new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'numeric',minute:'2-digit',hour12:true});
  const tzLabel=tzPref==='PT'?'PT':tzPref==='UTC'?'UTC':'local';
  // The etMidnight date was created in LOCAL time, not ET. We need proper ET->display conversion.
  // Better: use the actual now moment and compute the close time as now + minsLeft
  return null; // signal to use minsLeft instead
}

function updateMarketBanner(){
  const banner=document.getElementById('market-status-banner');
  const ms=getMarketState();
  const tz=typeof tzPref!=='undefined'?(tzPref==='PT'?'America/Los_Angeles':tzPref==='UTC'?'UTC':Intl.DateTimeFormat().resolvedOptions().timeZone):'America/Los_Angeles';
  const tzLabel=typeof tzPref!=='undefined'?(tzPref==='UTC'?'UTC':tzPref==='local'?'local':'PT'):'PT';

  if(ms.state==='open'){
    const minsLeft=960-ms.totalMins;
    const secsLeft=minsLeft*60-ms.sec;
    const inFinal10=minsLeft<=10;
    banner.className='mkt-open';
    // Show close time in selected timezone
    const closeTime=new Date(ms.now.getTime()+secsLeft*1000);
    const closeFmt=new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'numeric',minute:'2-digit',hour12:true});
    const closeStr=closeFmt.format(closeTime);
    if(inFinal10){
      banner.textContent=`MARKET OPEN -- closes in ${secsToMMSS(secsLeft)} (at ${closeStr} ${tzLabel})`;
    }else{
      banner.textContent=`MARKET OPEN -- closes in ${minsToHHMM(minsLeft)} (at ${closeStr} ${tzLabel})`;
    }
  }else if(ms.state==='premarket'){
    const minsUntilOpen=570-ms.totalMins;
    const openTime=new Date(ms.now.getTime()+minsUntilOpen*60000);
    const openFmt=new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'numeric',minute:'2-digit',hour12:true});
    banner.className='mkt-prepost';
    banner.textContent=`Pre-market -- opens in ${minsToHHMM(minsUntilOpen)} (at ${openFmt.format(openTime)} ${tzLabel})`;
  }else if(ms.state==='afterhours'){
    const minsLeft=1200-ms.totalMins;
    banner.className='mkt-prepost';
    banner.textContent=`After-hours -- extended session ends in ${minsToHHMM(minsLeft)}`;
  }else{
    // Find next NYSE open: scan forward day by day from current ET date
    // Strategy: for each candidate day, construct 9:30 AM ET as a real UTC Date
    // by binary-searching the offset. We do this by checking what UTC time
    // corresponds to 9:30 AM on that ET calendar date.
    const now=ms.now;
    // Get current ET date components
    const etFmt2=new Intl.DateTimeFormat('en-US',{
      timeZone:'America/New_York',
      year:'numeric',month:'2-digit',day:'2-digit'
    });
    // Build a candidate 9:30 AM ET time for a given calendar date string 'YYYY-MM-DD'
    // by trying UTC offsets until Intl confirms it's 9:30 in ET
    function make930ET(etDateStr){
      // Try UTC offsets -5 (EST) and -4 (EDT)
      for(const offsetH of [4,5]){
        // 9:30 AM ET = 9:30 + offsetH in UTC
        const utcH=9+offsetH;
        const candidate=new Date(`${etDateStr}T${String(utcH).padStart(2,'0')}:30:00Z`);
        // Verify this is actually 9:30 AM ET using Intl
        const parts=new Intl.DateTimeFormat('en-US',{
          timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false
        }).formatToParts(candidate);
        const h=parseInt(parts.find(p=>p.type==='hour').value);
        const m=parseInt(parts.find(p=>p.type==='minute').value);
        if(h===9&&m===30)return candidate;
      }
      // Fallback: assume EDT (UTC-4)
      return new Date(`${etDateStr}T13:30:00Z`);
    }

    // Start with today's ET date
    const todayParts=etFmt2.formatToParts(now);
    const etY=todayParts.find(p=>p.type==='year').value;
    const etMo=todayParts.find(p=>p.type==='month').value;
    const etDa=todayParts.find(p=>p.type==='day').value;
    let etDateStr=`${etY}-${etMo}-${etDa}`;

    let nextOpen=make930ET(etDateStr);
    // If 9:30 AM ET today is already past, move to next day
    if(nextOpen<=now){
      const d=new Date(nextOpen.getTime()+86400000);
      const p=etFmt2.formatToParts(d);
      etDateStr=`${p.find(q=>q.type==='year').value}-${p.find(q=>q.type==='month').value}-${p.find(q=>q.type==='day').value}`;
      nextOpen=make930ET(etDateStr);
    }
    // Skip weekends and holidays
    let safety=0;
    while(safety<10){
      const wd=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',weekday:'short'}).format(nextOpen);
      if(wd==='Sat'||wd==='Sun'||isNYSEHoliday(nextOpen)){
        const d=new Date(nextOpen.getTime()+86400000);
        const p=etFmt2.formatToParts(d);
        etDateStr=`${p.find(q=>q.type==='year').value}-${p.find(q=>q.type==='month').value}-${p.find(q=>q.type==='day').value}`;
        nextOpen=make930ET(etDateStr);
        safety++;
      }else break;
    }
    const diffMs=nextOpen-now;
    const diffH=Math.floor(diffMs/3600000);
    const diffM=Math.floor((diffMs%3600000)/60000);
    const openDisplayFmt=new Intl.DateTimeFormat('en-US',{
      timeZone:tz,weekday:'short',month:'short',day:'numeric',
      hour:'numeric',minute:'2-digit',hour12:true
    });
    banner.className='mkt-closed';
    banner.textContent=`Market closed -- opens in ${diffH}h ${diffM}m (${openDisplayFmt.format(nextOpen)} ${tzLabel})`;
  }
}

function updateOnlineIndicator(){
  const dot=document.getElementById('online-dot');
  if(!dot)return;
  dot.className=navigator.onLine?'online-dot online-dot-on':'online-dot online-dot-off';
}

function showOfflineBanner(fetchTs){
  // Only show the offline banner when the device is genuinely offline.
  // Transient fetch errors while online (rate limits, timeouts) should not
  // trigger the banner -- they are handled silently by falling back to cache.
  if(navigator.onLine)return;
  const b=document.getElementById('offline-banner');
  const age=relAge(fetchTs);
  b.textContent=`Offline -- showing cached data${fetchTs?` from ${fetchTs}${age?' ('+age+')':''}`:''}.`;
  b.classList.add('show');
  setTimeout(()=>b.classList.remove('show'),4500);
}

function updateVIXIndicator(vixValue){
  const tabBtn=document.getElementById('vix-tab-btn');
  const banner=document.getElementById('vix-status-banner');
  const existing=tabBtn?.querySelector('.vix-dot');
  if(existing)existing.remove();
  if(banner){banner.style.display='none';banner.className='';}
  if(!vixValue||vixValue<vixThreshold)return;
  let dotClass,bannerClass,label;
  if(vixValue>=40){dotClass='vix-dot vix-dot-extreme';bannerClass='vix-status-extreme';label=`VIX ${vixValue.toFixed(1)} EXTREME`;}
  else if(vixValue>=30){dotClass='vix-dot vix-dot-high';bannerClass='vix-status-high';label=`VIX ${vixValue.toFixed(1)} FEAR SPIKE`;}
  else{dotClass='vix-dot vix-dot-elevated';bannerClass='vix-status-elevated';label=`VIX ${vixValue.toFixed(1)} ELEVATED`;}
  if(tabBtn){const dot=document.createElement('span');dot.className=dotClass;tabBtn.appendChild(dot);}
  if(banner){banner.textContent=label;banner.className=bannerClass;banner.style.display='block';}
}

function toast(msg,dur=2500){
  const el=document.getElementById('toast');
  el.style.whiteSpace='normal';
  el.style.maxWidth='92vw';
  el.style.fontSize='11px';
  el.textContent=msg;
  el.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer=setTimeout(()=>el.classList.remove('show'),dur);
}

function updateHeaderStatus(){
  // Green = all core data fresh (<30min), amber = some stale, spinner = refreshing
  const dot=document.getElementById('header-status-dot');
  if(!dot)return;
  const tickers=watchlist.slice(0,5); // sample first 5
  let allFresh=true,anyData=false;
  const now=Date.now();
  tickers.forEach(t=>{
    const snap=S.get('snap_'+t);
    if(snap?.ts){
      anyData=true;
      try{
        const isoAttr=document.querySelector('.ts-chip')?.getAttribute('data-ts-iso');
        const snapD=new Date(snap.ts.replace(/ PT$| UTC$| local$/,'').trim());
        if(!isNaN(snapD.getTime())){
          const ageMins=(now-snapD.getTime())/60000;
          if(ageMins>30)allFresh=false;
        }
      }catch{}
    }
  });
  if(!anyData){dot.style.background='#555870';dot.title='No data cached';}
  else if(allFresh){dot.style.background='#00d4aa';dot.title='Data is fresh';}
  else{dot.style.background='#ff9800';dot.title='Some data is stale -- refresh recommended';}
  // Show last full refresh time
  const lts=S.get('last_full_refresh_ts');
  const lbl=document.getElementById('last-full-refresh-label');
  if(lbl&&lts){const age=relAge(lts);lbl.textContent='Last full refresh: '+lts+(age?' ('+age+')':'');}
}

function setTopBar(pct){
  const bar=document.getElementById('top-bar-fill');
  const wrap=document.getElementById('top-progress-bar');
  if(!bar||!wrap)return;
  if(pct===null){
    // Hide
    wrap.classList.remove('active');
    bar.style.width='100%';
    setTimeout(()=>{bar.style.transition='none';bar.style.width='0%';wrap.style.display='none';setTimeout(()=>{bar.style.transition='width 0.3s ease';},50);},400);
  }else{
    wrap.style.display='block';
    wrap.classList.add('active');
    bar.style.width=Math.min(pct,99)+'%';
  }
}

function setRefreshSpinner(active){
  const dot=document.getElementById('header-status-dot');
  if(!dot)return;
  if(active){
    dot.style.background='#4fc3f7';
    dot.style.animation='pulse 1s infinite';
    dot.title='Refreshing...';
    setTopBar(2); // start bar at 2% so it's immediately visible
  }else{
    dot.style.animation='';
    setTopBar(null); // complete and hide
    updateHeaderStatus();
  }
}

function refreshTsChipAges(){
  // Re-compute relative age on all ts-chips using data-ts-iso for reliable parsing.
  // data-ts-iso is set by tsChip() at render time as a true ISO timestamp.
  // Falls back to parsing the display text if attribute is absent (legacy chips).
  const STALE_MINS=15;
  document.querySelectorAll('.ts-chip').forEach(chip=>{
    // Prefer ISO attribute for age computation -- always parseable
    const isoAttr=chip.getAttribute('data-ts-iso');
    const displayTs=chip.getAttribute('data-ts-display')||'';
    let ageMins=Infinity;
    if(isoAttr){
      try{ageMins=(Date.now()-new Date(isoAttr).getTime())/60000;}catch{}
    }else{
      // Legacy fallback: try to parse display text
      try{
        const text=chip.textContent||'';
        const match=text.match(/^(?:live|cached)\s+(.+?)(?:\s+\(.*\))?$/);
        if(match){
          const clean=match[1].trim().replace(/ PT$| UTC$| local$/,'');
          const d=new Date(clean);
          if(!isNaN(d.getTime()))ageMins=(Date.now()-d.getTime())/60000;
        }
      }catch{}
    }
    const shouldBeStale=ageMins>STALE_MINS;
    if(shouldBeStale){chip.classList.remove('live');chip.classList.add('stale');}
    // Recompute age text using display timestamp
    const tsStr=displayTs||'';
    const age=relAge(tsStr);
    const prefix=chip.classList.contains('live')?'live':'cached';
    chip.textContent=`${prefix} ${tsStr||'unknown'}${age?' ('+age+')':''}`;
  });
}

function showTab(name){
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  const tabs=['dashboard','watchlist','ticker','options','vix','earnings','etf','market','guide'];
  document.querySelectorAll('.nav-tab')[tabs.indexOf(name)].classList.add('active');
  // Refresh all age labels whenever user switches tabs
  refreshTsChipAges();
  if(name==='watchlist')renderWatchlist();
  if(name==='ticker'&&currentTicker){
    document.getElementById('ticker-select').value=currentTicker;
    const c=document.getElementById('ticker-content');
    if(!c||c.querySelector('.empty'))restoreTickerFromCache(currentTicker);
  }
  if(name==='options'&&currentTicker){
    document.getElementById('options-ticker-select').value=currentTicker;
    if(currentTicker!==lastOptionsTickerLoaded)loadOptionsForTicker();
    else restoreOIChartFromCache();
  }
  if(name==='vix'){const vc=document.getElementById('vix-content');if(!vc||vc.querySelector('.empty'))restoreVIXFromCache();}
  if(name==='earnings'){const ec=document.getElementById('earnings-content');if(!ec||ec.querySelector('.empty'))renderEarningsCards();}
  if(name==='etf'){const etc=document.getElementById('etf-content');if(!etc||etc.querySelector('.empty'))restoreETFFromCache();}
  if(name==='market'){const mc=document.getElementById('market-content');if(!mc||mc.querySelector('.empty'))restoreMarketFromCache();}
}
