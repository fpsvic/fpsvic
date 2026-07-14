'use strict';

/* Tiny zero-dependency server for the Personal GEX dashboard — local dev only.
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
 * care where the data came from.
 *
 * All the actual logic (config, CBOE/Tradier fetchers, scan assembly, the
 * Claude AI-read pipeline, the archive) lives in gex/lib/ so this file and
 * the Vercel functions in gex/api/ can never drift — this is just the raw
 * http.Server + static file serving that only makes sense for local dev. */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/env.js';
import {
  PORT, HOST, MIME, TRADIER_TOKEN, TRADIER_BASE, ANTHROPIC_KEY, ANTHROPIC_MODEL, ANTHROPIC_EFFORT, ANALYZE_MAX_BODY,
  fetchChain, fetchHistory, fetchVix, scanRow, assembleScanRow,
  validateSnapshot, analyzeSnapshot, readJsonBody,
  pickExpirations, fetchChainTradier, buildAnalyzeRequest, READ_SCHEMA,
} from './lib/core.js';
import { ARCHIVE_OFF, ARCHIVE_BACKEND, ARCHIVE_DIR, archiveMaintenance } from './lib/archive.js';
import { handleBrain, handleReadsLatest, handleReads } from './lib/routes.js';

// re-exported for analyze.test.js / scan.test.js (dynamic-import this file)
export { pickExpirations, fetchChainTradier, READ_SCHEMA, validateSnapshot, buildAnalyzeRequest, assembleScanRow, scanRow };

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    // Requiring the JSON content-type makes any cross-origin browser call a
    // CORS-preflighted request, which fails (we send no CORS headers) — a web
    // page cannot fire "simple request" POSTs at the user's API budget.
    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      return sendJson(res, 415, { error: 'content-type must be application/json' });
    }
    try {
      const snapshot = await readJsonBody(req, ANALYZE_MAX_BODY);
      const bad = validateSnapshot(snapshot);
      if (bad) return sendJson(res, 400, { error: bad });
      if (!ANTHROPIC_KEY) {
        return sendJson(res, 503, {
          error: 'AI reads are not configured: set ANTHROPIC_API_KEY in gex/.env (get a key at platform.claude.com) and restart the server.',
        });
      }
      const body = await analyzeSnapshot(snapshot);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(body);
    } catch (err) {
      console.error(`[gex] analyze failed: ${err.message}`);
      return sendJson(res, 502, { error: err.message });
    }
  }

  // One scan row per request: the browser drives a small concurrency pool over
  // these so rows stream in and rank progressively. Always 200 with the row
  // (ok or error) so a single bad ticker never aborts the whole scan. Never
  // touches Claude — the AI top-picks step reuses /api/analyze from the client.
  if (url.pathname === '/api/scan/row') {
    const symbol = String(url.searchParams.get('symbol') || '').toUpperCase().replace(/[^A-Z^_.]/g, '');
    const source = { tradier: 'tradier', cboe: 'cboe' }[url.searchParams.get('source')] || '';
    const refresh = url.searchParams.get('refresh') === '1';
    if (!symbol) return sendJson(res, 400, { error: 'missing ?symbol=' });
    const row = await scanRow(symbol, source, { refresh });
    return sendJson(res, 200, row);
  }

  // Saved AI reads, batched newest-first per symbol: the scanner rehydrates its
  // read cards from here on page load instead of re-spending API credits.
  if (url.pathname === '/api/reads/latest') {
    const result = await handleReadsLatest(url.searchParams.get('symbols'));
    return sendJson(res, result.status, result.body);
  }

  // The read journal: list a symbol's saved reads (?symbol=, optional ?day=) as
  // a compact index, or serve one full record (?symbol=&day=&file=). Records
  // are immutable once written, so single-record responses cache hard.
  if (url.pathname === '/api/reads') {
    const result = await handleReads(url.searchParams.get('symbol'), url.searchParams.get('day'), url.searchParams.get('file'));
    if (result.raw !== undefined) {
      res.writeHead(result.status, {
        'content-type': 'application/json',
        'cache-control': result.immutable ? 'public, max-age=86400, immutable' : 'no-store',
      });
      return res.end(result.raw);
    }
    return sendJson(res, result.status, result.body);
  }

  // One positioning snapshot per ticker: strike x expiry-band grids of the
  // greeks plus the same landmark levels the dashboard shows. Consumed by the
  // macro watchlist minis. Each FRESH build is archived to disk — that archive
  // is the market-state history future read-backtesting scores against.
  if (url.pathname === '/api/brain') {
    const result = await handleBrain(
      url.searchParams.get('symbol'), url.searchParams.get('source'), url.searchParams.get('prefer'),
    );
    if (result.raw !== undefined) {
      res.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(result.raw);
    }
    return sendJson(res, result.status, result.body);
  }

  const api = { '/api/chain': true, '/api/history': true, '/api/vix': true }[url.pathname];
  if (api) {
    const symbol = String(url.searchParams.get('symbol') || '').toUpperCase().replace(/[^A-Z^_.]/g, '');
    const source = { tradier: 'tradier', cboe: 'cboe' }[url.searchParams.get('source')] || '';
    if (!symbol && url.pathname !== '/api/vix') return sendJson(res, 400, { error: 'missing ?symbol=' });
    try {
      const body = url.pathname === '/api/chain' ? await fetchChain(symbol, source)
        : url.pathname === '/api/history' ? await fetchHistory(symbol)
        : await fetchVix();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(body);
    } catch (err) {
      return sendJson(res, 502, { error: `could not fetch ${url.pathname.slice(5)}: ${err.message}` });
    }
  }

  // static files, confined to this directory. The multi-ticker scanner is the
  // landing view; the single-ticker dashboard stays reachable at /index.html
  // (each scan row click-throughs to /index.html?symbol=SYM).
  const rel = url.pathname === '/' ? 'scan.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  // no-cache: browsers otherwise heuristically cache app.js/index.html and can
  // serve a stale mix of old and new code after an upgrade (blank/broken page)
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
});

if (!process.env.GEX_NO_LISTEN) {
  server.listen(PORT, HOST, () => {
    console.log(`Personal GEX running at http://localhost:${PORT}`);
    console.log('Data source: %s', TRADIER_TOKEN ? `Tradier (${TRADIER_BASE})` : 'CBOE delayed quotes');
    console.log('AI reads: %s', ANTHROPIC_KEY ? `enabled (${ANTHROPIC_MODEL}, effort ${ANTHROPIC_EFFORT})` : 'disabled (set ANTHROPIC_API_KEY in gex/.env)');
    console.log('Brain archive: %s', ARCHIVE_OFF ? 'disabled (GEX_NO_ARCHIVE)' : `${ARCHIVE_BACKEND} (${ARCHIVE_DIR})`);
    archiveMaintenance();
    setInterval(archiveMaintenance, 24 * 3600e3).unref();
    console.log('Scanner: http://localhost:%d/  ·  single-ticker dashboard: http://localhost:%d/index.html?symbol=SPX (or ?demo=1)', PORT, PORT);
  });
}
