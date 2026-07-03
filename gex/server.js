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

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* Load gex/.env if present (simple KEY=value lines, # comments ignored) so the
 * Tradier token doesn't have to live in the shell. Real env vars win. */
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
} catch { /* no .env file — fine */ }

const PORT = Number(process.env.PORT || 8787);
const CACHE_MS = 60_000;
const HISTORY_CACHE_MS = 30 * 60_000;
const HISTORY_DAYS = 80; // enough for a 21-day realized-vol window with margin

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

const cache = new Map(); // key -> {at, ttl, body}

function cached(key, ttl, fill) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.body;
  return Promise.resolve(fill()).then((body) => {
    cache.set(key, { at: Date.now(), ttl, body });
    return body;
  });
}

// ---------------------------------------------------------------- cboe

// CBOE's CDN sometimes rejects script-looking user agents; look like a browser
const CBOE_HEADERS = {
  accept: 'application/json',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

// Equities/ETFs are plain (SPY.json); indexes are underscore-prefixed (_SPX.json).
async function cboeGetEither(base, symbol) {
  let lastErr = null;
  for (const s of [symbol, `_${symbol}`]) {
    try {
      const res = await fetch(`${base}${encodeURIComponent(s)}.json`, { headers: CBOE_HEADERS });
      if (!res.ok) { lastErr = new Error(`CBOE HTTP ${res.status} for ${s}`); continue; }
      return await res.text();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('unreachable');
}

function fetchChainCboe(symbol) {
  return cboeGetEither(CBOE, symbol);
}

/* Daily closes for realized vol, from CBOE's free historical-chart endpoint
 * (full history since 1975, all values as strings). Trimmed server-side so the
 * client is not shipped 50 years of rows. */
async function fetchHistoryCboe(symbol) {
  const text = await cboeGetEither('https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/', symbol);
  const rows = JSON.parse(text)?.data;
  if (!Array.isArray(rows)) throw new Error('unexpected CBOE history shape');
  const days = rows
    .slice(-HISTORY_DAYS)
    .map((d) => ({ date: d.date, close: parseFloat(d.close) }))
    .filter((d) => isFinite(d.close) && d.close > 0);
  if (!days.length) throw new Error(`CBOE history for ${symbol} had no usable closes`);
  return JSON.stringify({ symbol, _source: 'CBOE historical', days });
}

// Lightweight VIX spot (delayed) for cross-checking the chain-derived proxy.
async function fetchVixQuote() {
  const res = await fetch('https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json', { headers: CBOE_HEADERS });
  if (!res.ok) throw new Error(`CBOE HTTP ${res.status} for _VIX quote`);
  const json = await res.json();
  const vix = Number(json?.data?.current_price ?? NaN);
  if (!isFinite(vix) || vix <= 0) throw new Error('no VIX level in CBOE quote payload');
  return JSON.stringify({ vix, asof: json?.data?.last_trade_time || null });
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
        bid: Number(o.bid ?? 0),
        ask: Number(o.ask ?? 0),
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

// Daily closes from Tradier, normalized to the same shape as fetchHistoryCboe.
async function fetchHistoryTradier(symbol) {
  if (!TRADIER_TOKEN) throw new Error('TRADIER_TOKEN is not set');
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 160 * 86400e3).toISOString().slice(0, 10);
  const json = await tradierGet('/markets/history', { symbol, interval: 'daily', start, end });
  const days = asArray(json?.history?.day)
    .map((d) => ({ date: d.date, close: Number(d.close) }))
    .filter((d) => isFinite(d.close) && d.close > 0)
    .slice(-HISTORY_DAYS);
  if (!days.length) throw new Error(`Tradier returned no history for ${symbol}`);
  return JSON.stringify({ symbol, _source: 'Tradier history', days });
}

// ---------------------------------------------------------------- routing

async function fetchChain(symbol, requestedSource) {
  const preferred = requestedSource || (TRADIER_TOKEN ? 'tradier' : 'cboe');
  // unless a source was forced, fall back to the other one on failure; each
  // body is cached under its TRUE source key, so a fallback body can never
  // masquerade as the other source on a later explicit ?source= request
  const order = requestedSource ? [preferred]
    : preferred === 'tradier' ? ['tradier', 'cboe']
    : TRADIER_TOKEN ? ['cboe', 'tradier'] : ['cboe'];

  const errors = [];
  for (const source of order) {
    try {
      return await cached(`${source}:${symbol}`, CACHE_MS, () =>
        source === 'tradier' ? fetchChainTradier(symbol) : fetchChainCboe(symbol));
    } catch (err) {
      errors.push(`${source}: ${err.message}`);
      console.error(`[gex] ${symbol} via ${source} failed: ${err.message}`);
    }
  }
  throw new Error(errors.join(' · '));
}

// CBOE history is keyless and covers indexes and equities alike, so prefer it
// regardless of the chain source; Tradier is the fallback when a token exists.
function fetchHistory(symbol) {
  return cached(`history:${symbol}`, HISTORY_CACHE_MS, async () => {
    try {
      return await fetchHistoryCboe(symbol);
    } catch (err) {
      if (!TRADIER_TOKEN) throw err;
      return fetchHistoryTradier(symbol);
    }
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  const api = { '/api/chain': true, '/api/history': true, '/api/vix': true }[url.pathname];
  if (api) {
    const symbol = String(url.searchParams.get('symbol') || '').toUpperCase().replace(/[^A-Z^_.]/g, '');
    const source = { tradier: 'tradier', cboe: 'cboe' }[url.searchParams.get('source')] || '';
    if (!symbol && url.pathname !== '/api/vix') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing ?symbol=' }));
    }
    try {
      const body = url.pathname === '/api/chain' ? await fetchChain(symbol, source)
        : url.pathname === '/api/history' ? await fetchHistory(symbol)
        : await cached('vix', CACHE_MS, fetchVixQuote);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(body);
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: `could not fetch ${url.pathname.slice(5)}: ${err.message}` }));
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
