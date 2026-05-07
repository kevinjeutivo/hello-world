// ============================================
// PutSeller Pro -- Cloudflare Worker Proxy v2
// Handles four request types:
//   ?ticker=NVDA&type=options   -> Yahoo options chain
//   ?ticker=NVDA&type=history   -> Yahoo price history
//   ?ticker=SPYI&type=dividends -> Yahoo dividend events
//   ?series=DTB3&type=fred      -> FRED T-bill yield data
// All handle Yahoo cookie+crumb auth server-side.
// Free tier: 100,000 requests/day
// ============================================

const PROXY_SECRET = '';

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

    if (PROXY_SECRET) {
      const clientSecret = request.headers.get('X-Proxy-Secret');
      if (clientSecret !== PROXY_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    const url = new URL(request.url);
    const type = url.searchParams.get('type') || 'options';
    const ticker = url.searchParams.get('ticker');
    const series = url.searchParams.get('series');
    const expiration = url.searchParams.get('expiration');
    const range = url.searchParams.get('range') || '1y';
    const interval = url.searchParams.get('interval') || '1d';

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

      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Cache-Control': 'public, max-age=300'
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
