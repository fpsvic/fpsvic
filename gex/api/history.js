'use strict';

import { fetchHistory } from '../lib/core.js';

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase().replace(/[^A-Z^_.]/g, '');
  if (!symbol) {
    res.status(400).json({ error: 'missing ?symbol=' });
    return;
  }
  try {
    const body = await fetchHistory(symbol);
    res.setHeader('cache-control', 'no-store');
    res.status(200).send(body);
  } catch (err) {
    res.status(502).json({ error: `could not fetch history: ${err.message}` });
  }
}
