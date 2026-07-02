// Income Engine -- watchlist.js
// Watchlist tab: render, add, remove (with confirmation modal), sort, per-ticker notes.
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
  _closeTickerMenu(); // close ⋯ menu if open
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

// ── Per-ticker note expand/collapse (session-only, resets on tab leave) ───────
const _expandedNotes = new Set();

function _toggleNoteExpand(ticker){
  if(_expandedNotes.has(ticker)) _expandedNotes.delete(ticker);
  else _expandedNotes.add(ticker);
  renderWatchlist();
}

function _resetNoteExpansions(){
  _expandedNotes.clear();
}

// ── Per-ticker note modal ─────────────────────────────────────────────────────

let _pendingNoteTicker=null;

function _openNoteModal(ticker){
  _closeTickerMenu();
  _pendingNoteTicker=ticker;
  const existing=S.get('watchlist_note_'+ticker)||'';
  let el=document.getElementById('watchlist-note-modal');
  if(!el){
    el=document.createElement('div');
    el.className='modal-overlay';
    el.id='watchlist-note-modal';
    document.body.appendChild(el);
    el.addEventListener('click',e=>{if(e.target===el)_closeNoteModal();});
  }
  el.innerHTML=
    '<div class="modal-box">'+
      '<div class="modal-title modal-title-neutral">Note for '+ticker+'</div>'+
      '<div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:8px">Appears below the ticker row. Max 200 characters.</div>'+
      '<textarea id="wnm-text" maxlength="200" rows="3" style="width:100%;box-sizing:border-box;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-family:var(--mono);font-size:12px;padding:8px;resize:none;outline:none">'+existing.replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</textarea>'+
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">'+
        '<span id="wnm-counter" style="font-family:var(--mono);font-size:9px;color:var(--text3)">'+existing.length+'/200</span>'+
        '<div id="wnm-btns" style="display:flex;gap:8px">'+
          '<button class="btn btn-secondary btn-sm" onclick="_closeNoteModal()">Cancel</button>'+
          (existing?'<button class="btn btn-danger btn-sm" onclick="_confirmClearNote()">Clear</button>':'')+
          '<button class="btn btn-primary btn-sm" onclick="_saveNote()">Save</button>'+
        '</div>'+
      '</div>'+
    '</div>';
  el.classList.add('open');
  const ta=document.getElementById('wnm-text');
  if(ta){
    ta.addEventListener('input',()=>{
      const c=document.getElementById('wnm-counter');
      if(c)c.textContent=ta.value.length+'/200';
    });
    setTimeout(()=>ta.focus(),100);
  }
}

function _confirmClearNote(){
  // Replace button row with inline "are you sure?" prompt
  const btns=document.getElementById('wnm-btns');
  if(!btns)return;
  btns.innerHTML=
    '<span style="font-family:var(--mono);font-size:11px;color:var(--text2)">Clear note?</span>'+
    '<button class="btn btn-secondary btn-sm" onclick="_restoreClearBtn()">Cancel</button>'+
    '<button class="btn btn-danger btn-sm" onclick="_clearNote()">Yes, clear it</button>';
}

function _restoreClearBtn(){
  const btns=document.getElementById('wnm-btns');
  if(!btns)return;
  btns.innerHTML=
    '<button class="btn btn-secondary btn-sm" onclick="_closeNoteModal()">Cancel</button>'+
    '<button class="btn btn-danger btn-sm" onclick="_confirmClearNote()">Clear</button>'+
    '<button class="btn btn-primary btn-sm" onclick="_saveNote()">Save</button>';
}

function _closeNoteModal(){
  _pendingNoteTicker=null;
  const el=document.getElementById('watchlist-note-modal');
  if(el)el.classList.remove('open');
}

function _saveNote(){
  const ticker=_pendingNoteTicker;
  if(!ticker)return;
  const ta=document.getElementById('wnm-text');
  const text=(ta?ta.value.trim():'');
  if(text) S.set('watchlist_note_'+ticker,text);
  else S.del('watchlist_note_'+ticker);
  _closeNoteModal();
  renderWatchlist();
  toast(text?'Note saved':'Note cleared');
}

function _clearNote(){
  const ticker=_pendingNoteTicker;
  if(!ticker)return;
  S.del('watchlist_note_'+ticker);
  _closeNoteModal();
  renderWatchlist();
  toast('Note cleared');
}

// ── ⋯ ticker action menu ──────────────────────────────────────────────────────

let _activeMenuTicker=null;

// ── Income position lookup (reads income localStorage keys directly) ──────────

function _posExpiryStatusWL(pos){
  // Inline version of _posExpiryStatus from income.js -- avoids cross-module dependency
  const today=new Date();today.setHours(0,0,0,0);
  const exp=new Date(pos.expDate+'T12:00:00Z');
  const d=Math.round((exp-today)/86400000);
  if(d<-7)return'remove';
  if(d<0)return'expired-linger';
  if(d<=2)return'expiring-imminent';
  if(d<=7)return'expiring-soon';
  return'active';
}

function _getIncomePositionsForTicker(ticker){
  // Returns [{acctName, acctId, acctIdx, puts:[], ccs:[]}] for accounts that have positions
  const accounts=S.get('income_accounts_meta')||[];
  const result=[];
  accounts.forEach((a,i)=>{
    const puts=(S.get('income_'+a.id+'_put_positions')||[])
      .filter(p=>p.ticker===ticker&&_posExpiryStatusWL(p)!=='remove');
    const ccs=(S.get('income_'+a.id+'_cc_positions')||[])
      .filter(p=>p.ticker===ticker&&_posExpiryStatusWL(p)!=='remove');
    if(puts.length||ccs.length) result.push({acctName:a.name,acctId:a.id,acctIdx:i,puts,ccs});
  });
  return result;
}

function _openPositionsModal(ticker){
  _closeTickerMenu();
  const accountPositions=_getIncomePositionsForTicker(ticker);
  if(!accountPositions.length){toast('No active positions found for '+ticker);return;}

  const ACCT_COLORS=['#00d4aa','#ff6b35','#7c6af7','#64b5f6','#ffd32a','#00c896','#f06292','#ffa502'];
  const snap=S.get('snap_'+ticker);
  const currentPrice=snap?.price||null;

  const acctSections=accountPositions.map(({acctName,acctId,acctIdx,puts,ccs})=>{
    const color=ACCT_COLORS[acctIdx%ACCT_COLORS.length];
    const statusStyle=s=>{
      if(s==='expiring-imminent')return'color:var(--red)';
      if(s==='expiring-soon')return'color:var(--warn)';
      if(s==='expired-linger')return'color:var(--text3)';
      return'color:var(--text2)';
    };
    const putRows=puts.map(p=>{
      const s=_posExpiryStatusWL(p);
      const today=new Date();today.setHours(0,0,0,0);
      const exp=new Date(p.expDate+'T12:00:00Z');
      const dte=Math.round((exp-today)/86400000);
      const itm=currentPrice!=null&&currentPrice<p.strike;
      return '<div style="font-family:var(--mono);font-size:11px;padding:4px 0;border-bottom:1px solid var(--border);'+statusStyle(s)+'">'+
        '<span style="background:rgba(100,181,246,0.2);color:#64b5f6;font-size:9px;padding:1px 4px;border-radius:3px;margin-right:6px">PUT</span>'+
        '$'+(p.strike%1===0?p.strike.toFixed(0):p.strike.toFixed(2))+' · exp '+p.expDate+' ('+dte+'d) · '+p.contracts+' contract'+(p.contracts>1?'s':'')+
        (itm?' <span style="color:var(--red);font-size:9px">⚠ ITM</span>':'')+
      '</div>';
    }).join('');
    const ccRows=ccs.map(p=>{
      const s=_posExpiryStatusWL(p);
      const today=new Date();today.setHours(0,0,0,0);
      const exp=new Date(p.expDate+'T12:00:00Z');
      const dte=Math.round((exp-today)/86400000);
      const itm=currentPrice!=null&&currentPrice>p.strike;
      return '<div style="font-family:var(--mono);font-size:11px;padding:4px 0;border-bottom:1px solid var(--border);'+statusStyle(s)+'">'+
        '<span style="background:rgba(255,107,53,0.2);color:#ff6b35;font-size:9px;padding:1px 4px;border-radius:3px;margin-right:6px">CC</span>'+
        '$'+(p.strike%1===0?p.strike.toFixed(0):p.strike.toFixed(2))+' · exp '+p.expDate+' ('+dte+'d) · '+p.contracts+' contract'+(p.contracts>1?'s':'')+
        (itm?' <span style="color:var(--warn);font-size:9px">⚠ ITM</span>':'')+
      '</div>';
    }).join('');
    return '<div style="margin-bottom:12px">'+
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">'+
        '<div style="font-family:var(--sans);font-size:12px;font-weight:700;color:'+color+'">'+acctName+'</div>'+
        '<button onclick="document.getElementById(\'wl-pos-modal\').classList.remove(\'open\');_switchAccount&&_switchAccount(\''+acctId+'\');showTab&&showTab(\'income\')" '+
          'style="font-family:var(--mono);font-size:9px;padding:2px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface2);color:var(--text3);cursor:pointer">'+
          'Go to account ↗</button>'+
      '</div>'+
      putRows+ccRows+
    '</div>';
  }).join('');

  let el=document.getElementById('wl-pos-modal');
  if(!el){
    el=document.createElement('div');
    el.className='modal-overlay';
    el.id='wl-pos-modal';
    document.body.appendChild(el);
    el.addEventListener('click',e=>{if(e.target===el)el.classList.remove('open');});
  }
  el.innerHTML=
    '<div class="modal-box" style="max-width:380px;max-height:80vh;overflow-y:auto">'+
      '<div class="modal-title modal-title-neutral" style="margin-bottom:4px">'+ticker+' Positions</div>'+
      (currentPrice?'<div style="font-family:var(--mono);font-size:10px;color:var(--text3);margin-bottom:12px">Current price: $'+currentPrice.toFixed(2)+'</div>':'')+
      acctSections+
      '<button class="btn btn-secondary btn-sm" style="width:100%;margin-top:4px" onclick="document.getElementById(\'wl-pos-modal\').classList.remove(\'open\')">Close</button>'+
    '</div>';
  el.classList.add('open');
}

function _openTickerMenu(ticker,btnEl){
  if(_activeMenuTicker===ticker){ _closeTickerMenu(); return; }
  _closeTickerMenu();
  _activeMenuTicker=ticker;

  const existing=document.getElementById('ticker-action-menu');
  if(existing)existing.remove();

  const menu=document.createElement('div');
  menu.id='ticker-action-menu';
  menu.style.cssText=
    'position:fixed;z-index:500;background:var(--surface);border:1px solid var(--border);'+
    'border-radius:var(--radius);box-shadow:0 4px 20px rgba(0,0,0,0.5);min-width:170px;overflow:hidden';

  const hasNote=!!(S.get('watchlist_note_'+ticker));
  const hasPositions=_getIncomePositionsForTicker(ticker).length>0;

  menu.innerHTML=
    '<div style="font-family:var(--mono);font-size:11px;color:var(--text3);padding:8px 12px 6px;border-bottom:1px solid var(--border)">'+ticker+'</div>'+
    '<div style="padding:4px 0">'+
      (hasPositions?
        '<div onclick="event.stopPropagation();_openPositionsModal(\''+ticker+'\')" style="display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:12px;color:var(--accent)" onmouseenter="this.style.background=\'var(--surface2)\'" onmouseleave="this.style.background=\'\'">'+
          '<span style="font-size:14px">📋</span>View Positions'+
        '</div>':'')+
      '<div onclick="event.stopPropagation();_openNoteModal(\''+ticker+'\')" style="display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:12px;color:var(--text2)" onmouseenter="this.style.background=\'var(--surface2)\'" onmouseleave="this.style.background=\'\'">'+
        '<span style="font-size:14px">✎</span>'+(hasNote?'Edit Note':'Add Note')+
      '</div>'+
      '<div onclick="event.stopPropagation();_openRemoveModal(\''+ticker+'\')" style="display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;font-family:var(--mono);font-size:12px;color:var(--red)" onmouseenter="this.style.background=\'var(--surface2)\'" onmouseleave="this.style.background=\'\'">'+
        '<span style="font-size:14px">✕</span>Remove from Watchlist'+
      '</div>'+
    '</div>';

  document.body.appendChild(menu);

  const rect=btnEl.getBoundingClientRect();
  const menuW=175;
  let left=rect.right-menuW;
  if(left<8)left=8;
  let top=rect.bottom+4;
  const menuH=hasPositions?150:110;
  if(top+menuH>window.innerHeight)top=rect.top-menuH-4;
  menu.style.left=left+'px';
  menu.style.top=top+'px';

  setTimeout(()=>{
    document.addEventListener('click',_closeTickerMenu,{once:true});
  },0);
}

function _closeTickerMenu(){
  _activeMenuTicker=null;
  const el=document.getElementById('ticker-action-menu');
  if(el)el.remove();
}

function _confirmRemove(){
  const ticker=_pendingRemoveTicker;
  _closeRemoveModal();
  if(!ticker)return;
  // Warn if active positions exist for this ticker across ALL income accounts
  try{
    const accounts=(S.get('income_accounts_meta')||[]);
    const posStatus=p=>{
      const today=new Date();today.setHours(0,0,0,0);
      const exp=new Date(p.expDate+'T12:00:00Z');
      const d=Math.round((exp-today)/86400000);
      return d<-7?'remove':d<0?'expired-linger':d<=2?'expiring-imminent':d<=7?'expiring-soon':'active';
    };
    let totalPuts=0,totalCCs=0,acctNames=[];
    if(accounts.length){
      accounts.forEach(a=>{
        const puts=(S.get('income_'+a.id+'_put_positions')||[]);
        const ccs=(S.get('income_'+a.id+'_cc_positions')||[]);
        const ap=puts.filter(p=>p.ticker===ticker&&!['expired-linger','remove'].includes(posStatus(p)));
        const ac=ccs.filter(p=>p.ticker===ticker&&!['expired-linger','remove'].includes(posStatus(p)));
        if(ap.length||ac.length){totalPuts+=ap.length;totalCCs+=ac.length;acctNames.push(a.name);}
      });
    }else{
      // Pre-migration fallback: check old flat keys
      const puts=(S.get('put_positions')||[]);
      const ccs=(S.get('cc_positions')||[]);
      totalPuts=puts.filter(p=>p.ticker===ticker&&!['expired-linger','remove'].includes(posStatus(p))).length;
      totalCCs=ccs.filter(p=>p.ticker===ticker&&!['expired-linger','remove'].includes(posStatus(p))).length;
    }
    if(totalPuts>0||totalCCs>0){
      const acctStr=acctNames.length?(' in '+acctNames.join(', ')):'';
      if(totalPuts>0)toast('Note: '+ticker+' has '+totalPuts+' active put position'+(totalPuts>1?'s':'')+acctStr+'.',4000);
      if(totalCCs>0)toast('Note: '+ticker+' has '+totalCCs+' active CC position'+(totalCCs>1?'s':'')+acctStr+'.',4000);
    }
  }catch{}
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
    const hist=S.get('hist2y_'+ticker);
    if(!hist?.volumes?.length)return null;
    const vols=hist.volumes.slice(-126).filter(v=>v>0);
    if(vols.length<VOL_AVG_DAYS+1)return null;
    // Use all but the last entry for avg (last = today or most recent session)
    return vols.slice(-VOL_AVG_DAYS-1,-1).reduce((s,v)=>s+v,0)/VOL_AVG_DAYS;
  }

  // Retroactive path: last completed session volume from history cache
  function _retroCheck(){
    const hist=S.get('hist2y_'+ticker);
    if(!hist?.volumes?.length)return null;
    const vols=hist.volumes.slice(-126).filter(v=>v>0);
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
    const hist2yC=S.get('hist2y_'+ticker);
    const histVols=hist2yC?.volumes?.slice(-252).filter(v=>v>0)||[];
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

// ── Intraday sparkline ────────────────────────────────────────────────────────

function _sparklineHtml(ticker){
  try{
    const cache = S.get('intraday_'+ticker);
    if(!cache || !cache.closes || cache.closes.length < 2) return '';
    const closes = cache.closes.filter((v,i) => v != null);
    if(closes.length < 2) return '';

    // Filter closes alongside timestamps to keep indices aligned
    const rawCloses = cache.closes;
    const rawTs = cache.timestamps; // array of ms epoch values, or null for old caches
    const paired = rawCloses.map((v,i) => ({v, t: rawTs?rawTs[i]:null})).filter(p => p.v != null);
    if(paired.length < 2) return '';

    const snap = S.get('snap_'+ticker);
    const prevClose = (snap && snap.prevClose != null) ? snap.prevClose : null;
    const last = paired[paired.length-1].v;
    const ref = prevClose != null ? prevClose : paired[0].v;
    const color = last >= ref ? 'var(--green)' : 'var(--red)';

    const W=60, H=20, PAD=1;
    // Extend Y scale to include prevClose for gap moves
    const allValues = prevClose != null ? [...paired.map(p=>p.v), prevClose] : paired.map(p=>p.v);
    const mn = Math.min(...allValues);
    const mx = Math.max(...allValues);
    const range = mx - mn || 1;
    const toY = v => H - PAD - ((v - mn) / range) * (H - PAD*2);

    // X mapping: time-proportional across full 390-minute trading day
    // Uses elapsed time from first bar so it's timezone-agnostic.
    // Falls back to index-based mapping if timestamps not available (old cache entries).
    const TRADING_MS = 390 * 60 * 1000; // 9:30am–4:00pm = 390 minutes
    const hasTs = rawTs && paired[0].t != null;
    const t0 = hasTs ? paired[0].t : 0;
    const toX = (p, i) => {
      if(hasTs && p.t != null){
        const elapsed = p.t - t0;
        return PAD + Math.min(elapsed / TRADING_MS, 1) * (W - PAD*2);
      }
      // Fallback: index-based (old cache without timestamps)
      return PAD + (i/(paired.length-1)) * (W - PAD*2);
    };

    const pts = paired.map((p,i) => toX(p,i).toFixed(1)+','+toY(p.v).toFixed(1)).join(' ');

    // Reference line at prevClose Y
    const refLine = prevClose != null
      ? `<line x1="${PAD}" y1="${toY(prevClose).toFixed(1)}" x2="${W-PAD}" y2="${toY(prevClose).toFixed(1)}" stroke="var(--text3)" stroke-width="0.7" stroke-dasharray="2,2" opacity="0.6"/>`
      : '';

    return '<svg width="60" height="20" viewBox="0 0 60 20" style="display:block;flex-shrink:0" xmlns="http://www.w3.org/2000/svg">'+
      refLine+
      '<polyline points="'+pts+'" fill="none" stroke="'+color+'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>'+
    '</svg>';
  }catch(e){ return ''; }
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
    const price=(c&&c.price!=null)?'$'+c.price.toFixed(2):'--';
    const chg=(c&&c.change!=null)?c.change:0,chgPct=(c&&c.changePct!=null)?c.changePct:0;
    const cc=chg>=0?'var(--green)':'var(--red)';
    const hasChg=c&&c.change!=null&&c.changePct!=null;
    const age=c?relAge(c.ts):'';
    const hmBg=_heatmapBg(t);
    const bgStyle=hmBg?'background:'+hmBg+';':'';
    const volBadge=_volBadgeHtml(_checkVolumeBadge(t));
    const ivrBadge=_ivrBadgeHtml(t);
    const note=S.get('watchlist_note_'+t)||'';
    const expanded=_expandedNotes.has(t);
    return '<div class="watchlist-item" style="flex-direction:column;align-items:stretch;'+bgStyle+'" onclick="selectTickerFromWatchlist(\''+t+'\')">'+
      '<div style="display:flex;align-items:center;justify-content:space-between;width:100%">'+
        '<div style="min-width:0;flex-shrink:1">'+
          '<div class="watchlist-ticker">'+t+ivrBadge+volBadge+'</div>'+
          (c?'<div class="watchlist-ts">'+c.ts+(age?' ('+age+')':'')+'</div>':'')+
        '</div>'+
        '<div style="flex:1;display:flex;align-items:center;justify-content:center;padding:0 8px">'+
          _sparklineHtml(t)+
        '</div>'+
        '<div style="text-align:right;flex-shrink:0">'+
          '<div class="watchlist-price">'+price+'</div>'+
          (hasChg?'<div class="watchlist-change" style="color:'+cc+'">'+(chg>=0?'+':'')+chg.toFixed(2)+' ('+(chgPct>=0?'+':'')+chgPct.toFixed(2)+'%)</div>':'')+
        '</div>'+
        '<button class="watchlist-remove" title="Actions" onclick="event.stopPropagation();_openTickerMenu(\''+t+'\',this)">&#x22EF;</button>'+
      '</div>'+
      (note?
        '<div onclick="event.stopPropagation();_toggleNoteExpand(\''+t+'\')" style="width:100%;margin-top:6px;padding-top:6px;border-top:1px solid var(--border);font-family:var(--mono);font-size:10px;color:var(--text2);cursor:pointer;display:flex;align-items:flex-start;gap:4px">'+
          '<span style="flex:1;'+(expanded?'white-space:normal;word-break:break-word':'white-space:nowrap;overflow:hidden;text-overflow:ellipsis')+'">'+note.replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</span>'+
          '<span style="flex-shrink:0;color:var(--text3);font-size:8px;padding-top:1px">'+(expanded?'▲':'▼')+'</span>'+
        '</div>'
      :'')+
    '</div>';
  }).join('')+legendHtml;
}

function selectTickerFromWatchlist(t){
  if(t!==currentTicker){currentBBSpan='6m';currentRPSpan='2y';}
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
