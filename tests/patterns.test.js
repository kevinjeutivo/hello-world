#!/usr/bin/env node
'use strict';
// tests/patterns.test.js -- build 553: technical pattern badges, Phase 1
// (golden/death cross, 52-week high/low) in js/patterns.js.
//
// Runs the ACTUAL shipped js/patterns.js in a Node vm context. Expected
// values are derived by hand from constructed series (derivations in the
// comments), not by re-running the shipped algorithm against itself. A
// separate differential test compares the shipped crosses against a
// deliberately naive reference on randomized series, including gaps.
//
// Usage: node tests/patterns.test.js

const fs=require('fs');
const path=require('path');
const vm=require('vm');
const assert=require('assert');

const ROOT=path.join(__dirname,'..');
const src=p=>fs.readFileSync(path.join(ROOT,p),'utf8');

function makeLocalStorage(){
  const store=new Map();
  return{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>{store.set(k,String(v));},removeItem:k=>{store.delete(k);},clear:()=>store.clear()};
}
function buildContext(){
  const ctx=vm.createContext({console,localStorage:makeLocalStorage(),window:{},toast:()=>{},document:{getElementById:()=>null,addEventListener:()=>{}}});
  vm.runInContext(src('js/storage.js'),ctx,{filename:'js/storage.js'});
  vm.runInContext(src('js/helpers.js'),ctx,{filename:'js/helpers.js'});
  vm.runInContext(src('js/wheelbacktest.js'),ctx,{filename:'js/wheelbacktest.js'}); // _wheelBacktestDateStr
  vm.runInContext(src('js/patterns.js'),ctx,{filename:'js/patterns.js'});
  return ctx;
}
// Values crossing the vm boundary are JSON-cloned so deepStrictEqual does
// not trip over cross-realm Array/Object prototypes.
function call(ctx,fn,...args){
  ctx.__args=args;
  const r=vm.runInContext(`JSON.stringify(${fn}(...__args))`,ctx);
  return r===undefined?undefined:JSON.parse(r);
}
function callRaw(ctx,fn,...args){ ctx.__args=args; return vm.runInContext(`${fn}(...__args)`,ctx); }

let pass=0,fail=0;
function test(name,fn){
  try{ fn(); pass++; console.log('  ok  --',name); }
  catch(e){ fail++; console.log('FAIL  --',name); console.log('      '+(e && e.stack ? e.stack.split('\n').slice(0,3).join('\n      ') : e)); }
}
function section(name){ console.log('\n== '+name+' =='); }

const ctx=buildContext();

// series([[value,count],...]) -> flat array of closes.
function series(parts){const a=[];parts.forEach(([v,c])=>{for(let i=0;i<c;i++)a.push(v);});return a;}
const mirror=a=>a.map(v=>v==null?null:200-v);
// Epoch-second timestamps, one per calendar day (dates are not asserted exactly).
const tsFor=n=>Array.from({length:n},(_,i)=>1735819200+i*86400);
function put(ticker,closes){ ctx.__h={timestamps:tsFor(closes.length),closes}; vm.runInContext(`S.set('hist2y_${ticker}',__h)`,ctx); }
function engine(closes){ return call(ctx,'_computePatternsFromSeries',closes,tsFor(closes.length)); }
const near=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<=eps,`expected ${a} ~ ${b}`);

// BASE ground truth (hand-derived):
//   idx 0-249 = 100, idx 250-299 = 90, idx 300-330 = 120  (length 331)
//   For i = 300+m: SMA50 = (30m+4530)/50 = 90.6+0.6m ; SMA200 = 97.6+0.1m.
//   m=14: both exactly 99 (diff 0 -> ignored). m=15 (idx 315): 99.6 vs 99.1 -> first
//   bar where 50-day is above 200-day. Before that the 50-day was BELOW (from idx 250),
//   so the one cross is a golden cross at idx 315.
const BASE=series([[100,250],[90,50],[120,31]]);

// ============================================================================
section('computeSMA');

test('basic mean of last N, aligned, leading nulls',()=>{
  const out=call(ctx,'computeSMA',[1,2,3,4,5,6,7,8,9,10],3);
  assert.deepStrictEqual(out,[null,null,2,3,4,5,6,7,8,9]);
});
test('a gap is skipped, not averaged in, and the output stays aligned',()=>{
  // idx3 window of last 3 valid = [1,2,4]; idx4 = [2,4,5]; idx5 = [4,5,6]
  const out=call(ctx,'computeSMA',[1,2,null,4,5,6],3);
  assert.strictEqual(out.length,6);
  assert.strictEqual(out[2],null,'the null position itself stays null');
  near(out[3],7/3); near(out[4],11/3); near(out[5],5);
});
test('NaN / undefined / strings are treated as missing; short input and bad input are safe',()=>{
  const out=call(ctx,'computeSMA',[1,NaN,undefined,'x',2,3],2);
  assert.deepStrictEqual(out.map(v=>v==null?null:v),[null,null,null,null,1.5,2.5]);
  assert.deepStrictEqual(call(ctx,'computeSMA',[1,2],5),[null,null]);
  assert.deepStrictEqual(call(ctx,'computeSMA',null,5),[]);
});

// ============================================================================
section('_patFindCrosses (hand-specified SMA arrays)');

test('golden, death, golden with a touch of zero in between',()=>{
  // diffs vs slow=3: -2,-1,0,+1,+2,0,-1,-2,+1  -> golden@4, death@7, golden@9
  const fast=[null,1,2,3,4,5,3,2,1,4],slow=[null,3,3,3,3,3,3,3,3,3];
  const r=call(ctx,'_patFindCrosses',fast,slow);
  assert.deepStrictEqual(r.crosses,[{type:'golden',idx:4},{type:'death',idx:7},{type:'golden',idx:9}]);
  assert.strictEqual(r.trendSign,1);
});
test('touching the other line and bouncing back is NOT a cross',()=>{
  const r=call(ctx,'_patFindCrosses',[4,3,4],[3,3,3]);
  assert.deepStrictEqual(r.crosses,[]);
});
test('the first relation seen is the starting state, not a cross',()=>{
  const r=call(ctx,'_patFindCrosses',[1,1,1],[2,2,2]);
  assert.deepStrictEqual(r.crosses,[]);
  assert.strictEqual(r.trendSign,-1);
});
test('a null bar is skipped; a cross during the gap is reported on the first valid bar after it',()=>{
  const r=call(ctx,'_patFindCrosses',[1,null,4],[3,3,3]);
  assert.deepStrictEqual(r.crosses,[{type:'golden',idx:2}]);
});
test('float noise within tolerance does not invent crosses (with a negative control)',()=>{
  assert.deepStrictEqual(call(ctx,'_patFindCrosses',[4,3-1e-13,4],[3,3,3]).crosses,[],'a 1e-13 dip is a touch, not a death+golden pair');
  assert.deepStrictEqual(call(ctx,'_patFindCrosses',[2,3+1e-13,4],[3,3,3]).crosses,[{type:'golden',idx:2}],'the cross lands on the first bar clearly above');
  // negative control: a real (large) dip below DOES cross, so the tolerance is not just hiding everything
  assert.strictEqual(call(ctx,'_patFindCrosses',[4,2.9,4],[3,3,3]).crosses.length,2);
});
test('whipsaw: second cross within 60 bars of the first',()=>{
  assert.strictEqual(callRaw(ctx,'_patWhipsaw',[{idx:100},{idx:160}]),true);
  assert.strictEqual(callRaw(ctx,'_patWhipsaw',[{idx:100},{idx:161}]),false);
  assert.strictEqual(callRaw(ctx,'_patWhipsaw',[{idx:100}]),false);
});

// ============================================================================
section('Engine on constructed ground truth');

test('BASE: SMA values match the hand derivation around the cross',()=>{
  const s50=call(ctx,'computeSMA',BASE,50),s200=call(ctx,'computeSMA',BASE,200);
  assert.strictEqual(s50[314],99); assert.strictEqual(s200[314],99);
  near(s50[315],99.6); near(s200[315],99.1);
});
test('BASE: exactly one golden cross at idx 315, active, trend above, no 52W events',()=>{
  const p=engine(BASE);
  assert.strictEqual(p.lastIdx,330);
  assert.strictEqual(p.hasSMA200,true);
  assert.deepStrictEqual(p.crosses.map(c=>[c.type,c.idx,c.daysAgo]),[['golden',315,15]]);
  assert.strictEqual(p.trend,'above');
  assert.deepStrictEqual(p.events.map(e=>[e.kind,e.daysAgo]),[['golden',15]]);
  assert.strictEqual(p.week52.hiIdx,300); assert.strictEqual(p.week52.loIdx,250);
});
test('recency window boundary: 19 bars ago is active, 20 is not (cross stays in the history list)',()=>{
  const at=len=>engine(BASE.concat(series([[120,len-BASE.length]])));
  const a=at(335);  // lastIdx 334 -> daysAgo 19
  assert.deepStrictEqual(a.events.map(e=>e.daysAgo),[19]);
  const b=at(336);  // daysAgo 20
  assert.deepStrictEqual(b.events,[]);
  assert.strictEqual(b.lastCross.daysAgo,20);
});
test('mirror image gives a death cross at the same bar, trend below, red bias',()=>{
  const p=engine(mirror(BASE));
  assert.deepStrictEqual(p.crosses.map(c=>[c.type,c.idx]),[['death',315]]);
  assert.strictEqual(p.trend,'below');
  assert.deepStrictEqual(p.events.map(e=>[e.kind,e.bias]),[['death','bearish']]);
});
test('a missing bar INSIDE both windows (idx 290) leaves the cross at idx 315 (hand-derived)',()=>{
  // SMA50 unchanged (needs <=49 of the 90s, 49 remain); SMA200 = 97.65+0.1m, so 0.5m>7.05 -> m=15 again.
  const c=BASE.slice(); c[290]=null;
  const p=engine(c);
  assert.deepStrictEqual(p.crosses.map(x=>[x.type,x.idx]),[['golden',315]]);
  assert.strictEqual(call(ctx,'computeSMA',c,50)[290],null);
});
test('a missing bar outside the windows (idx 100) changes nothing',()=>{
  const c=BASE.slice(); c[100]=null;
  assert.deepStrictEqual(engine(c).crosses.map(x=>[x.type,x.idx]),[['golden',315]]);
});
test('unsettled/missing trailing bars are ignored: same cross, same daysAgo',()=>{
  const c=BASE.concat([null,null]);
  const p=engine(c);
  assert.strictEqual(p.lastIdx,330);
  assert.deepStrictEqual(p.events.map(e=>[e.kind,e.daysAgo]),[['golden',15]]);
});
test('short history (150 bars): no SMA200, no crosses, no events',()=>{
  const p=engine(BASE.slice(0,150));
  assert.strictEqual(p.hasSMA200,false);
  assert.deepStrictEqual(p.crosses,[]); assert.deepStrictEqual(p.events,[]);
  assert.strictEqual(p.validBars,150);
});
test('whipsaw integration: golden@315 then death@342 (hand-derived j>11.43 -> j=12)',()=>{
  // after idx 330: 30 bars of 40. SMA50=108.6-j, SMA200=100.6-0.3j -> cross when 0.7j>8 -> j=12 -> idx 342.
  const p=engine(BASE.concat(series([[40,30]])));
  assert.deepStrictEqual(p.crosses.map(c=>[c.type,c.idx]),[['golden',315],['death',342]]);
  assert.strictEqual(p.whipsaw,true,'27 bars apart');
  assert.deepStrictEqual(p.events.map(e=>[e.kind,e.daysAgo]),[['death',18]],'only the most recent cross is an active event');
});

test('two crosses but the latest is stale (33 bars ago): no active event, history still lists both',()=>{
  const p=engine(BASE.concat(series([[40,45]]))); // death@342, lastIdx 375 -> daysAgo 33
  assert.deepStrictEqual(p.crosses.map(c=>[c.type,c.idx]),[['golden',315],['death',342]]);
  assert.strictEqual(p.lastCross.daysAgo,33);
  assert.deepStrictEqual(p.events,[]);
});

// ============================================================================
section('52-week high / low events');

test('new closing high today -> high52, daysAgo 0 (and no spurious cross)',()=>{
  const p=engine(series([[100,280],[101,1],[102,1],[103,1]]));
  assert.deepStrictEqual(p.events.map(e=>[e.kind,e.daysAgo]),[['high52',0]]);
  assert.deepStrictEqual(p.crosses,[]);
});
test('new closing low today -> low52 (mirror)',()=>{
  const p=engine(mirror(series([[100,280],[101,1],[102,1],[103,1]])));
  // mirror of a rising tail is a falling tail: lows 99,98,97
  assert.deepStrictEqual(p.events.map(e=>[e.kind,e.bias,e.daysAgo]),[['low52','bearish',0]]);
});
test('boundary: high set 4 bars ago is active, 5 bars ago is not',()=>{
  const mk=k=>engine(series([[100,280],[105,1],[104,k]]));
  assert.deepStrictEqual(mk(4).events.map(e=>[e.kind,e.daysAgo]),[['high52',4]]);
  assert.deepStrictEqual(mk(5).events,[]);
});
test('a close that only ties an earlier high is not a new high (first occurrence wins)',()=>{
  const p=engine(series([[100,270],[105,1],[100,19],[105,1]]));
  assert.strictEqual(p.week52.hiIdx,270);
  assert.deepStrictEqual(p.events,[]);
});
test('under 252 bars: SMA state works but there are no 52W claims',()=>{
  const p=engine(series([[100,240],[110,1]]));
  assert.strictEqual(p.hasSMA200,true);
  assert.strictEqual(p.week52,null);
  assert.deepStrictEqual(p.events,[]);
});
test('trailing null bars do not move the 52W window (daysAgo measured from last real bar)',()=>{
  const p=engine(series([[100,280],[110,1]]).concat([null]));
  assert.deepStrictEqual(p.events.map(e=>[e.kind,e.daysAgo]),[['high52',0]]);
});

// ============================================================================
section('Agreement with the 52W tiles (_compute52W) and a naive reference');

function extractFn(code,name){
  const start=code.indexOf('function '+name+'(');
  if(start<0)throw new Error('cannot find '+name);
  let i=code.indexOf('{',start),depth=0;
  for(;i<code.length;i++){ if(code[i]==='{')depth++; else if(code[i]==='}'){depth--; if(depth===0){i++;break;}} }
  return code.slice(start,i);
}
vm.runInContext(extractFn(src('js/ticker.js'),'_compute52W'),ctx);

function lcg(seed){let x=seed>>>0;return()=>{x=(Math.imul(x,1664525)+1013904223)>>>0;return x;};}
function walk(seed,n,withGaps){
  const r=lcg(seed);let px=100;const a=[];
  for(let i=0;i<n;i++){
    px=Math.max(5,px+((r()>>>16)%7)-3);
    a.push(withGaps&&(r()>>>16)%29===0?null:px);
  }
  return a;
}
function refCrosses(closes){
  const valid=[];closes.forEach((v,i)=>{if(typeof v==='number'&&isFinite(v))valid.push({i,v});});
  const mean=(k,p)=>{let s=0;for(let j=k-p+1;j<=k;j++)s+=valid[j].v;return s/p;};
  const out=[];let last=0;
  for(let k=199;k<valid.length;k++){
    const f=mean(k,50),s=mean(k,200),d=f-s;
    const tol=1e-9*Math.max(Math.abs(f),Math.abs(s),1);
    const sg=Math.abs(d)<=tol?0:(d>0?1:-1);
    if(sg===0)continue;
    if(last!==0&&sg!==last)out.push([sg>0?'golden':'death',valid[k].i]);
    last=sg;
  }
  return out;
}

test('badge and 52W tile agree on high/low and date across 40 randomized series with ties and gaps',()=>{
  for(let seed=1;seed<=40;seed++){
    const closes=walk(seed,300+seed*5,seed%2===0);
    const ts=tsFor(closes.length);
    const ext=call(ctx,'_patWeek52Extremes',closes);
    ctx.__in={closes,timestamps:ts};
    const tile=call(ctx,'_compute52W','X',ctx.__in);
    if(!ext){ assert.strictEqual(tile,null,'seed '+seed); continue; }
    const fmt=t=>new Date(t*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    assert.strictEqual(tile.high,closes[ext.hiIdx],'high, seed '+seed);
    assert.strictEqual(tile.low,closes[ext.loIdx],'low, seed '+seed);
    assert.strictEqual(tile.highDate,fmt(ts[ext.hiIdx]),'high date, seed '+seed);
    assert.strictEqual(tile.lowDate,fmt(ts[ext.loIdx]),'low date, seed '+seed);
  }
});
test('shipped crosses equal a naive reference on 40 randomized series (half with gaps)',()=>{
  let totalCrosses=0;
  for(let seed=1;seed<=40;seed++){
    const closes=walk(1000+seed,520,seed%2===0);
    const got=engine(closes).crosses.map(c=>[c.type,c.idx]);
    const want=refCrosses(closes);
    totalCrosses+=want.length;
    assert.deepStrictEqual(got,want,'seed '+seed);
  }
  assert.ok(totalCrosses>=10,'vacuity guard: the random series must actually contain crosses ('+totalCrosses+')');
});

// ============================================================================
section('Badges and card states');

test('active golden: watchlist bracket badge, outlined header pill, collapsed card with expander',()=>{
  put('GOLD',BASE);
  const wl=callRaw(ctx,'_patternWatchlistBadgeHtml','GOLD');
  assert.ok(wl.includes('[Golden Cross &middot; 15d]')); assert.ok(wl.includes('var(--green)'));
  const hd=callRaw(ctx,'_patternHeaderBadgeHtml','GOLD');
  assert.ok(hd.includes('Golden Cross')&&hd.includes('_patternsOpenFromHeader()')&&hd.includes('background:transparent'));
  assert.ok(!hd.includes('+1'));
  const card=callRaw(ctx,'_patternsCardHtml','GOLD');
  assert.ok(card.includes('id="patterns-card"')&&card.includes('id="patterns-chevron"'));
  assert.ok(card.includes('class="gs-body" id="patterns-body"'),'collapsed by default (no "open" class)');
  assert.ok(card.includes('_patternsToggle()'));
  assert.ok(card.includes('lags')&&card.includes('put selling')&&card.includes('Recent crosses in cached history'));
  assert.ok(/The 50-day average is above the 200-day \(since the golden cross on [A-Z][a-z]{2} \d{1,2}, \d{4}\)/.test(card),'status line with the cross date');
});
test('active death cross is red',()=>{
  put('DEATH',mirror(BASE));
  assert.ok(callRaw(ctx,'_patternWatchlistBadgeHtml','DEATH').includes('var(--red)'));
  assert.ok(callRaw(ctx,'_patternsCardHtml','DEATH').includes('Death Cross'));
});
test('quiet ticker: one line, NO expander, no badges',()=>{
  put('QUIET',BASE.concat(series([[120,69]]))); // golden 84 bars ago, length 400
  assert.strictEqual(callRaw(ctx,'_patternWatchlistBadgeHtml','QUIET'),'');
  assert.strictEqual(callRaw(ctx,'_patternHeaderBadgeHtml','QUIET'),'');
  const card=callRaw(ctx,'_patternsCardHtml','QUIET');
  assert.ok(card.includes('Patterns: none recent')&&card.includes('50-day above 200-day'));
  // idx 399 window = idx 200..399: 50x100 + 50x90 + 100x120 = 21500 -> SMA200 107.5 -> 120/107.5-1 = +11.6%
  assert.ok(card.includes('price +11.6% vs 200-day'),card);
  assert.ok(!card.includes('patterns-body')&&!card.includes('gs-header')&&!card.includes('gs-chevron'));
});
test('short history: one line saying so, no expander, no badges',()=>{
  put('SHORT',BASE.slice(0,150));
  assert.strictEqual(callRaw(ctx,'_patternWatchlistBadgeHtml','SHORT'),'');
  const card=callRaw(ctx,'_patternsCardHtml','SHORT');
  assert.ok(card.includes('needs 200 days of price history (150 cached so far)'));
  assert.ok(!card.includes('patterns-body'));
});
test('no data or malformed cache renders nothing and never throws',()=>{
  assert.strictEqual(callRaw(ctx,'_patternsCardHtml','NOPE'),'');
  assert.strictEqual(callRaw(ctx,'_patternHeaderBadgeHtml','NOPE'),'');
  vm.runInContext(`S.set('hist2y_BAD',{closes:'oops'})`,ctx);
  assert.strictEqual(callRaw(ctx,'_patternsCardHtml','BAD'),'');
  vm.runInContext(`S.set('hist2y_BAD2',{closes:[null,null,null]})`,ctx);
  assert.strictEqual(callRaw(ctx,'_patternsCardHtml','BAD2'),'');
});
test('two active events: cross first, 52W second, "+1" shown, card lists both',()=>{
  put('MULTI',BASE.concat([121])); // golden 16 bars ago + new 52W closing high today
  const p=engine(BASE.concat([121]));
  assert.deepStrictEqual(p.events.map(e=>[e.kind,e.daysAgo]),[['golden',16],['high52',0]]);
  assert.ok(callRaw(ctx,'_patternWatchlistBadgeHtml','MULTI').includes('Golden Cross &middot; 16d +1]'));
  assert.ok(callRaw(ctx,'_patternHeaderBadgeHtml','MULTI').includes('+1'));
  const card=callRaw(ctx,'_patternsCardHtml','MULTI');
  assert.ok(card.includes('52W High')&&card.includes('Golden Cross'));
});
test('whipsaw warning appears in the card only when the latest cross is a whipsaw',()=>{
  put('WHIP',BASE.concat(series([[40,30]])));
  assert.ok(callRaw(ctx,'_patternsCardHtml','WHIP').includes('Whipsaw: this is the second cross within 60 trading days'));
  put('NOWHIP',BASE);
  assert.ok(!callRaw(ctx,'_patternsCardHtml','NOWHIP').includes('Whipsaw'));
});
test('toggle and open-from-header drive the DOM the way the card expects',()=>{
  const cls=new Set(),chevCls=new Set();
  const mk=set=>({classList:{contains:c=>set.has(c),toggle:(c,on)=>{on?set.add(c):set.delete(c);}}});
  const body=mk(cls),chev=mk(chevCls);let scrolled=0;
  const card={scrollIntoView:()=>{scrolled++;}};
  ctx.document.getElementById=id=>id==='patterns-body'?body:id==='patterns-chevron'?chev:id==='patterns-card'?card:null;
  callRaw(ctx,'_patternsToggle'); assert.ok(cls.has('open')&&chevCls.has('open'));
  callRaw(ctx,'_patternsToggle'); assert.ok(!cls.has('open')&&!chevCls.has('open'));
  callRaw(ctx,'_patternsOpenFromHeader'); assert.ok(cls.has('open')&&scrolled===1,'opens and scrolls');
  callRaw(ctx,'_patternsOpenFromHeader'); assert.ok(cls.has('open')&&scrolled===2,'already open stays open, still scrolls');
  ctx.document.getElementById=()=>null;
  callRaw(ctx,'_patternsToggle'); callRaw(ctx,'_patternsOpenFromHeader'); // missing DOM: must not throw
});
test('the engine ignores the Total Return toggle: it reads raw closes only',()=>{
  vm.runInContext(`S.set('rp_total_return','on')`,ctx);
  ctx.__h={timestamps:tsFor(BASE.length),closes:BASE,adjcloses:BASE.map(v=>v*0.5)};
  vm.runInContext(`S.set('hist2y_TR',__h)`,ctx);
  const p=call(ctx,'_computePatternsForTicker','TR');
  assert.strictEqual(p.lastClose,120);
});

// ============================================================================
section('Wiring and documentation (guards against forgetting to register a new file)');

test('index.html loads patterns.js after helpers.js and before watchlist.js/ticker.js',()=>{
  const html=src('index.html');
  const pos=n=>html.indexOf('<script src="./js/'+n+'"></script>');
  assert.ok(pos('patterns.js')>pos('helpers.js')&&pos('helpers.js')>=0);
  assert.ok(pos('patterns.js')<pos('watchlist.js')&&pos('patterns.js')<pos('ticker.js'));
  assert.strictEqual(html.split('<script src="./js/patterns.js"></script>').length-1,1,'exactly one tag');
});
test('sw.js caches patterns.js and CACHE_NAME / APP_BUILD are in sync (at least 553)',()=>{
  const sw=src('sw.js');
  assert.ok(sw.includes("'./js/patterns.js'"));
  const name=sw.match(/const CACHE_NAME = 'income-engine-v(\d+)'/)[1];
  const build=sw.match(/const APP_BUILD = (\d+)/)[1];
  assert.strictEqual(name,build); assert.ok(Number(build)>=553,'build is at least 553');
});
test('ticker.js and watchlist.js call the new functions',()=>{
  const t=src('js/ticker.js'),w=src('js/watchlist.js');
  assert.ok(t.includes('${_patternHeaderBadgeHtml(snap.ticker)}'));
  assert.ok(t.includes('${_patternsCardHtml(snap.ticker)}'));
  assert.ok(w.includes('_patternWatchlistBadgeHtml(t)'));
  assert.ok(!/_patternsCardHtml\([^)]*hist2y/.test(t),'the card must not be fed the Ticker tab\'s transformed (possibly adjusted) hist2y');
});
test('Guide documents the pattern badges',()=>{
  const html=src('index.html');
  const guide=html.split('<div id="tab-guide" class="tab-panel">')[1].split('<!-- SETTINGS OVERLAY -->')[0];
  for(const phrase of ['Pattern Badges','Golden Cross','Death Cross','Whipsaw','52W High / 52W Low','History needed','Context, not predictions','pattern badges (golden/death cross, 52-week high/low)'])
    assert.ok(guide.includes(phrase),'Guide missing: '+phrase);
});

// ============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
