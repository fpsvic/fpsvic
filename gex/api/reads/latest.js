'use strict';

import { handleReadsLatest } from '../../lib/routes.js';

export default async function handler(req, res) {
  const result = await handleReadsLatest(req.query.symbols);
  res.setHeader('cache-control', 'no-store');
  res.status(result.status).json(result.body);
}
