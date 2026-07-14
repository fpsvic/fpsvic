'use strict';

/* POST /api/analyze — see lib/core.js for the full rubric/schema commentary.
 * Vercel's Node runtime parses a JSON body into req.body automatically when
 * content-type matches, so unlike server.js's raw http.Server this needs no
 * manual body collection. */

import { validateSnapshot, analyzeSnapshot, ANTHROPIC_KEY } from '../lib/core.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method must be POST' });
    return;
  }
  // Requiring the JSON content-type makes any cross-origin browser call a
  // CORS-preflighted request, which fails (we send no CORS headers) — a web
  // page cannot fire "simple request" POSTs at the user's API budget.
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    res.status(415).json({ error: 'content-type must be application/json' });
    return;
  }
  try {
    const snapshot = req.body;
    const bad = validateSnapshot(snapshot);
    if (bad) {
      res.status(400).json({ error: bad });
      return;
    }
    if (!ANTHROPIC_KEY) {
      res.status(503).json({
        error: 'AI reads are not configured: set ANTHROPIC_API_KEY in the Vercel project env vars.',
      });
      return;
    }
    const body = await analyzeSnapshot(snapshot);
    res.setHeader('cache-control', 'no-store');
    res.status(200).send(body);
  } catch (err) {
    console.error(`[gex] analyze failed: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
}
