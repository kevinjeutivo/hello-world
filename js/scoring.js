// ═══ CONVICTION SCORING LOGIC ═══

function scorePuts({price,rsiVal,ma50,ma200,rangePos,earningsDate,recStrike,expiration,estApy,ivrVal}){
  let score=0;const reasons=[],details=[];const today=new Date();
  if(rsiVal!==null&&!isNaN(rsiVal)){if(rsiVal<35){score+=2;reasons.push(`RSI oversold (${rsiVal.toFixed(0)})`);details.push(`RSI ${rsiVal.toFixed(0)} -- oversold`);}else if(rsiVal<50){score+=1;details.push(`RSI ${rsiVal.toFixed(0)} -- neutral-low`);}else if(rsiVal>70){score-=2;reasons.push(`RSI overbought (${rsiVal.toFixed(0)})`);details.push(`RSI ${rsiVal.toFixed(0)} -- overbought, caution`);}else if(rsiVal>60){score-=1;details.push(`RSI ${rsiVal.toFixed(0)} -- elevated`);}else{details.push(`RSI ${rsiVal.toFixed(0)} -- neutral`);}}
  if(ma50&&ma200&&price){if(price>ma50&&price>ma200){score+=1;reasons.push('Above 50 & 200-day MA');details.push('Above both MAs');}else if(price<ma50&&price<ma200){score-=1;details.push('Below both MAs -- caution');}else{details.push('Mixed vs MAs');}}
  if(rangePos!==null){const pct=(rangePos*100).toFixed(0);if(rangePos<0.35){score+=2;reasons.push(`Lower 52W range (${pct}%)`);details.push(`${pct}% of 52W range -- near lows, favorable`);}else if(rangePos<0.55){score+=1;details.push(`${pct}% of 52W range -- lower half`);}else if(rangePos>0.85){score-=1;details.push(`${pct}% of 52W range -- near highs, caution`);}else{details.push(`${pct}% of 52W range`);}}
  if(earningsDate){const ed=new Date(earningsDate.split(' ')[0]);const days=Math.round((ed-today)/86400000);if(days>=0&&days<35){score-=2;reasons.push(`Earnings in ${days}d`);details.push(`Earnings in ${days} days -- avoid straddling`);}else if(days>=35&&days<60){details.push(`Earnings in ${days} days -- monitor`);}}
  if(ivrVal!==null&&!isNaN(ivrVal)){if(ivrVal>=60){score+=1;details.push(`IV ${ordinal(ivrVal)} pct -- elevated premium`);}else if(ivrVal<30){details.push(`IV ${ordinal(ivrVal)} pct -- thin premiums`);}else{details.push(`IV ${ordinal(ivrVal)} pct -- normal`);}}
  if(estApy&&recStrike){details.push(`Rec ${recStrike} @ ${estApy} (${expiration})`);}
  const signal=score>=3?'high':score>=1?'medium':'low';
  // Compute per-component scores for the bar strip (0-3 scale, -1=negative)
  const rsiScore=rsiVal===null?0:(rsiVal<35?3:rsiVal<50?2:rsiVal>70?-1:rsiVal>60?0:1);
  const maScore=(!ma50||!ma200||!price)?0:(price>ma50&&price>ma200?2:price<ma50&&price<ma200?-1:1);
  const rangeScore=rangePos===null?0:(rangePos<0.35?3:rangePos<0.55?2:rangePos>0.85?-1:1);
  const earningsScore=!earningsDate?1:(()=>{const d=daysUntilDate(earningsDate.split(' ')[0])??Math.round((new Date(earningsDate.split(' ')[0])-new Date())/86400000);return d>=0&&d<35?-1:d<60?0:2;})();
  const ivrScore=ivrVal===null?0:(ivrVal>=60?3:ivrVal>=40?2:ivrVal>=20?1:-1);
  const apyScore=!estApy?0:(parseFloat(estApy)>=12?3:parseFloat(estApy)>=8?2:parseFloat(estApy)>=5?1:0);
  const components={ivr:ivrScore,rsi:rsiScore,range:rangeScore,apy:apyScore,earn:earningsScore};
  // Normalize score to 0-100 scale (max possible ~12, min ~-8)
  const normScore=Math.round(Math.max(0,Math.min(100,(score+8)/20*100)));
  return{score:normScore,rawScore:score,signal,factors:reasons.slice(0,2).join(', ')||'Insufficient data',narrative:details.join('. '),recStrike:recStrike||'--',expiration:expiration||'--',estApy:estApy||'--',components};
}
function scoreCalls({price,rsiVal,ma50,ma200,rangePos,earningsDate,recStrike,expiration,estApy,ivrVal}){
  let score=0;const reasons=[],details=[];const today=new Date();
  if(rsiVal!==null&&!isNaN(rsiVal)){if(rsiVal>70){score+=2;reasons.push(`RSI overbought (${rsiVal.toFixed(0)})`);details.push(`RSI ${rsiVal.toFixed(0)} -- overbought, ideal for calls`);}else if(rsiVal>60){score+=1;details.push(`RSI ${rsiVal.toFixed(0)} -- elevated`);}else if(rsiVal<35){score-=2;reasons.push(`RSI oversold (${rsiVal.toFixed(0)})`);details.push(`RSI ${rsiVal.toFixed(0)} -- oversold, do not cap upside`);}else if(rsiVal<50){score-=1;details.push(`RSI ${rsiVal.toFixed(0)} -- neutral-low`);}else{details.push(`RSI ${rsiVal.toFixed(0)} -- neutral`);}}
  if(ma50&&ma200&&price){if(price>ma50&&price>ma200){score+=1;reasons.push('Above 50 & 200-day MA');details.push('Above both MAs -- momentum');}else if(price<ma50&&price<ma200){score-=1;details.push('Below both MAs -- avoid capping upside');}else{details.push('Mixed vs MAs');}}
  if(rangePos!==null){const pct=(rangePos*100).toFixed(0);if(rangePos>0.80){score+=2;reasons.push(`Upper 52W range (${pct}%)`);details.push(`${pct}% of 52W range -- near highs, favorable for calls`);}else if(rangePos>0.60){score+=1;details.push(`${pct}% of 52W range -- upper half`);}else if(rangePos<0.30){score-=2;details.push(`${pct}% of 52W range -- near lows, avoid calls`);}else if(rangePos<0.50){score-=1;details.push(`${pct}% of 52W range -- lower half`);}else{details.push(`${pct}% of 52W range`);}}
  if(earningsDate){const ed=new Date(earningsDate.split(' ')[0]);const days=Math.round((ed-today)/86400000);if(days>=0&&days<35){score-=2;reasons.push(`Earnings in ${days}d`);details.push(`Earnings in ${days} days -- gap-up risk`);}else if(days>=35&&days<60){details.push(`Earnings in ${days} days -- monitor`);}}
  if(ivrVal!==null&&!isNaN(ivrVal)){if(ivrVal>=60){score+=1;details.push(`IV ${ordinal(ivrVal)} pct -- elevated premium`);}else if(ivrVal<30){details.push(`IV ${ordinal(ivrVal)} pct -- thin premiums`);}else{details.push(`IV ${ordinal(ivrVal)} pct -- normal`);}}
  if(estApy&&recStrike){details.push(`Rec ${recStrike} @ ${estApy} (${expiration})`);}
  const signal=score>=3?'high':score>=1?'medium':'low';
  // Component scores for calls (inverted logic vs puts for RSI/range)
  const rsiScore=rsiVal===null?0:(rsiVal>70?3:rsiVal>60?2:rsiVal<35?-1:rsiVal<50?0:1);
  const maScore=(!ma50||!ma200||!price)?0:(price>ma50&&price>ma200?2:price<ma50&&price<ma200?-1:1);
  const rangeScore=rangePos===null?0:(rangePos>0.80?3:rangePos>0.60?2:rangePos<0.30?-1:rangePos<0.50?0:1);
  const earningsScore=!earningsDate?1:(()=>{const d=daysUntilDate(earningsDate.split(' ')[0])??Math.round((new Date(earningsDate.split(' ')[0])-new Date())/86400000);return d>=0&&d<35?-1:d<60?0:2;})();
  const ivrScore=ivrVal===null?0:(ivrVal>=60?3:ivrVal>=40?2:ivrVal>=20?1:-1);
  const apyScore=!estApy?0:(parseFloat(estApy)>=12?3:parseFloat(estApy)>=8?2:parseFloat(estApy)>=5?1:0);
  const components={ivr:ivrScore,rsi:rsiScore,range:rangeScore,apy:apyScore,earn:earningsScore};
  const normScore=Math.round(Math.max(0,Math.min(100,(score+8)/20*100)));
  return{score:normScore,rawScore:score,signal,factors:reasons.slice(0,2).join(', ')||'Insufficient data',narrative:details.join('. '),recStrike:recStrike||'--',expiration:expiration||'--',estApy:estApy||'--',components};
}
