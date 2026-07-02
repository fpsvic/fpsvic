'use strict';

/* Tiny zero-dependency server for the Personal GEX dashboard.
 *
 *   node gex/server.js          -> http://localhost:8787
 *   PORT=9000 node gex/server.js
 *
 * Serves the static dashboard and proxies CBOE's free delayed options-chain
 * JSON at /api/chain?symbol=SPX (the proxy exists only to sidestep browser
 * CORS — the data itself is public and needs no key). */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CBOE = 'https://cdn.cboe.com/api/global/delayed_quotes/options/';
const CACHE_MS = 60_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const cache = new Map(); // symbol -> {at, body}

async function fetchChain(symbol) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;

  // Equities/ETFs are plain (SPY.json); indexes are underscore-prefixed (_SPX.json).
  const candidates = [symbol, `_${symbol}`];
  let lastErr = null;
  for (const s of candidates) {
    try {
      const res = await fetch(`${CBOE}${encodeURIComponent(s)}.json`, {
        headers: { accept: 'application/json', 'user-agent': 'personal-gex/1.0' },
      });
      if (!res.ok) { lastErr = new Error(`CBOE HTTP ${res.status} for ${s}`); continue; }
      const body = await res.text();
      cache.set(symbol, { at: Date.now(), body });
      return body;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('unreachable');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/chain') {
    const symbol = String(url.searchParams.get('symbol') || '').toUpperCase().replace(/[^A-Z^_.]/g, '');
    if (!symbol) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing ?symbol=' }));
    }
    try {
      const body = await fetchChain(symbol);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(body);
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: `could not reach CBOE: ${err.message}` }));
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

server.listen(PORT, () => {
  console.log(`Personal GEX running at http://localhost:${PORT}`);
  console.log('Try http://localhost:%d/?symbol=SPX or ?demo=1 for synthetic data.', PORT);
});
