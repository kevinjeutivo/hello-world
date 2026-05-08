// PutSeller Pro scoring.js
// Purpose: conviction scoring formulas with rebalanced weights and dynamic multipliers.
// Weight multipliers are read from localStorage (set in Settings).
// Version: scoring-v2

// ─── DEFAULT FACTOR WEIGHTS ───
// Each weight is a multiplier (0.0 – 3.0) applied to the base point contribution.
// Defaults reflect the stated importance hierarchy:
//   IVR most important (premium environment), then RSI/Range, then APY,
//   with Earnings as a pure penalty and MA/Beta/Upside as modifiers.
const DEFAULT_WEIGHTS={
  ivr:1.0,      // IVR -- implied volatility rank (premium opportunity)
  rsi:1.0,      // RSI -- momentum / overbought-oversold
  range:1.0,    // Range -- 52W position
  apy:1.0,      // APY -- estimated yield vs target
  earnings:1.0, // Earnings timing -- penalty multiplier
  ma:1.0,       // MA -- 50/200-day trend confirmation
  upside:1.0,   // Analyst target upside
  beta:1.0      // Beta -- high beta penalty
};

function getWeights(){
  try{
    const stored=typeof S!=='undefined'?S.get('conviction_weights'):null;
    if(!stored)return DEFAULT_WEIGHTS;
    // Merge stored with defaults to handle new keys added in future versions
    return{...DEFAULT_WEIGHTS,...stored};
  }catch{return DEFAULT_WEIGHTS;}
}

// ─── BASE POINT VALUES (before weight multiplier applied) ───
// These are the raw point contributions at each threshold.
// IVR: max +3 (most important -- elevated premium is the core thesis)
// RSI: max +2 / min -2
// Range: max +2 / min -1
// APY: max +2 / min 0 (now contributes to raw score, not just bar strip)
// Earnings: max 0 / min -2 (pure penalty)
// MA: +1 / -1 (trend confirmation)
// Analyst upside: +1 (consensus target >15% above price)
// Beta: 0 / -1 (penalty for high-beta names)

function scorePuts({price,rsiVal,ma50,ma200,rangePos,earningsDate,recStrike,expiration,estApy,ivrVal,ptMean,beta}){
  const w=getWeights();
  let score=0;const reasons=[],details=[];

  // ── IVR (max raw +3, min 0) ──
  let ivrRaw=0,ivrScore=0;
  if(ivrVal!==null&&!isNaN(ivrVal)){
    if(ivrVal>=70){ivrRaw=3;reasons.push(`IVR ${ivrVal.toFixed(0)} (very high)`);details.push(`IV ${ordinal(ivrVal)} pct -- exceptional premium`);}
    else if(ivrVal>=60){ivrRaw=2;details.push(`IV ${ordinal(ivrVal)} pct -- elevated premium`);}
    else if(ivrVal>=40){ivrRaw=1;details.push(`IV ${ordinal(ivrVal)} pct -- normal`);}
    else if(ivrVal<20){ivrRaw=-1;details.push(`IV ${ordinal(ivrVal)} pct -- thin premiums`);}
    else{ivrRaw=0;details.push(`IV ${ordinal(ivrVal)} pct -- below average`);}
    ivrScore=ivrVal>=70?3:ivrVal>=60?2:ivrVal>=40?1:ivrVal<20?-1:0;
  }
  score+=ivrRaw*w.ivr;

  // ── RSI (max raw +2, min -2) ──
  let rsiRaw=0,rsiScore=0;
  if(rsiVal!==null&&!isNaN(rsiVal)){
    if(rsiVal<35){rsiRaw=2;reasons.push(`RSI oversold (${rsiVal.toFixed(0)})`);details.push(`RSI ${rsiVal.toFixed(0)} -- oversold`);}
    else if(rsiVal<50){rsiRaw=1;details.push(`RSI ${rsiVal.toFixed(0)} -- neutral-low`);}
    else if(rsiVal>70){rsiRaw=-2;reasons.push(`RSI overbought (${rsiVal.toFixed(0)})`);details.push(`RSI ${rsiVal.toFixed(0)} -- overbought, caution`);}
    else if(rsiVal>60){rsiRaw=-1;details.push(`RSI ${rsiVal.toFixed(0)} -- elevated`);}
    else{rsiRaw=0;details.push(`RSI ${rsiVal.toFixed(0)} -- neutral`);}
    rsiScore=rsiVal<35?3:rsiVal<50?2:rsiVal>70?-1:rsiVal>60?0:1;
  }
  score+=rsiRaw*w.rsi;

  // ── Range position (max raw +2, min -1) ──
  let rangeRaw=0,rangeScore=0;
  if(rangePos!==null){
    const pct=(rangePos*100).toFixed(0);
    if(rangePos<0.35){rangeRaw=2;reasons.push(`Lower 52W range (${pct}%)`);details.push(`${pct}% of 52W range -- near lows, favorable`);}
    else if(rangePos<0.55){rangeRaw=1;details.push(`${pct}% of 52W range -- lower half`);}
    else if(rangePos>0.85){rangeRaw=-1;details.push(`${pct}% of 52W range -- near highs, caution`);}
    else{rangeRaw=0;details.push(`${pct}% of 52W range`);}
    rangeScore=rangePos<0.35?3:rangePos<0.55?2:rangePos>0.85?-1:1;
  }
  score+=rangeRaw*w.range;

  // ── APY (max raw +2, min 0) -- now contributes to raw score ──
  let apyRaw=0,apyScore=0;
  if(estApy&&recStrike){
    const apyVal=parseFloat(estApy);
    if(apyVal>=16){apyRaw=2;details.push(`${estApy} APY -- exceptional`);}
    else if(apyVal>=12){apyRaw=1;details.push(`${estApy} APY -- at target`);}
    else if(apyVal>=8){apyRaw=0;details.push(`${estApy} APY -- below target`);}
    else{apyRaw=-1;details.push(`${estApy} APY -- thin`);}
    apyScore=apyVal>=16?3:apyVal>=12?2:apyVal>=8?1:0;
    details.push(`Rec ${recStrike} @ ${estApy} (${expiration})`);
  }
  score+=apyRaw*w.apy;

  // ── Earnings timing (max 0, min -2 -- pure penalty) ──
  let earnRaw=0,earnScore=0;
  if(earningsDate){
    const d=daysUntilDate(earningsDate.split(' ')[0])??Math.round((new Date(earningsDate.split(' ')[0])-new Date())/86400000);
    if(d>=0&&d<35){earnRaw=-2;reasons.push(`Earnings in ${d}d`);details.push(`Earnings in ${d} days -- avoid straddling`);}
    else if(d>=35&&d<60){earnRaw=-1;details.push(`Earnings in ${d} days -- monitor`);}
    else{earnRaw=0;details.push(`Earnings ${d}d away -- safe`);}
    earnScore=d>=0&&d<35?-1:d<60?0:2;
  }else{earnScore=1;}
  score+=earnRaw*w.earnings;

  // ── MA confirmation (max +1, min -1) ──
  let maRaw=0,maScore=0;
  if(ma50&&ma200&&price){
    if(price>ma50&&price>ma200){maRaw=1;details.push('Above both MAs');}
    else if(price<ma50&&price<ma200){maRaw=-1;details.push('Below both MAs -- caution');}
    else{maRaw=0;details.push('Mixed vs MAs');}
    maScore=price>ma50&&price>ma200?2:price<ma50&&price<ma200?-1:1;
  }
  score+=maRaw*w.ma;

  // ── Analyst target upside (max +1, min 0) ──
  let upsideRaw=0,upsideScore=0;
  if(ptMean&&price&&ptMean>0){
    const upsidePct=(ptMean-price)/price*100;
    if(upsidePct>=15){upsideRaw=1;details.push(`Analyst target $${ptMean.toFixed(0)} (+${upsidePct.toFixed(0)}% upside)`);}
    else if(upsidePct<0){upsideRaw=-1;details.push(`Analyst target below current ($${ptMean.toFixed(0)})`);}
    else{details.push(`Analyst target $${ptMean.toFixed(0)} (+${upsidePct.toFixed(0)}%)`);}
    upsideScore=upsidePct>=15?2:upsidePct>=5?1:upsidePct<0?-1:0;
  }
  score+=upsideRaw*w.upside;

  // ── Beta (max 0, min -1 -- penalty for high-beta names) ──
  let betaRaw=0,betaScore=0;
  if(beta!=null){
    if(beta>1.8){betaRaw=-1;details.push(`Beta ${beta.toFixed(1)} -- high volatility, wider buffer needed`);}
    else if(beta>1.3){betaRaw=0;details.push(`Beta ${beta.toFixed(1)} -- elevated`);}
    else if(beta<0.7&&beta>0){betaRaw=1;details.push(`Beta ${beta.toFixed(1)} -- low vol, stable`);}
    betaScore=beta>1.8?-1:beta>1.3?0:beta<0.7&&beta>0?2:1;
  }
  score+=betaRaw*w.beta;

  const signal=score>=3?'high':score>=1?'medium':'low';
  const components={ivr:ivrScore,rsi:rsiScore,range:rangeScore,apy:apyScore,earn:earnScore};
  // Normalize: range is now wider. Max theoretical ~14, min ~-8. Normalize to 0-100.
  const normScore=Math.round(Math.max(0,Math.min(100,(score+8)/22*100)));
  return{score:normScore,rawScore:score,signal,
    factors:reasons.slice(0,2).join(', ')||'Insufficient data',
    narrative:details.join('. '),
    recStrike:recStrike||'--',expiration:expiration||'--',estApy:estApy||'--',
    components};
}

function scoreCalls({price,rsiVal,ma50,ma200,rangePos,earningsDate,recStrike,expiration,estApy,ivrVal,ptMean,beta}){
  const w=getWeights();
  let score=0;const reasons=[],details=[];

  // ── IVR (same as puts) ──
  let ivrRaw=0,ivrScore=0;
  if(ivrVal!==null&&!isNaN(ivrVal)){
    if(ivrVal>=70){ivrRaw=3;reasons.push(`IVR ${ivrVal.toFixed(0)} (very high)`);details.push(`IV ${ordinal(ivrVal)} pct -- exceptional premium`);}
    else if(ivrVal>=60){ivrRaw=2;details.push(`IV ${ordinal(ivrVal)} pct -- elevated premium`);}
    else if(ivrVal>=40){ivrRaw=1;details.push(`IV ${ordinal(ivrVal)} pct -- normal`);}
    else if(ivrVal<20){ivrRaw=-1;details.push(`IV ${ordinal(ivrVal)} pct -- thin premiums`);}
    else{ivrRaw=0;details.push(`IV ${ordinal(ivrVal)} pct -- below average`);}
    ivrScore=ivrVal>=70?3:ivrVal>=60?2:ivrVal>=40?1:ivrVal<20?-1:0;
  }
  score+=ivrRaw*w.ivr;

  // ── RSI -- inverted for calls (overbought is favorable) ──
  let rsiRaw=0,rsiScore=0;
  if(rsiVal!==null&&!isNaN(rsiVal)){
    if(rsiVal>70){rsiRaw=2;reasons.push(`RSI overbought (${rsiVal.toFixed(0)})`);details.push(`RSI ${rsiVal.toFixed(0)} -- overbought, ideal for calls`);}
    else if(rsiVal>60){rsiRaw=1;details.push(`RSI ${rsiVal.toFixed(0)} -- elevated`);}
    else if(rsiVal<35){rsiRaw=-2;reasons.push(`RSI oversold (${rsiVal.toFixed(0)})`);details.push(`RSI ${rsiVal.toFixed(0)} -- oversold, do not cap upside`);}
    else if(rsiVal<50){rsiRaw=-1;details.push(`RSI ${rsiVal.toFixed(0)} -- neutral-low`);}
    else{rsiRaw=0;details.push(`RSI ${rsiVal.toFixed(0)} -- neutral`);}
    rsiScore=rsiVal>70?3:rsiVal>60?2:rsiVal<35?-1:rsiVal<50?0:1;
  }
  score+=rsiRaw*w.rsi;

  // ── Range -- inverted for calls (near highs is favorable) ──
  let rangeRaw=0,rangeScore=0;
  if(rangePos!==null){
    const pct=(rangePos*100).toFixed(0);
    if(rangePos>0.80){rangeRaw=2;reasons.push(`Upper 52W range (${pct}%)`);details.push(`${pct}% of 52W range -- near highs, favorable for calls`);}
    else if(rangePos>0.60){rangeRaw=1;details.push(`${pct}% of 52W range -- upper half`);}
    else if(rangePos<0.30){rangeRaw=-2;details.push(`${pct}% of 52W range -- near lows, avoid calls`);}
    else if(rangePos<0.50){rangeRaw=-1;details.push(`${pct}% of 52W range -- lower half`);}
    else{rangeRaw=0;details.push(`${pct}% of 52W range`);}
    rangeScore=rangePos>0.80?3:rangePos>0.60?2:rangePos<0.30?-1:rangePos<0.50?0:1;
  }
  score+=rangeRaw*w.range;

  // ── APY ──
  let apyRaw=0,apyScore=0;
  if(estApy&&recStrike){
    const apyVal=parseFloat(estApy);
    if(apyVal>=16){apyRaw=2;details.push(`${estApy} APY -- exceptional`);}
    else if(apyVal>=12){apyRaw=1;details.push(`${estApy} APY -- at target`);}
    else if(apyVal>=8){apyRaw=0;details.push(`${estApy} APY -- below target`);}
    else{apyRaw=-1;details.push(`${estApy} APY -- thin`);}
    apyScore=apyVal>=16?3:apyVal>=12?2:apyVal>=8?1:0;
    details.push(`Rec ${recStrike} @ ${estApy} (${expiration})`);
  }
  score+=apyRaw*w.apy;

  // ── Earnings timing (same penalty for calls) ──
  let earnRaw=0,earnScore=0;
  if(earningsDate){
    const d=daysUntilDate(earningsDate.split(' ')[0])??Math.round((new Date(earningsDate.split(' ')[0])-new Date())/86400000);
    if(d>=0&&d<35){earnRaw=-2;reasons.push(`Earnings in ${d}d`);details.push(`Earnings in ${d} days -- gap-up risk`);}
    else if(d>=35&&d<60){earnRaw=-1;details.push(`Earnings in ${d} days -- monitor`);}
    else{earnRaw=0;details.push(`Earnings ${d}d away -- safe`);}
    earnScore=d>=0&&d<35?-1:d<60?0:2;
  }else{earnScore=1;}
  score+=earnRaw*w.earnings;

  // ── MA (same as puts) ──
  let maRaw=0,maScore=0;
  if(ma50&&ma200&&price){
    if(price>ma50&&price>ma200){maRaw=1;details.push('Above both MAs -- momentum');}
    else if(price<ma50&&price<ma200){maRaw=-1;details.push('Below both MAs -- avoid capping upside');}
    else{maRaw=0;details.push('Mixed vs MAs');}
    maScore=price>ma50&&price>ma200?2:price<ma50&&price<ma200?-1:1;
  }
  score+=maRaw*w.ma;

  // ── Analyst upside -- for calls, target proximity matters differently ──
  let upsideRaw=0,upsideScore=0;
  if(ptMean&&price&&ptMean>0){
    const upsidePct=(ptMean-price)/price*100;
    // For calls: stock near or above analyst target = less room to run = slight penalty
    if(upsidePct<-5){upsideRaw=-1;details.push(`Above analyst target -- limited upside per analysts`);}
    else if(upsidePct>=15){upsideRaw=1;details.push(`Analyst target $${ptMean.toFixed(0)} (+${upsidePct.toFixed(0)}% upside -- room to run)`);}
    else{details.push(`Analyst target $${ptMean.toFixed(0)}`);}
    upsideScore=upsidePct>=15?2:upsidePct>=5?1:upsidePct<-5?-1:0;
  }
  score+=upsideRaw*w.upside;

  // ── Beta -- for calls, high beta means more upside potential (neutral/slight positive) ──
  let betaRaw=0,betaScore=0;
  if(beta!=null){
    if(beta>1.5){betaRaw=0;details.push(`Beta ${beta.toFixed(1)} -- high vol, gap risk`);}
    else if(beta<0.7&&beta>0){betaRaw=-1;details.push(`Beta ${beta.toFixed(1)} -- low vol, limited upside`);}
    betaScore=beta>1.5?1:beta<0.7&&beta>0?-1:1;
  }
  score+=betaRaw*w.beta;

  const signal=score>=3?'high':score>=1?'medium':'low';
  const components={ivr:ivrScore,rsi:rsiScore,range:rangeScore,apy:apyScore,earn:earnScore};
  const normScore=Math.round(Math.max(0,Math.min(100,(score+8)/22*100)));
  return{score:normScore,rawScore:score,signal,
    factors:reasons.slice(0,2).join(', ')||'Insufficient data',
    narrative:details.join('. '),
    recStrike:recStrike||'--',expiration:expiration||'--',estApy:estApy||'--',
    components};
}
