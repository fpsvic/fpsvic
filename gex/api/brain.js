'use strict';

import { handleBrain } from '../lib/routes.js';

export default async function handler(req, res) {
  const result = await handleBrain(req.query.symbol, req.query.source, req.query.prefer);
  if (result.raw !== undefined) {
    res.setHeader('cache-control', 'no-store');
    res.status(result.status).send(result.raw);
    return;
  }
  res.status(result.status).json(result.body);
}
