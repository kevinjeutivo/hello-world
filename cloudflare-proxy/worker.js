// ============================================
// Income Engine -- Cloudflare Worker Proxy v2
// Handles five request types:
//   ?ticker=NVDA&type=options   -> Yahoo options chain
//   ?ticker=NVDA&type=history   -> Yahoo price history
//   ?ticker=SPYI&type=dividends -> Yahoo dividend events
//   ?series=DTB3&type=fred      -> FRED T-bill yield data
//   ?type=finnhub&path=...      -> Finnhub proxy (server-side key, see below)
// All Yahoo request types handle cookie+crumb auth server-side.
// Free tier: 100,000 requests/day
//
// Secrets (set via Cloudflare dashboard -> Settings -> Variables and Secrets,
// NOT as source literals -- this file lives in a public repo):
//   PROXY_SECRET  (optional) -- if set, requests must send a matching
//                  X-Proxy-Secret header or get rejected with 401. Blank/unset
//                  = check is skipped entirely (today's behavior).
//   FINNHUB_KEY   (optional) -- only required if using the type=finnhub
//                  branch below. Unset = that branch returns a clean 503
//                  rather than silently forwarding a bad token to Finnhub.
// ============================================

export default {
  async fetch(request, env, ctx) {

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Secret',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    const PROXY_SECRET = env.PROXY_SECRET || '';
    if (PROXY_SECRET) {
      const clientSecret = request.headers.get('X-Proxy-Secret');
      if (clientSecret !== PROXY_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    const url = new URL(request.url);
    const type = url.searchParams.get('type') || 'options';

    // ── Finnhub proxy: separate code path, no Yahoo cookie/crumb needed ──
    if (type === 'finnhub') {
      return handleFinnhubProxy(url, env);
    }

    const ticker = url.searchParams.get('ticker');
    const series = url.searchParams.get('series');
    const expiration = url.searchParams.get('expiration');
    const range = url.searchParams.get('range') || '1y';
    const interval = url.searchParams.get('interval') || '1d';
    const bustCache = url.searchParams.has('_t'); // cache-bust flag from client

    // T-bill yields: use ?ticker=%5EIRX&type=history for 3-month (^IRX)
    // and ?ticker=%5EFVX&type=history for 5-year proxy via existing history handler.
    // No separate tbills handler needed -- Yahoo Finance carries these indices.

    // ── All Yahoo requests need cookie+crumb ──
    if (!ticker) return corsJson({ error: 'ticker parameter required' }, 400);

    try {
      // Step 1: Get Yahoo session cookie
      const cookieResponse = await fetch('https://finance.yahoo.com', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow'
      });
      const setCookie = cookieResponse.headers.get('set-cookie') || '';
      const cookieMatch = setCookie.match(/A1=([^;]+)/);
      const cookie = cookieMatch ? `A1=${cookieMatch[1]}` : '';

      // Step 2: Get crumb token
      const crumbResponse = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://finance.yahoo.com',
          'Cookie': cookie
        }
      });
      const crumb = await crumbResponse.text();

      const commonHeaders = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com',
        'Cookie': cookie
      };

      let targetUrl;

      if (type === 'history') {
        const params = new URLSearchParams({ range, interval, includePrePost: 'false', crumb });
        targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?${params}`;

      } else if (type === 'dividends') {
        // Yahoo v8 chart with events=div returns dividend history in events.dividends
        const divRange = url.searchParams.get('range') || '3y';
        const params = new URLSearchParams({
          range: divRange,
          interval: '1mo',
          events: 'div',
          crumb
        });
        targetUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?${params}`;

      } else if (type === 'quote') {
        // Real-time quote including postMarketPrice, preMarketPrice, marketState
        // Same data source used by yfinance stock.info -- most reliable for extended hours
        const params = new URLSearchParams({ symbols: ticker, crumb });
        targetUrl = `https://query1.finance.yahoo.com/v7/finance/quote?${params}`;

      } else if (type === 'summary') {
        // quoteSummary endpoint -- supports multiple comma-separated modules in one call
        // e.g. financialData,defaultKeyStatistics,earningsTrend,recommendationTrend
        const modules = url.searchParams.get('modules') || 'financialData';
        const params = new URLSearchParams({ modules, crumb });
        targetUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?${params}`;

      } else {
        // options
        const params = new URLSearchParams({ crumb });
        if (expiration) {
          // expiration is now passed as the original Unix timestamp string
          // from Yahoo's own expirationDates array -- no conversion needed.
          // This guarantees an exact match with Yahoo's internal expiration records.
          const expTimestamp = /^\d+$/.test(expiration)
            ? expiration  // already a Unix timestamp
            : Math.floor(new Date(expiration + 'T17:00:00Z').getTime() / 1000); // fallback
          params.set('date', expTimestamp.toString());
        }
        targetUrl = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?${params}`;
      }

      const dataResponse = await fetch(targetUrl, { headers: commonHeaders });

      if (!dataResponse.ok) {
        return corsJson({
          error: `Yahoo Finance returned ${dataResponse.status}`,
          status: dataResponse.status,
          type, ticker
        }, dataResponse.status);
      }

      const data = await dataResponse.json();

      // Cache TTL varies by request type and interval:
      // - Intraday history (interval=1m/2m/5m/15m/30m/60m/90m): 60s -- live market data
      // - Daily/weekly/monthly history: 300s (5min) -- bars don't change mid-session
      // - Options chains: 300s -- refreshed explicitly by user
      // - Quotes: 60s -- near real-time price data
      // - Summary/dividends: 300s -- fundamental data, slow-changing
      const isIntradayHistory = type === 'history' && ['1m','2m','5m','15m','30m','60m','90m'].includes(interval);
      const isQuote = type === 'quote';
      const cacheTTL = (isIntradayHistory || isQuote) ? 60 : 300;
      // If client sent _t cache-bust param, bypass all caching entirely
      const cacheHeader = bustCache ? 'no-store' : `public, max-age=${cacheTTL}`;

      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Cache-Control': cacheHeader
        }
      });

    } catch (err) {
      return corsJson({ error: 'Proxy fetch failed', message: err.message }, 500);
    }
  }
};

function corsJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// Proxies Finnhub API calls using a server-side key (env.FINNHUB_KEY), so
// clients never need their own Finnhub account/key. Expects the client to
// pass the same path shape used by the app's direct-call fh() function in
// api.js, e.g. path=/calendar/earnings?symbol=AAPL&from=2026-01-01&to=2026-02-01
// (URL-encoded as a single query-string value; URLSearchParams decodes it
// automatically on read).
async function handleFinnhubProxy(url, env) {
  const key = env.FINNHUB_KEY;
  if (!key) {
    // Deliberately a clean, distinct error rather than forwarding an empty/
    // undefined token to Finnhub and returning whatever confusing failure
    // that produces -- makes a not-yet-configured shared key obvious.
    return corsJson({ error: 'Finnhub proxy not configured' }, 503);
  }

  const path = url.searchParams.get('path');
  if (!path) return corsJson({ error: 'path parameter required' }, 400);

  try {
    const targetUrl = `https://finnhub.io/api/v1${path}&token=${key}`;
    const dataResponse = await fetch(targetUrl);

    if (!dataResponse.ok) {
      return corsJson({
        error: `Finnhub returned ${dataResponse.status}`,
        status: dataResponse.status
      }, dataResponse.status);
    }

    const data = await dataResponse.json();

    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Cache-Control': 'public, max-age=300' // matches summary/dividends TTL above
      }
    });

  } catch (err) {
    return corsJson({ error: 'Finnhub proxy fetch failed', message: err.message }, 500);
  }
}
