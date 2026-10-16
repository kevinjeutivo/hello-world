#!/usr/bin/env node
'use strict';
// tests/vp-level-format.test.js -- coverage for the build-528 Volume Profile
// display fix: formatVPLevel (helpers.js), which replaced a flat
// .toFixed(0) on Support/Resistance levels. The reported bug: KMI's current
// price displayed as "$33.35" (2 decimals) while a resistance level that was
// genuinely a sliver above it displayed as "$33" (0 decimals) right next to
// it, making a level the app itself classified as ABOVE current price
// visually read as at-or-below it.
//
// formatVPLevel is loaded verbatim from the real helpers.js via vm, not
// reimplemented, so these tests exercise the actual shipped function. Most
// assertions check the INVARIANT the function promises (correct ordering
// after rounding) rather than a hardcoded expected string, since exact
// decimal-rounding output for a given float is often non-obvious by hand
// (see the dedicated float-quirk test below) -- every fixture used here was
// verified by running the real function first, not computed by hand.
//
// Usage: node tests/vp-level-format.test.js

const fs=require('fs');
const path=require('path');
const vm=require('vm');
const assert=require('assert');

const ROOT=path.join(__dirname,'..');
const ctx={console,window:{}};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT,'js/helpers.js'),'utf8'),ctx);

function fmt(level,currentPrice){
  ctx.__level=level;ctx.__cur=currentPrice;
  return vm.runInContext('formatVPLevel(__level,__cur)',ctx);
}
const num=r=>parseFloat(r.text.slice(1));

let pass=0,fail=0;
function test(name,fn){
  try{fn();pass++;console.log('  ok -- '+name);}
  catch(e){fail++;console.error('  FAIL -- '+name+'\n    '+e.stack.split('\n').slice(0,2).join('\n    '));}
}

// ── Direct reproduction of the reported bug ─────────────────────────────────

test('direct reproduction: a resistance level 6 tenths of a cent above a $33.35 current price no longer displays as $33',()=>{
  const currentPrice=33.3500;
  const level=33.3560; // genuinely above, and above the at-current-price threshold
  const r=fmt(level,currentPrice);
  assert.strictEqual(r.atCurrent,false);
  assert(num(r)>currentPrice,`resistance displayed as ${r.text} must read numerically greater than $${currentPrice.toFixed(2)}`);
  assert.notStrictEqual(r.text,'$33','the old .toFixed(0) bug produced exactly this -- confirms the fix actually replaced it');
});

// ── Rounding across the current price ───────────────────────────────────────

test('a level that would tie with current price at 2 decimals gets a 3rd decimal to resolve the tie, above side',()=>{
  // Verified directly: 33.3456 and 33.3516 both round to "33.35" at 2dp.
  const currentPrice=33.3456,level=33.3516;
  assert.strictEqual(currentPrice.toFixed(2),level.toFixed(2),'fixture sanity check: these must actually tie at 2dp for this test to mean anything');
  const r=fmt(level,currentPrice);
  assert.strictEqual(r.atCurrent,false);
  assert(num(r)>currentPrice,`expected ${r.text} to read above ${currentPrice}`);
  assert(r.text.length>'$33.35'.length,'resolving a 2dp tie requires more than 2 decimals of display precision');
});

test('a level that would tie with current price at 2 decimals gets a 3rd decimal to resolve the tie, below side',()=>{
  const currentPrice=33.3456,level=33.3396;
  const r=fmt(level,currentPrice);
  assert.strictEqual(r.atCurrent,false);
  assert(num(r)<currentPrice,`expected ${r.text} to read below ${currentPrice}`);
});

test('a genuine 1-cent gap that floating-point rounding would otherwise tie at 2 decimals still resolves correctly',()=>{
  // Verified directly: (2.305).toFixed(2) === (2.315).toFixed(2) === '2.31'
  // due to IEEE754 representation, despite a true 1-cent difference -- this
  // is exactly the class of surprise the adaptive-precision loop exists for.
  const currentPrice=2.305,level=2.315;
  assert.strictEqual(currentPrice.toFixed(2),level.toFixed(2),'fixture sanity check: confirms the float-rounding tie this test is about');
  const r=fmt(level,currentPrice);
  assert.strictEqual(r.atCurrent,false,'a true 1-cent gap is well above the at-current-price threshold');
  assert(num(r)>currentPrice,`expected ${r.text} to read above ${currentPrice} despite both tying at 2 decimals`);
});

test('an ordinary, unambiguous whole-dollar gap above current price needs no extra precision',()=>{
  const r=fmt(34.00,33.35);
  assert.strictEqual(r.text,'$34.00');
  assert.strictEqual(r.atCurrent,false);
});

test('an ordinary, unambiguous whole-dollar gap below current price needs no extra precision',()=>{
  const r=fmt(32.00,33.35);
  assert.strictEqual(r.text,'$32.00');
  assert.strictEqual(r.atCurrent,false);
});

// ── Near-zero / "at current price" distances ────────────────────────────────

test('a level exactly equal to current price is reported as at current price',()=>{
  const r=fmt(33.35,33.35);
  assert.strictEqual(r.atCurrent,true);
  assert.strictEqual(r.text,'$33.35');
});

test('a level well within half a cent of current price is treated as at current price',()=>{
  const r=fmt(33.3520,33.3500); // 0.002 gap
  assert.strictEqual(r.atCurrent,true);
});

test('a gap intended to sit exactly on the half-cent threshold lands according to real float representation, not nominal arithmetic',()=>{
  // 33.3550 - 33.3500 is NOT exactly 0.005 in IEEE754 (it's
  // 0.0049999999999954525) -- verified directly. This documents that
  // reality rather than asserting a specific side blindly: the threshold
  // check uses the same floating-point subtraction the rest of the app
  // does, so it inherits the same float-equality caveats as everything
  // else here, and a fixture built to sit exactly on a boundary can't be
  // relied on to land on a particular side.
  const nominalGap=33.3550-33.3500;
  assert(nominalGap<0.005,'fixture sanity check: documents the actual float value this test relies on');
  const r=fmt(33.3550,33.3500);
  assert.strictEqual(r.atCurrent,true,'given the actual (sub-0.005) float delta above, at-current is the correct outcome here');
});

test('a gap unambiguously past the half-cent threshold is never at current price, regardless of float rounding',()=>{
  const r=fmt(33.3600,33.3500); // 0.01 gap -- nowhere near the boundary
  assert.strictEqual(r.atCurrent,false);
  assert(num(r)>33.35);
});

test('a level one tenth of a cent beyond the half-cent threshold is no longer at current price, and orders correctly',()=>{
  const r=fmt(33.3560,33.3500); // 0.006 gap
  assert.strictEqual(r.atCurrent,false);
  assert(num(r)>33.35);
});

// ── General correctness sweep ────────────────────────────────────────────────

test('a sweep of sub-to-super-threshold gaps around a current price always classifies and orders correctly',()=>{
  const currentPrice=47.9000;
  for(let tenthsOfCent=1;tenthsOfCent<=50;tenthsOfCent++){
    const delta=tenthsOfCent/10000; // 0.0001 .. 0.0050
    const above=fmt(currentPrice+delta,currentPrice);
    const below=fmt(currentPrice-delta,currentPrice);
    if(delta<0.005){
      assert.strictEqual(above.atCurrent,true,`delta=${delta}: should be at-current (above side)`);
      assert.strictEqual(below.atCurrent,true,`delta=${delta}: should be at-current (below side)`);
    }else{
      assert.strictEqual(above.atCurrent,false,`delta=${delta}: should not be at-current (above side)`);
      assert.strictEqual(below.atCurrent,false,`delta=${delta}: should not be at-current (below side)`);
      assert(num(above)>currentPrice,`delta=${delta}: ${above.text} must read above ${currentPrice}`);
      assert(num(below)<currentPrice,`delta=${delta}: ${below.text} must read below ${currentPrice}`);
    }
  }
});

test('precision never grows beyond what is actually needed',()=>{
  assert.strictEqual(fmt(40,35).text,'$40.00',"a wide, unambiguous gap should stay at the normal 2 decimals");
});

test('works at a low price scale (sub-$5 stock) where a cent is a larger proportion of price',()=>{
  const r=fmt(2.3520,2.3500); // 0.002 gap -- at-current at this scale too, same fixed threshold
  assert.strictEqual(r.atCurrent,true,'the at-current-price threshold is a fixed dollar amount, not scaled by price');
  const r2=fmt(2.3650,2.3500); // 0.015 gap -- clearly separated
  assert.strictEqual(r2.atCurrent,false);
  assert(num(r2)>2.35);
});

// ── Render wiring sanity checks ──────────────────────────────────────────────
// Confirms ticker.js's Volume Profile chart/analysis actually calls
// formatVPLevel (a correct function that's never invoked would pass every
// test above and still ship the original bug), and that classification
// (which bucket a level falls into) is still computed from the unrounded
// vpLevels/currentPrice comparison, not from anything display-rounded.
const tickerSrc=fs.readFileSync(path.join(ROOT,'js/ticker.js'),'utf8');

test('the old flat .toFixed(0) on S/R levels is gone from the VP chart label',()=>{
  assert(!tickerSrc.includes("'S/R $'+lvl.toFixed(0)"),
    'the chart label should no longer round S/R levels to whole dollars unconditionally');
});

test('the VP chart label and the analysis text both call formatVPLevel',()=>{
  assert(/fillText\('S\/R '\+formatVPLevel\(/.test(tickerSrc),'chart label must use formatVPLevel');
  const vpSection=tickerSrc.slice(tickerSrc.indexOf('Volume Profile shows where'));
  assert(/formatVPLevel\(ns,currentPrice\)/.test(vpSection),'support analysis text must use formatVPLevel');
  assert(/formatVPLevel\(nr,currentPrice\)/.test(vpSection),'resistance analysis text must use formatVPLevel');
});

test('support/resistance classification (vpBelow/vpAbove) still compares unrounded vpLevels against unrounded currentPrice',()=>{
  const vpSection=tickerSrc.slice(tickerSrc.indexOf('const vpBelow='),tickerSrc.indexOf('const vpBelow=')+300);
  assert(vpSection.includes('vpLevels.filter(l=>l<=currentPrice)'),'classification must stay based on the unrounded comparison, not a rounded one');
  assert(vpSection.includes('vpLevels.filter(l=>l>currentPrice)'));
});

test('an at-current-price level drops the "% above/below" framing and any buffer-based guidance, for both support and resistance',()=>{
  const vpSection=tickerSrc.slice(tickerSrc.indexOf('Volume Profile shows where'),tickerSrc.indexOf('Blue line = current price'));
  assert(vpSection.includes('at current price ('),'at-current-price levels must be described explicitly, not forced into above/below wording');
  // The atCurrent branch must not fall through to the buffer-guidance text
  const atCurrentSupport=vpSection.slice(vpSection.indexOf('fmt.atCurrent)analysis+=`\\nNearest VP support'),vpSection.indexOf('else{const pct=((currentPrice-ns)'));
  assert(!atCurrentSupport.includes('aligns with natural market maker buying'),'at-current support must not claim a put-selling buffer that does not exist');
  const atCurrentResistance=vpSection.slice(vpSection.indexOf('fmt.atCurrent)analysis+=`\\nNearest VP resistance'),vpSection.indexOf('else{const pct=((nr-currentPrice)'));
  assert(!atCurrentResistance.includes('uses natural resistance as a buffer'),'at-current resistance must not claim a covered-call buffer that does not exist');
});

console.log(pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
