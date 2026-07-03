'use strict';

/* Tiny zero-dependency server for the Personal GEX dashboard.
 *
 *   node gex/server.js                      -> http://localhost:8787 (CBOE data)
 *   TRADIER_TOKEN=xxx node gex/server.js    -> same, but sourced from Tradier
 *   PORT=9000 node gex/server.js
 *
 * Serves the static dashboard and exposes /api/chain?symbol=SPX, which returns
 * an options chain in CBOE's delayed-quotes JSON shape from one of two sources:
 *
 *   - CBOE delayed quotes (default): public, no key, ~15 min delayed.
 *     The proxy exists only to sidestep browser CORS.
 *   - Tradier (when TRADIER_TOKEN is set, or ?source=tradier): needs a free
 *     developer-sandbox or brokerage API token. Quotes are real-time on
 *     brokerage tokens; greeks/IV come from ORATS and refresh roughly hourly.
 *     TRADIER_SANDBOX=1 targets the sandbox host; TRADIER_MAX_EXPIRIES (default
 *     12) caps how many expirations are pulled per load to stay well inside
 *     Tradier's rate limits on big chains like SPX.
 *
 * Tradier responses are normalized to the CBOE shape so the frontend does not
 * care where the data came from. */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE_MS = 60_000;

const CBOE = 'https://cdn.cboe.com/api/global/delayed_quotes/options/';

const TRADIER_TOKEN = process.env.TRADIER_TOKEN || '';
const TRADIER_BASE = process.env.TRADIER_SANDBOX
  ? 'https://sandbox.tradier.com/v1'
  : 'https://api.tradier.com/v1';
const TRADIER_MAX_EXPIRIES = Number(process.env.TRADIER_MAX_EXPIRIES || 12);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const cache = new Map(); // `${source}:${symbol}` -> {at, body}

// ---------------------------------------------------------------- cboe

async function fetchChainCboe(symbol) {
  // Equities/ETFs are plain (SPY.json); indexes are underscore-prefixed (_SPX.json).
  let lastErr = null;
  for (const s of [symbol, `_${symbol}`]) {
    try {
      const res = await fetch(`${CBOE}${encodeURIComponent(s)}.json`, {
        headers: { accept: 'application/json', 'user-agent': 'personal-gex/1.0' },
      });
      if (!res.ok) { lastErr = new Error(`CBOE HTTP ${res.status} for ${s}`); continue; }
      return await res.text();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('unreachable');
}

// ---------------------------------------------------------------- tradier

// Tradier collapses single-element arrays to a bare object; normalize back.
function asArray(x) {
  return x == null ? [] : Array.isArray(x) ? x : [x];
}

async function tradierGet(pathname, params, fetchImpl = fetch) {
  const url = new URL(TRADIER_BASE + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${TRADIER_TOKEN}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Tradier HTTP ${res.status} for ${pathname}`);
  return res.json();
}

/* Pull quote + nearest expirations + per-expiration chains from Tradier and
 * reshape into CBOE's payload format ({data: {current_price, options: [...]}}).
 * fetchImpl is injectable for tests. */
export async function fetchChainTradier(symbol, fetchImpl = fetch) {
  if (!TRADIER_TOKEN) throw new Error('TRADIER_TOKEN is not set');

  const [quoteRes, expRes] = await Promise.all([
    tradierGet('/markets/quotes', { symbols: symbol }, fetchImpl),
    tradierGet('/markets/options/expirations', { symbol, includeAllRoots: 'true' }, fetchImpl),
  ]);

  const quote = asArray(quoteRes?.quotes?.quote)[0];
  const spot = Number(quote?.last ?? quote?.close ?? NaN);
  if (!isFinite(spot) || spot <= 0) throw new Error(`Tradier returned no quote for ${symbol}`);

  const dates = asArray(expRes?.expirations?.date).slice(0, TRADIER_MAX_EXPIRIES);
  if (!dates.length) throw new Error(`Tradier lists no option expirations for ${symbol}`);

  const chains = await Promise.all(
    dates.map((d) => tradierGet('/markets/options/chains', { symbol, expiration: d, greeks: 'true' }, fetchImpl)),
  );

  const options = [];
  for (const c of chains) {
    for (const o of asArray(c?.options?.option)) {
      if (!o?.symbol) continue;
      options.push({
        option: o.symbol, // OCC format, same as CBOE
        open_interest: Number(o.open_interest ?? 0),
        volume: Number(o.volume ?? 0),
        iv: Number(o.greeks?.mid_iv ?? o.greeks?.smv_vol ?? 0),
        gamma: Number(o.greeks?.gamma ?? NaN),
      });
    }
  }
  if (!options.length) throw new Error(`Tradier returned no options for ${symbol}`);

  return JSON.stringify({
    timestamp: new Date().toISOString(),
    _source: `Tradier (nearest ${dates.length} expirations)`,
    data: { symbol, current_price: spot, options },
  });
}

// ---------------------------------------------------------------- routing

async function fetchChain(symbol, requestedSource) {
  const source = requestedSource || (TRADIER_TOKEN ? 'tradier' : 'cboe');
  const key = `${source}:${symbol}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;

  const body = source === 'tradier' ? await fetchChainTradier(symbol) : await fetchChainCboe(symbol);
  cache.set(key, { at: Date.now(), body });
  return body;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/chain') {
    const symbol = String(url.searchParams.get('symbol') || '').toUpperCase().replace(/[^A-Z^_.]/g, '');
    const source = { tradier: 'tradier', cboe: 'cboe' }[url.searchParams.get('source')] || '';
    if (!symbol) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing ?symbol=' }));
    }
    try {
      const body = await fetchChain(symbol, source);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(body);
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: `could not fetch chain: ${err.message}` }));
    }
  }

  // static files, confined to this directory
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

if (!process.env.GEX_NO_LISTEN) {
  server.listen(PORT, () => {
    console.log(`Personal GEX running at http://localhost:${PORT}`);
    console.log('Data source: %s', TRADIER_TOKEN ? `Tradier (${TRADIER_BASE})` : 'CBOE delayed quotes');
    console.log('Try http://localhost:%d/?symbol=SPX or ?demo=1 for synthetic data.', PORT);
  });
}
