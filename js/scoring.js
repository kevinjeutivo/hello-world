// PutSeller Pro scoring.js
// Purpose: conviction scoring formulas only.
// Version: scoring-v2 -- 9 component scores

// ═══ CONVICTION SCORING LOGIC ═══

// Maximum base point contribution per factor -- used by settings.js to
// compute each factor's share of the total possible score.
// Values reflect the highest positive score each factor can contribute
// in scorePuts / scoreCalls.
const FACTOR_BASE_MAX={
  ivr:3,
  rsi:3,
  range:3,
  apy:3,
  earnings:2,
  ma:2,
  upside:3,
  beta:3,
  oiGap:3
};

function scorePuts({price,rsiVal,ma50,ma200,rangePos,earningsDate,recStrike,expiration,estApy,ivrVal,ptMean,beta,oiGapPct}){
  let score=0;const reasons=[],details=[];const today=new Date();
  if(rsiVal!==null&&!isNaN(rsiVal)){if(rsiVal<35){score+=2;reasons.push(`RSI oversold (${rsiVal.toFixed(0)})`);details.push(`RSI ${rsiVal.toFixed(0)} -- oversold`);}else if(rsiVal<50){score+=1;details.push(`RSI ${rsiVal.toFixed(0)} -- neutral-low`);}else if(rsiVal>70){score-=2;reasons.push(`RSI overbought (${rsiVal.toFixed(0)})`);details.push(`RSI ${rsiVal.toFixed(0)} -- overbought, caution`);}else if(rsiVal>60){score-=1;details.push(`RSI ${rsiVal.toFixed(0)} -- elevated`);}else{details.push(`RSI ${rsiVal.toFixed(0)} -- neutral`);}}
  if(ma50&&ma200&&price){if(price>ma50&&price>ma200){score+=1;reasons.push('Above 50 & 200-day MA');details.push('Above both MAs');}else if(price<ma50&&price<ma200){score-=1;details.push('Below both MAs -- caution');}else{details.push('Mixed vs MAs');}}
  if(rangePos!==null){const pct=(rangePos*100).toFixed(0);if(rangePos<0.35){score+=2;reasons.push(`Lower 52W range (${pct}%)`);details.push(`${pct}% of 52W range -- near lows, favorable`);}else if(rangePos<0.55){score+=1;details.push(`${pct}% of 52W range -- lower half`);}else if(rangePos>0.85){score-=1;details.push(`${pct}% of 52W range -- near highs, caution`);}else{details.push(`${pct}% of 52W range`);}}
  if(earningsDate){const ed=new Date(earningsDate.split(' ')[0]);const days=Math.round((ed-today)/86400000);if(days>=0&&days<35){score-=2;reasons.push(`Earnings in ${days}d`);details.push(`Earnings in ${days} days -- avoid straddling`);}else if(days>=35&&days<60){details.push(`Earnings in ${days} days -- monitor`);}}
  if(ivrVal!==null&&!isNaN(ivrVal)){if(ivrVal>=70){score+=1;details.push(`IV ${ordinal(ivrVal)} pct -- high, rich premium`);}else if(ivrVal>=50){score+=1;details.push(`IV ${ordinal(ivrVal)} pct -- elevated premium`);}else if(ivrVal<30){details.push(`IV ${ordinal(ivrVal)} pct -- thin premiums`);}else{details.push(`IV ${ordinal(ivrVal)} pct -- normal`);}}
  if(estApy&&recStrike){details.push(`Rec ${recStrike} @ ${estApy} (${expiration})`);}
  const signal=score>=3?'high':score>=1?'medium':'low';

  // ── Per-component scores (−1 negative, 0 neutral, 1 low, 2 good, 3 best) ──
  // Unified IVR scale: <30 Low | 30-49 Normal | 50-69 Elevated | >=70 High
  const ivrScore  = ivrVal===null?0:(ivrVal>=70?3:ivrVal>=50?2:ivrVal>=30?1:-1);
  const rsiScore  = rsiVal===null?0:(rsiVal<35?3:rsiVal<50?2:rsiVal>70?-1:rsiVal>60?0:1);
  const rangeScore= rangePos===null?0:(rangePos<0.35?3:rangePos<0.55?2:rangePos>0.85?-1:1);
  const apyScore  = !estApy?0:(parseFloat(estApy)>=12?3:parseFloat(estApy)>=8?2:parseFloat(estApy)>=5?1:0);
  const earnScore = !earningsDate?1:(()=>{const d=daysUntilDate(earningsDate.split(' ')[0])??Math.round((new Date(earningsDate.split(' ')[0])-new Date())/86400000);return d>=0&&d<35?-1:d<60?0:2;})();

  // MA: bull trend above both MAs favors put selling (support beneath)
  const maScore   = (!ma50||!ma200||!price)?0:(price>ma50&&price>ma200?2:price<ma50&&price<ma200?-1:1);

  // Upside: analyst mean price target vs current price
  // For puts: more upside = higher floor conviction
  const upsideScore= (!ptMean||!price)?0:(()=>{
    const upside=(ptMean-price)/price*100;
    return upside>=20?3:upside>=10?2:upside>=0?1:-1;
  })();

  // Beta: for put selling, lower beta = lower gap risk
  // >1.5 is risky, 0.8-1.5 normal, <0.8 conservative
  const betaScore = (beta===null||beta===undefined)?0:(beta<0.8?3:beta<=1.2?2:beta<=1.8?1:-1);

  // OI gravity gap: distance from current price to max put OI strike
  // Wider gap below = more cushion for put sellers
  const oiGapScore= (oiGapPct===null||oiGapPct===undefined)?0:(oiGapPct>=10?3:oiGapPct>=5?2:oiGapPct>=2?1:-1);

  const components={ivr:ivrScore,rsi:rsiScore,range:rangeScore,apy:apyScore,earn:earnScore,ma:maScore,upside:upsideScore,beta:betaScore,oiGap:oiGapScore};
  const normScore=Math.round(Math.max(0,Math.min(100,(score+8)/20*100)));
  return{score:normScore,rawScore:score,signal,factors:reasons.slice(0,2).join(', ')||'Insufficient data',narrative:details.join('. '),recStrike:recStrike||'--',expiration:expiration||'--',estApy:estApy||'--',components};
}

function scoreCalls({price,rsiVal,ma50,ma200,rangePos,earningsDate,recStrike,expiration,estApy,ivrVal,ptMean,beta,oiGapPct}){
  let score=0;const reasons=[],details=[];const today=new Date();
  if(rsiVal!==null&&!isNaN(rsiVal)){if(rsiVal>70){score+=2;reasons.push(`RSI overbought (${rsiVal.toFixed(0)})`);details.push(`RSI ${rsiVal.toFixed(0)} -- overbought, ideal for calls`);}else if(rsiVal>60){score+=1;details.push(`RSI ${rsiVal.toFixed(0)} -- elevated`);}else if(rsiVal<35){score-=2;reasons.push(`RSI oversold (${rsiVal.toFixed(0)})`);details.push(`RSI ${rsiVal.toFixed(0)} -- oversold, do not cap upside`);}else if(rsiVal<50){score-=1;details.push(`RSI ${rsiVal.toFixed(0)} -- neutral-low`);}else{details.push(`RSI ${rsiVal.toFixed(0)} -- neutral`);}}
  if(ma50&&ma200&&price){if(price>ma50&&price>ma200){score+=1;reasons.push('Above 50 & 200-day MA');details.push('Above both MAs -- momentum');}else if(price<ma50&&price<ma200){score-=1;details.push('Below both MAs -- avoid capping upside');}else{details.push('Mixed vs MAs');}}
  if(rangePos!==null){const pct=(rangePos*100).toFixed(0);if(rangePos>0.80){score+=2;reasons.push(`Upper 52W range (${pct}%)`);details.push(`${pct}% of 52W range -- near highs, favorable for calls`);}else if(rangePos>0.60){score+=1;details.push(`${pct}% of 52W range -- upper half`);}else if(rangePos<0.30){score-=2;details.push(`${pct}% of 52W range -- near lows, avoid calls`);}else if(rangePos<0.50){score-=1;details.push(`${pct}% of 52W range -- lower half`);}else{details.push(`${pct}% of 52W range`);}}
  if(earningsDate){const ed=new Date(earningsDate.split(' ')[0]);const days=Math.round((ed-today)/86400000);if(days>=0&&days<35){score-=2;reasons.push(`Earnings in ${days}d`);details.push(`Earnings in ${days} days -- gap-up risk`);}else if(days>=35&&days<60){details.push(`Earnings in ${days} days -- monitor`);}}
  if(ivrVal!==null&&!isNaN(ivrVal)){if(ivrVal>=70){score+=1;details.push(`IV ${ordinal(ivrVal)} pct -- high, rich premium`);}else if(ivrVal>=50){score+=1;details.push(`IV ${ordinal(ivrVal)} pct -- elevated premium`);}else if(ivrVal<30){details.push(`IV ${ordinal(ivrVal)} pct -- thin premiums`);}else{details.push(`IV ${ordinal(ivrVal)} pct -- normal`);}}
  if(estApy&&recStrike){details.push(`Rec ${recStrike} @ ${estApy} (${expiration})`);}
  const signal=score>=3?'high':score>=1?'medium':'low';

  // ── Per-component scores for calls (inverted logic vs puts for RSI/range) ──
  // Unified IVR scale: <30 Low | 30-49 Normal | 50-69 Elevated | >=70 High
  const ivrScore  = ivrVal===null?0:(ivrVal>=70?3:ivrVal>=50?2:ivrVal>=30?1:-1);
  const rsiScore  = rsiVal===null?0:(rsiVal>70?3:rsiVal>60?2:rsiVal<35?-1:rsiVal<50?0:1);
  const rangeScore= rangePos===null?0:(rangePos>0.80?3:rangePos>0.60?2:rangePos<0.30?-1:rangePos<0.50?0:1);
  const apyScore  = !estApy?0:(parseFloat(estApy)>=12?3:parseFloat(estApy)>=8?2:parseFloat(estApy)>=5?1:0);
  const earnScore = !earningsDate?1:(()=>{const d=daysUntilDate(earningsDate.split(' ')[0])??Math.round((new Date(earningsDate.split(' ')[0])-new Date())/86400000);return d>=0&&d<35?-1:d<60?0:2;})();

  // MA: for calls, above both MAs = momentum = favorable
  const maScore   = (!ma50||!ma200||!price)?0:(price>ma50&&price>ma200?2:price<ma50&&price<ma200?-1:1);

  // Upside: for calls, less analyst upside = closer to ceiling = more favorable to sell
  const upsideScore= (!ptMean||!price)?0:(()=>{
    const upside=(ptMean-price)/price*100;
    return upside<=5?3:upside<=15?2:upside<=30?1:-1;
  })();

  // Beta: for call selling, higher beta = more premium but more gap risk
  // Moderate beta 1.0-1.5 is sweet spot for covered calls
  const betaScore = (beta===null||beta===undefined)?0:(beta>=1.0&&beta<=1.5?3:beta>1.5&&beta<=2.0?2:beta<1.0?1:-1);

  // OI gravity gap: distance from price to max call OI strike above
  // Wider gap above = more room before getting called away
  const oiGapScore= (oiGapPct===null||oiGapPct===undefined)?0:(oiGapPct>=10?3:oiGapPct>=5?2:oiGapPct>=2?1:-1);

  const components={ivr:ivrScore,rsi:rsiScore,range:rangeScore,apy:apyScore,earn:earnScore,ma:maScore,upside:upsideScore,beta:betaScore,oiGap:oiGapScore};
  const normScore=Math.round(Math.max(0,Math.min(100,(score+8)/20*100)));
  return{score:normScore,rawScore:score,signal,factors:reasons.slice(0,2).join(', ')||'Insufficient data',narrative:details.join('. '),recStrike:recStrike||'--',expiration:expiration||'--',estApy:estApy||'--',components};
}
