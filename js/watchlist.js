// PutSeller Pro -- watchlist.js
// Watchlist tab: render, add, remove (with confirmation modal), sort.
// Globals used: watchlist, watchlistSort, currentTicker, S
// Dependencies: helpers.js, storage.js, ui.js

// ── Removal confirmation modal ────────────────────────────────────────────────
// Uses the same .modal-overlay / .modal-box pattern as the "Clear All Cached
// Data" confirmation -- already styled in app.css, proven to work on iPhone.
// The modal is created once and reused; the ticker being confirmed is tracked
// in _pendingRemoveTicker.

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
    // Tap outside the box to cancel
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
  // Clear the ticker's cached snapshot so stale data doesn't re-appear
  // if the user re-adds the ticker later.
  S.del('snap_'+ticker);
  renderWatchlist();
  populateSelects();
  toast('Removed '+ticker);
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
  const el=document.getElementById('watchlist-items');
  if(!watchlist.length){
    el.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CB;</div>Watchlist is empty</div>';
    return;
  }
  const sorted=getSortedWatchlist();
  el.innerHTML=sorted.map(t=>{
    const c=S.get('snap_'+t);
    const price=c?'$'+c.price.toFixed(2):'--';
    const chg=c?c.change:0,chgPct=c?c.changePct:0;
    const cc=chg>=0?'var(--green)':'var(--red)';
    const age=c?relAge(c.ts):'';
    return '<div class="watchlist-item" onclick="selectTickerFromWatchlist(\''+t+'\')">'+
      '<div>'+
        '<div class="watchlist-ticker">'+t+'</div>'+
        (c?'<div class="watchlist-ts">'+c.ts+(age?' ('+age+')':'')+'</div>':'')+
      '</div>'+
      '<div style="text-align:right">'+
        '<div class="watchlist-price">'+price+'</div>'+
        (c?'<div class="watchlist-change" style="color:'+cc+'">'+(chg>=0?'+':'')+chg.toFixed(2)+' ('+(chgPct>=0?'+':'')+chgPct.toFixed(2)+'%)</div>':'')+
      '</div>'+
      '<button class="watchlist-remove" onclick="event.stopPropagation();_openRemoveModal(\''+t+'\')">&#x2715;</button>'+
    '</div>';
  }).join('');
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
  const opts='<option value="">-- Select --</option>'+
    watchlist.map(t=>'<option value="'+t+'">'+t+'</option>').join('');
  document.getElementById('ticker-select').innerHTML=opts;
  document.getElementById('options-ticker-select').innerHTML=opts;
}
