// PutSeller Pro -- watchlist.js
// Watchlist tab: render, add, remove (with undo), sort.
// Globals used: watchlist, watchlistSort, currentTicker, S
// Dependencies: helpers.js, storage.js

// ── Undo-toast state ─────────────────────────────────────────────────────────
// Only one removal can be pending undo at a time.  If the user removes a
// second ticker before the first undo window expires, the first is committed
// silently and the new removal starts its own 5-second window.
let _undoTicker=null;       // ticker symbol pending undo
let _undoTimer=null;        // setTimeout handle
const UNDO_DURATION=5000;   // ms the undo window stays open

// Ensure the undo toast DOM element exists (created once, reused).
function _ensureUndoToast(){
  let el=document.getElementById('undo-toast');
  if(!el){
    el=document.createElement('div');
    el.id='undo-toast';
    el.className='toast-undo';
    el.innerHTML=
      '<span class="toast-undo-msg" id="undo-toast-msg"></span>'+
      '<button class="toast-undo-btn" id="undo-toast-btn" onclick="_undoRemove()">Undo</button>';
    document.body.appendChild(el);
  }
  return el;
}

// Show the undo toast for a just-removed ticker.
function _showUndoToast(ticker){
  // Commit any previously pending removal immediately before starting a new one.
  _commitPendingUndo();

  _undoTicker=ticker;

  const el=_ensureUndoToast();
  document.getElementById('undo-toast-msg').textContent='Removed '+ticker;
  el.classList.add('show');

  _undoTimer=setTimeout(()=>{
    _commitPendingUndo();
  },UNDO_DURATION);
}

// Dismiss the toast and commit the removal permanently.
function _commitPendingUndo(){
  if(_undoTimer){clearTimeout(_undoTimer);_undoTimer=null;}
  _undoTicker=null;
  const el=document.getElementById('undo-toast');
  if(el)el.classList.remove('show');
}

// Called by the Undo button -- puts the ticker back and dismisses the toast.
function _undoRemove(){
  if(!_undoTicker)return;
  const ticker=_undoTicker;
  // Clear timer and state first so _commitPendingUndo is a no-op if called again.
  if(_undoTimer){clearTimeout(_undoTimer);_undoTimer=null;}
  _undoTicker=null;
  const el=document.getElementById('undo-toast');
  if(el)el.classList.remove('show');
  // Re-insert at the end of the watchlist and persist.
  if(!watchlist.includes(ticker)){
    watchlist.push(ticker);
    S.set('watchlist',watchlist);
  }
  renderWatchlist();
  populateSelects();
  toast('Restored '+ticker);
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
  if(!watchlist.length){el.innerHTML='<div class="empty"><div class="empty-icon">&#x1F4CB;</div>Watchlist is empty</div>';return;}
  const sorted=getSortedWatchlist();
  el.innerHTML=sorted.map(t=>{
    const c=S.get('snap_'+t);const price=c?`$${c.price.toFixed(2)}`:'--';
    const chg=c?c.change:0,chgPct=c?c.changePct:0;const cc=chg>=0?'var(--green)':'var(--red)';
    const age=c?relAge(c.ts):'';
    return `<div class="watchlist-item" onclick="selectTickerFromWatchlist('${t}')">
      <div><div class="watchlist-ticker">${t}</div>${c?`<div class="watchlist-ts">${c.ts}${age?' ('+age+')':''}</div>`:''}</div>
      <div style="text-align:right"><div class="watchlist-price">${price}</div>${c?`<div class="watchlist-change" style="color:${cc}">${chg>=0?'+':''}${chg.toFixed(2)} (${chgPct>=0?'+':''}${chgPct.toFixed(2)}%)</div>`:''}</div>
      <button class="watchlist-remove" onclick="removeTicker(event,'${t}')">&#x2715;</button>
    </div>`;
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
  // Remove from the live watchlist and persist immediately -- the undo window
  // lets the user reverse this, but the data is not held in a pending state.
  // This matches the "never lose data silently" principle: the removal is real,
  // the undo just adds it back.
  watchlist=watchlist.filter(x=>x!==t);
  S.set('watchlist',watchlist);
  renderWatchlist();
  populateSelects();
  _showUndoToast(t);
}

function populateSelects(){
  const opts='<option value="">-- Select --</option>'+watchlist.map(t=>`<option value="${t}">${t}</option>`).join('');
  document.getElementById('ticker-select').innerHTML=opts;
  document.getElementById('options-ticker-select').innerHTML=opts;
}
