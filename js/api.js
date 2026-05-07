async function fh(path){
  if(offlineMode)throw new Error('offline mode');
  if(!FINNHUB_KEY){
    toast('Add Finnhub key in Settings');
    throw new Error('No API key');
  }
  const r=await fetch(`https://finnhub.io/api/v1${path}&token=${FINNHUB_KEY}`);
  if(!r.ok)throw new Error(`Finnhub ${r.status}`);
  return r.json();
}
