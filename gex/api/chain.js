'use strict';

import { fetchChain } from '../lib/core.js';

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase().replace(/[^A-Z^_.]/g, '');
  const source = { tradier: 'tradier', cboe: 'cboe' }[req.query.source] || '';
  if (!symbol) {
    res.status(400).json({ error: 'missing ?symbol=' });
    return;
  }
  try {
    const body = await fetchChain(symbol, source);
    res.setHeader('cache-control', 'no-store');
    res.status(200).send(body);
  } catch (err) {
    res.status(502).json({ error: `could not fetch chain: ${err.message}` });
  }
}
