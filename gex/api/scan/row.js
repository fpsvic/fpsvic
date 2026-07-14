'use strict';

import { scanRow } from '../../lib/core.js';

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase().replace(/[^A-Z^_.]/g, '');
  const source = { tradier: 'tradier', cboe: 'cboe' }[req.query.source] || '';
  const refresh = req.query.refresh === '1';
  if (!symbol) {
    res.status(400).json({ error: 'missing ?symbol=' });
    return;
  }
  const row = await scanRow(symbol, source, { refresh });
  res.setHeader('cache-control', 'no-store');
  res.status(200).json(row);
}
