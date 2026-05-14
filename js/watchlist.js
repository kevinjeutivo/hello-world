// PutSeller Pro -- watchlist.js
// Watchlist tab: render, add, remove (with confirmation modal), sort.
// Heatmap: daily % change or IVR coloring on chips.
// Volume badge: 🔥 VOL when unusual volume detected in final 2h of session or lingers overnight.
// Globals used: watchlist, watchlistSort, currentTicker, S
// Dependencies: helpers.js, storage.js, ui.js

// ── Removal confirmation modal ────────────────────────────────────────────────

let _pendingRemoveTicker=null;

function _ensureRemoveModal(){
  let el=document.getElementById('watchlist-remove-modal');
  if(!el){
    el=document.createElement('div');
    el.className='modal-overlay';
    el.id='watchlist-remove-modal';
    el.innerHTML=
      '<div class="modal-box">'+
        '<div class="modal-title" id="wrm-title">Remove ticker?</div>'+
        '<div class="modal-body" id="wrm-body"></div>'+
        '<div style="display:flex;gap:8px">'+
          '<button class="btn btn-secondary btn-sm" id="wrm-cancel">Cancel</button>'+
          '<button class="btn btn-danger btn-sm" id="wrm-confirm">Remove</button>'+
        '</div>'+
      '</div>';
    document.body.appendChild(el);
    document.getElementById('wrm-cancel').addEventListener('click',_closeRemoveModal);
    document.getElementById('wrm-confirm').addEventListener('click',_confirmRemove);
    el.addEventListener('click',function(e){if(e.target===el)_closeRemoveModal();});
  }
  return el;
}

function _openRemoveModal(ticker){
  _pendingRemoveTicker=ticker;
  const el=_ensureRemoveModal();
  document.getElementById('wrm-body').textContent=
    'Remove '+ticker+' from your watchlist? This will also clear its cached price data.';
  el.classList.add('open');
}

function _closeRemoveModal(){
  _pendingRemoveTicker=null;
  const el=document.getElementById('watchlist-remove-modal');
  if(el)el.classList.remove('open');
}

function _confirmRemove(){
  const ticker=_pendingRemoveTicker;
  _closeRemoveModal();
  if(!ticker)return;
  watchlist=watchlist.filter(x=>x!==ticker);
  S.set('watchlist',watchlist);
  S.del('snap_'+ticker);
  const vbs=S.get('vol_badge_state')||{};
  delete vbs[ticker];
  S.set('vol_badge_state',vbs);
  renderWatchlist();
  populateSelects();
  toast('Removed '+ticker);
}

// ── Heatmap ───────────────────────────────────────────────────────────────────

let _heatmapMode=S.get('heatmap_mode')||'off'; // 'off' | 'change' | 'ivr'

function setHeatmap(mode){
  _heatmapMode=mode;
  S.set('heatmap_mode',mode);
  ['off','change','ivr'].forEach(m=>{
    const btn=document.getElementById('hm-'+m);
    if(btn)btn.style.opacity=m===mode?'1':'0.4';
  });
  renderWatchlist();
}

function _heatmapBg(t){
  if(_heatmapMode==='off')return null;
  const snap=S.get('snap_'+t);
  if(!snap)return null;

  if(_heatmapMode==='change'){
    const pct=snap.changePct||0;
    const intensity=Math.min(Math.abs(pct)/5,1); // 5% move = full intensity
    if(pct>0){
      const g=Math.round(80+intensity*100);
      return'rgba(0,'+g+',80,'+(0.12+intensity*0.25)+')';
    }else{
      const r=Math.round(160+intensity*80);
      return'rgba('+r+',30,30,'+(0.12+intensity*0.25)+')';
    }
  }

  if(_heatmapMode==='ivr'){
    const ivr=snap.ivrVal;
    if(ivr==null)return'rgba(85,88,112,0.08)';
    if(ivr>=70)return'rgba(255,107,53,0.22)';
    if(ivr>=50)return'rgba(255,193,7,0.18)';
    if(ivr>=30)return'rgba(100,181,246,0.12)';
    return'rgba(85,88,112,0.08)';
  }
  return null;
}

// ── Volume badge ──────────────────────────────────────────────────────────────

const VOL_THRESHOLD_ORANGE=1.5;
const VOL_THRESHOLD_HOT=2.0;
const VOL_AVG_DAYS=20;
const VOL_WINDOW_MINS=120;

function _checkVolumeBadge(ticker){
  const KEY='vol_badge_state';
  const etDate=new Date();
  const today=etDate.toLocaleDateString('en-US',{timeZone:'America/New_York'});

  function _getAvgVol(){
    const hist=S.get('hist_'+ticker)||S.get('hist1y_'+ticker);
    if(!hist?.volumes?.length)return null;
    const vols=hist.volumes.filter(v=>v>0);
    if(vols.length<VOL_AVG_DAYS+1)return null;
    // Use all but the last entry for avg (last = today or most recent session)
    return vols.slice(-VOL_AVG_DAYS-1,-1).reduce((s,v)=>s+v,0)/VOL_AVG_DAYS;
  }

  // Retroactive path: last completed session volume from history cache
  function _retroCheck(){
    const hist=S.get('hist_'+ticker)||S.get('hist1y_'+ticker);
    if(!hist?.volumes?.length)return null;
    const vols=hist.volumes.filter(v=>v>0);
    if(vols.length<VOL_AVG_DAYS+1)return null;
    const lastVol=vols[vols.length-1];
    const avgVol=vols.slice(-VOL_AVG_DAYS-1,-1).reduce((s,v)=>s+v,0)/VOL_AVG_DAYS;
    if(avgVol<=0)return null;
    const mult=lastVol/avgVol;
    return mult>=VOL_THRESHOLD_ORANGE?{multiplier:mult,date:today}:null;
  }

  // Live intraday path: only in final 2h of session
  function _liveCheck(){
    const ms=getMarketState();
    if(ms.state!=='open')return null;
    const sessionClose=_getSessionCloseMins(ms.now);
    const windowStart=sessionClose-VOL_WINDOW_MINS;
    if(ms.totalMins<windowStart)return null;
    // Prefer hist1y last volume entry (accumulates all day via full refresh)
    // over snap.intradayVolume which only updates on explicit ticker refresh
    const hist1yC=S.get('hist1y_'+ticker);
    const histVols=hist1yC?.volumes?.filter(v=>v>0)||[];
    const histLastVol=histVols.length?histVols[histVols.length-1]:null;
    const snap=S.get('snap_'+ticker);
    const intradayVol=histLastVol||snap?.intradayVolume||null;
    if(!intradayVol)return null;
    const elapsed=ms.totalMins-570; // mins since 9:30am open
    const sessionLen=sessionClose-570;
    if(elapsed<=0||sessionLen<=0)return null;
    const projectedVol=Math.round(intradayVol*(sessionLen/elapsed));
    const avgVol=_getAvgVol();
    if(!avgVol)return null;
    const mult=projectedVol/avgVol;
    return mult>=VOL_THRESHOLD_ORANGE?{multiplier:mult,date:today}:null;
  }

  const ms=getMarketState();

  // Premarket: clear yesterday's badge, show nothing
  if(ms.state==='premarket'){
    const vbs=S.get(KEY)||{};
    if(vbs[ticker]?.date&&vbs[ticker].date!==today){
      delete vbs[ticker];
      S.set(KEY,vbs);
    }
    return null;
  }

  // During open session
  if(ms.state==='open'){
    // Clear any badge not explicitly triggered during today's live window.
    // This handles both prior-day badges and retroactive badges set overnight
    // (which have today's ET date but were not triggered by live intraday volume).
    const vbsOpen=S.get(KEY)||{};
    if(vbsOpen[ticker]&&!vbsOpen[ticker].liveTriggered){
      delete vbsOpen[ticker];
      S.set(KEY,vbsOpen);
    }
    const live=_liveCheck();
    if(live){
      const vbs=S.get(KEY)||{};
      vbs[ticker]={multiplier:live.multiplier,date:live.date,liveTriggered:true};
      S.set(KEY,vbs);
      return live;
    }
    // Outside the 2h window with no live trigger yet: show nothing
    const vbs=S.get(KEY)||{};
    if(vbs[ticker]?.liveTriggered)return vbs[ticker];
    return null;
  }

  // After-hours, overnight, weekend: show persisted badge or retroactive
  const vbs=S.get(KEY)||{};
  if(vbs[ticker]?.date===today)return vbs[ticker];

  // Retroactive check (handles nuclear option rebuild on weekend etc.)
  // liveTriggered:false ensures this badge is cleared when market opens
  const retro=_retroCheck();
  if(retro){
    vbs[ticker]={multiplier:retro.multiplier,date:retro.date,liveTriggered:false};
    S.set(KEY,vbs);
    return retro;
  }
  return null;
}

function _volBadgeHtml(badgeData){
  if(!badgeData)return'';
  const hot=badgeData.multiplier>=VOL_THRESHOLD_HOT;
  const bg=hot?'rgba(255,71,87,0.9)':'rgba(255,165,2,0.9)';
  const multStr=badgeData.multiplier!=null?(' '+badgeData.multiplier.toFixed(1)+'x'):'';
  return'<span style="display:inline-flex;align-items:center;gap:2px;background:'+bg+';'
    +'color:#fff;font-family:var(--mono);font-size:9px;font-weight:700;'
    +'padding:2px 5px;border-radius:4px;margin-left:5px;vertical-align:middle;'
    +'letter-spacing:0.3px">🔥 VOL'+multStr+'</span>';
}

// ── IVR badge ─────────────────────────────────────────────────────────────────
// Always-on badge when IVR >= 50, independent of heatmap mode.
// Color matches unified scale: 50-69 amber (elevated), >=70 orange (high).

function _ivrBadgeHtml(ticker){
  const snap=S.get('snap_'+ticker);
  const ivr=snap?.ivrVal;
  if(ivr==null||ivr<50)return'';
  const high=ivr>=70;
  const bg=high?'rgba(255,107,53,0.9)':'rgba(255,193,7,0.85)';
  const textColor=high?'#fff':'#1a1a1a';
  const label=high?'High':'Elev';
  return'<span style="display:inline-flex;align-items:center;gap:2px;background:'+bg+';'
    +'color:'+textColor+';font-family:var(--mono);font-size:9px;font-weight:700;'
    +'padding:2px 5px;border-radius:4px;margin-left:5px;vertical-align:middle;'
    +'letter-spacing:0.3px">IVR '+ivr.toFixed(0)+' '+label+'</span>';
}

// ── Watchlist core ────────────────────────────────────────────────────────────

function setWatchlistSort(mode){
  watchlistSort=mode;
  S.set('watchlist_sort',mode);
  ['manual','alpha','opp'].forEach(m=>{
    const btn=document.getElementById('wl-sort-'+m);
    if(btn)btn.style.opacity=(
      (m==='manual'&&mode==='manual')||(m==='alpha'&&mode==='alpha')||(m==='opp'&&mode==='opportunity')
    )?'1':'0.4';
  });
  renderWatchlist();
}

function getSortedWatchlist(){
  if(watchlistSort==='alpha'){
    return [...watchlist].sort((a,b)=>a.localeCompare(b));
  }
  if(watchlistSort==='opportunity'){
    const puts=S.get('conviction_puts')?.results||[];
    const cc=S.get('conviction_cc')?.results||[];
    const scoreMap={};
    [...puts,...cc].forEach(r=>{
      if(!scoreMap[r.ticker]||r.score>scoreMap[r.ticker])scoreMap[r.ticker]=r.score||0;
    });
    return [...watchlist].sort((a,b)=>(scoreMap[b]||0)-(scoreMap[a]||0));
  }
  return watchlist;
}

function renderWatchlist(){
  // Sync heatmap button states with current mode on every render
  ['off','change','ivr'].forEach(m=>{
    const btn=document.getElementById('hm-'+m);
    if(btn)btn.style.opacity=m===_heatmapMode?'1':'0.4';
  });
  const el=document.getElementById('watchlist-items');
  if(!watchlist.length){
    el.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CB;</div>Watchlist is empty</div>';
    return;
  }
  const sorted=getSortedWatchlist();
  // IVR legend -- only shown when IVR heatmap is active
  const legendHtml=_heatmapMode==='ivr'?
    '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;padding:8px;background:var(--surface2);border-radius:8px;border:1px solid var(--border)">'
    +'<div style="font-family:var(--mono);font-size:9px;color:var(--text3);width:100%;margin-bottom:2px;text-transform:uppercase;letter-spacing:0.5px">IVR Heatmap — each ticker vs its own 52W IV range</div>'
    +'<div style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:rgba(255,107,53,0.22)"></span><span style="font-family:var(--mono);font-size:10px;color:var(--text2)">IVR ≥ 70 — High (rich premium)</span></div>'
    +'<div style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:rgba(255,193,7,0.18)"></span><span style="font-family:var(--mono);font-size:10px;color:var(--text2)">IVR 50–69 — Elevated</span></div>'
    +'<div style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:rgba(100,181,246,0.12)"></span><span style="font-family:var(--mono);font-size:10px;color:var(--text2)">IVR 30–49 — Normal</span></div>'
    +'<div style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:rgba(85,88,112,0.08);border:1px solid var(--border)"></span><span style="font-family:var(--mono);font-size:10px;color:var(--text2)">IVR &lt; 30 or no data — Low/thin</span></div>'
    +'<div style="font-family:var(--mono);font-size:9px;color:var(--text3);width:100%;margin-top:2px">IVR badge (orange/amber) appears on chips when IVR ≥ 50, independent of heatmap mode. Run conviction dashboards to populate IVR data.</div>'
    +'</div>'
    :'';

  el.innerHTML=sorted.map(t=>{
    const c=S.get('snap_'+t);
    const price=c?'$'+c.price.toFixed(2):'--';
    const chg=c?c.change:0,chgPct=c?c.changePct:0;
    const cc=chg>=0?'var(--green)':'var(--red)';
    const age=c?relAge(c.ts):'';
    const hmBg=_heatmapBg(t);
    const bgStyle=hmBg?'background:'+hmBg+';':'';
    const volBadge=_volBadgeHtml(_checkVolumeBadge(t));
    const ivrBadge=_ivrBadgeHtml(t);
    return '<div class="watchlist-item" style="'+bgStyle+'" onclick="selectTickerFromWatchlist(\''+t+'\')">'+
      '<div>'+
        '<div class="watchlist-ticker">'+t+ivrBadge+volBadge+'</div>'+
        (c?'<div class="watchlist-ts">'+c.ts+(age?' ('+age+')':'')+'</div>':'')+
      '</div>'+
      '<div style="text-align:right">'+
        '<div class="watchlist-price">'+price+'</div>'+
        (c?'<div class="watchlist-change" style="color:'+cc+'">'+(chg>=0?'+':'')+chg.toFixed(2)+' ('+(chgPct>=0?'+':'')+chgPct.toFixed(2)+'%)</div>':'')+
      '</div>'+
      '<button class="watchlist-remove" onclick="event.stopPropagation();_openRemoveModal(\''+t+'\')">&#x2715;</button>'+
    '</div>';
  }).join('')+legendHtml;
}

function selectTickerFromWatchlist(t){
  currentTicker=t;S.set('last_ticker',t);
  populateSelects();
  document.getElementById('ticker-select').value=t;
  document.getElementById('options-ticker-select').value=t;
  showTab('ticker');loadTicker();
}

function addTicker(){
  const inp=document.getElementById('new-ticker-input');
  const t=inp.value.trim().toUpperCase();
  if(!t)return;
  if(watchlist.includes(t)){toast(t+' already in watchlist');return;}
  watchlist.push(t);S.set('watchlist',watchlist);
  inp.value='';renderWatchlist();populateSelects();toast('Added '+t);
}

function removeTicker(e,t){
  e.stopPropagation();
  _openRemoveModal(t);
}

function populateSelects(){
  // Dropdowns always alphabetical regardless of watchlist chip sort order
  const sorted=[...watchlist].sort((a,b)=>a.localeCompare(b));
  const opts='<option value="">-- Select --</option>'+
    sorted.map(t=>'<option value="'+t+'">'+t+'</option>').join('');
  document.getElementById('ticker-select').innerHTML=opts;
  document.getElementById('options-ticker-select').innerHTML=opts;
}
