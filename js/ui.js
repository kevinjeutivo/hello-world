// PutSeller Pro -- ui.js
// UI helpers: market banner, status indicators, toast, tab navigation.
// Globals used: tzPref, offlineMode, vixThreshold, currentTicker, watchlist, S
// Dependencies: helpers.js, storage.js

// ── NYSE Holiday computation ──────────────────────────────────────────────────
// Replaces the old hardcoded NYSE_HOLIDAYS Set with a function that computes
// holidays algorithmically for any year.  No maintenance required, works
// offline forever.
//
// Observation rule (same for all NYSE holidays):
//   If the holiday falls on Saturday → observed Friday
//   If the holiday falls on Sunday   → observed Monday
//
// Rules by holiday:
//   New Year's Day   Jan 1 (observed)
//   MLK Day          3rd Monday of January
//   Presidents' Day  3rd Monday of February
//   Good Friday      Friday before Easter (computed via Anonymous Gregorian)
//   Memorial Day     last Monday of May
//   Juneteenth       Jun 19 (observed) -- if Sat → Fri Jun 18, if Sun → Mon Jun 20
//   Independence Day Jul 4 (observed)
//   Labor Day        1st Monday of September
//   Thanksgiving     4th Thursday of November
//   Christmas        Dec 25 (observed)

function _observed(date){
  // Returns the NYSE-observed date for a holiday that falls on a fixed calendar date.
  // date is a Date object at noon UTC to avoid DST edge cases.
  const dow=date.getUTCDay(); // 0=Sun 6=Sat
  if(dow===6)return new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()-1));
  if(dow===0)return new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()+1));
  return date;
}

function _nthWeekday(year,month,weekday,n){
  // Returns the date of the nth occurrence of weekday (0=Sun..6=Sat)
  // in the given month (0-indexed) of year.
  // n=1 → first, n=2 → second, etc.
  // n=-1 → last occurrence.
  if(n>0){
    const first=new Date(Date.UTC(year,month,1));
    const diff=(weekday-first.getUTCDay()+7)%7;
    return new Date(Date.UTC(year,month,1+diff+(n-1)*7));
  }else{
    // last occurrence: start from end of month
    const last=new Date(Date.UTC(year,month+1,0)); // last day of month
    const diff=(last.getUTCDay()-weekday+7)%7;
    return new Date(Date.UTC(year,month,last.getUTCDate()-diff));
  }
}

function _easter(year){
  // Anonymous Gregorian algorithm -- returns Easter Sunday as a UTC noon Date.
  const a=year%19;
  const b=Math.floor(year/100);
  const c=year%100;
  const d=Math.floor(b/4);
  const e=b%4;
  const f=Math.floor((b+8)/25);
  const g=Math.floor((b-f+1)/3);
  const h=(19*a+b-d-g+15)%30;
  const i=Math.floor(c/4);
  const k=c%4;
  const l=(32+2*e+2*i-h-k)%7;
  const m=Math.floor((a+11*h+22*l)/451);
  const month=Math.floor((h+l-7*m+114)/31)-1; // 0-indexed
  const day=((h+l-7*m+114)%31)+1;
  return new Date(Date.UTC(year,month,day));
}

function _computeNYSEHolidays(year){
  // Returns a Set of 'YYYY-MM-DD' strings for NYSE holidays in the given year.
  const holidays=new Set();

  function add(date){
    // date is a Date object -- store as YYYY-MM-DD
    const y=date.getUTCFullYear();
    const m=String(date.getUTCMonth()+1).padStart(2,'0');
    const d=String(date.getUTCDate()).padStart(2,'0');
    holidays.add(`${y}-${m}-${d}`);
  }

  // New Year's Day -- Jan 1 (observed)
  add(_observed(new Date(Date.UTC(year,0,1))));

  // MLK Day -- 3rd Monday of January
  add(_nthWeekday(year,0,1,3));

  // Presidents' Day -- 3rd Monday of February
  add(_nthWeekday(year,1,1,3));

  // Good Friday -- Friday before Easter Sunday
  const easter=_easter(year);
  const goodFriday=new Date(Date.UTC(easter.getUTCFullYear(),easter.getUTCMonth(),easter.getUTCDate()-2));
  add(goodFriday);

  // Memorial Day -- last Monday of May
  add(_nthWeekday(year,4,1,-1));

  // Juneteenth -- Jun 19 (observed)
  // If Sat → observed Fri Jun 18; if Sun → observed Mon Jun 20
  add(_observed(new Date(Date.UTC(year,5,19))));

  // Independence Day -- Jul 4 (observed)
  add(_observed(new Date(Date.UTC(year,6,4))));

  // Labor Day -- 1st Monday of September
  add(_nthWeekday(year,8,1,1));

  // Thanksgiving -- 4th Thursday of November
  add(_nthWeekday(year,10,4,4));

  // Christmas -- Dec 25 (observed)
  add(_observed(new Date(Date.UTC(year,11,25))));

  return holidays;
}

// Cache computed holiday sets by year so we don't recompute on every banner tick.
const _holidayCache={};

function isNYSEHoliday(etDateObj){
  // etDateObj is a Date object; we check its calendar date in ET.
  const fmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
  const parts=fmt.formatToParts(etDateObj);
  const y=parseInt(parts.find(p=>p.type==='year').value);
  const mo=parts.find(p=>p.type==='month').value;
  const da=parts.find(p=>p.type==='day').value;
  if(!_holidayCache[y])_holidayCache[y]=_computeNYSEHolidays(y);
  return _holidayCache[y].has(`${y}-${mo}-${da}`);
}

// ── Market state ──────────────────────────────────────────────────────────────

function getETComponents(){
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
  if(hour===24)hour=0;
  const min=get('minute');
  const sec=get('second');
  const weekday=getStr('weekday');
  const isWeekend=(weekday==='Sun'||weekday==='Sat');
  return{now,hour,min,sec,isWeekend,totalMins:hour*60+min};
}

function getMarketState(){
  const et=getETComponents();
  const{now,hour,min,sec,isWeekend,totalMins}=et;
  if(isWeekend)return{state:'closed',reason:'weekend',now,sec};
  if(isNYSEHoliday(now))return{state:'closed',reason:'holiday',now,sec};
  if(totalMins>=570&&totalMins<960)return{state:'open',totalMins,sec,now};
  if(totalMins>=240&&totalMins<570)return{state:'premarket',totalMins,sec,now};
  if(totalMins>=960&&totalMins<1200)return{state:'afterhours',totalMins,sec,now};
  return{state:'closed',reason:'overnight',now,sec};
}

// Returns the closing time of the NYSE session in ET minutes since midnight.
// Normal close: 960 (4:00pm ET). Early close: 780 (1:00pm ET).
// Early close days are always the trading day immediately before certain holidays:
// Independence Day (Jul 4), Thanksgiving (day after), Christmas (Dec 25), New Year's.
function _getSessionCloseMins(etDateObj){
  const fmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'numeric',day:'numeric',year:'numeric'});
  const parts=fmt.formatToParts(etDateObj);
  const mo=parseInt(parts.find(p=>p.type==='month').value);
  const dy=parseInt(parts.find(p=>p.type==='day').value);
  const yr=parseInt(parts.find(p=>p.type==='year').value);
  // Check if this date is an early close day (day before a holiday)
  // Early close is 1pm ET = 780 mins
  // Day before Independence Day (Jul 3, or Fri if Jul 4 is Sat, or Mon if Jul 4 is Sun -- but market doesn't close early on Mon, just Jul 3/Fri)
  const dow=etDateObj.toLocaleDateString('en-US',{timeZone:'America/New_York',weekday:'short'});
  // Jul 3 (or Fri before Jul 5 when Jul 4 is Sat) -- early close
  if(mo===7&&dy===3)return 780;
  if(mo===7&&dy===2&&dow==='Fri')return 780; // Fri when Jul 4 is Sun observed Mon
  // Black Friday (day after Thanksgiving) -- always Fri
  const thanksgiving=_computeNYSEHolidays(yr).find(h=>h.month===11&&h.name==='Thanksgiving');
  if(thanksgiving){const tf=new Date(yr,10,thanksgiving.day+1);if(mo===11&&dy===thanksgiving.day+1)return 780;}
  // Christmas Eve (Dec 24, or Fri if Dec 25 is Sat)
  if(mo===12&&dy===24)return 780;
  if(mo===12&&dy===23&&dow==='Fri')return 780;
  // New Year's Eve (Dec 31, or Fri if Jan 1 is Sat)
  if(mo===12&&dy===31)return 780;
  if(mo===12&&dy===30&&dow==='Fri')return 780;
  return 960; // normal close 4pm ET
}

function minsToHHMM(m){const h=Math.floor(m/60);const mm=m%60;return h>0?`${h}h ${mm}m`:`${mm}m`;}

function secsToMMSS(s){return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}

function etTimeToDisplay(etHour,etMin){
  // Signal to use minsLeft instead -- see updateMarketBanner
  return null;
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
    const now=ms.now;
    const etFmt2=new Intl.DateTimeFormat('en-US',{
      timeZone:'America/New_York',
      year:'numeric',month:'2-digit',day:'2-digit'
    });
    function make930ET(etDateStr){
      for(const offsetH of [4,5]){
        const utcH=9+offsetH;
        const candidate=new Date(`${etDateStr}T${String(utcH).padStart(2,'0')}:30:00Z`);
        const parts=new Intl.DateTimeFormat('en-US',{
          timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false
        }).formatToParts(candidate);
        const h=parseInt(parts.find(p=>p.type==='hour').value);
        const m=parseInt(parts.find(p=>p.type==='minute').value);
        if(h===9&&m===30)return candidate;
      }
      return new Date(`${etDateStr}T13:30:00Z`);
    }
    const todayParts=etFmt2.formatToParts(now);
    const etY=todayParts.find(p=>p.type==='year').value;
    const etMo=todayParts.find(p=>p.type==='month').value;
    const etDa=todayParts.find(p=>p.type==='day').value;
    let etDateStr=`${etY}-${etMo}-${etDa}`;
    let nextOpen=make930ET(etDateStr);
    if(nextOpen<=now){
      const d=new Date(nextOpen.getTime()+86400000);
      const p=etFmt2.formatToParts(d);
      etDateStr=`${p.find(q=>q.type==='year').value}-${p.find(q=>q.type==='month').value}-${p.find(q=>q.type==='day').value}`;
      nextOpen=make930ET(etDateStr);
    }
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
  const dot=document.getElementById('header-status-dot');
  if(!dot)return;
  const tickers=watchlist.slice(0,5);
  let allFresh=true,anyData=false;
  const now=Date.now();
  tickers.forEach(t=>{
    const snap=S.get('snap_'+t);
    if(snap?.ts){
      anyData=true;
      try{
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
  const lts=S.get('last_full_refresh_ts');
  const lbl=document.getElementById('last-full-refresh-label');
  if(lbl&&lts){const age=relAge(lts);lbl.textContent='Last full refresh: '+lts+(age?' ('+age+')':'');}
}

function setTopBar(pct){
  const bar=document.getElementById('top-bar-fill');
  const wrap=document.getElementById('top-progress-bar');
  if(!bar||!wrap)return;
  if(pct===null){
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
    setTopBar(2);
  }else{
    dot.style.animation='';
    setTopBar(null);
    updateHeaderStatus();
  }
}

function refreshTsChipAges(){
  const STALE_MINS=15;
  document.querySelectorAll('.ts-chip').forEach(chip=>{
    const isoAttr=chip.getAttribute('data-ts-iso');
    const displayTs=chip.getAttribute('data-ts-display')||'';
    let ageMins=Infinity;
    if(isoAttr){
      try{ageMins=(Date.now()-new Date(isoAttr).getTime())/60000;}catch{}
    }else{
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
  const tabs=['dashboard','watchlist','ticker','options','vix','earnings','etf','market','income','guide'];
  document.querySelectorAll('.nav-tab')[tabs.indexOf(name)].classList.add('active');
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
  if(name==='income'){restoreIncomeFromCache();}
}
