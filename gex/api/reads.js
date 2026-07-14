'use strict';

import { handleReads } from '../lib/routes.js';

export default async function handler(req, res) {
  const result = await handleReads(req.query.symbol, req.query.day, req.query.file);
  if (result.raw !== undefined) {
    res.setHeader('cache-control', result.immutable ? 'public, max-age=86400, immutable' : 'no-store');
    res.status(result.status).send(result.raw);
    return;
  }
  res.status(result.status).json(result.body);
}
