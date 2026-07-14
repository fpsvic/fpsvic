'use strict';

import { fetchVix } from '../lib/core.js';

export default async function handler(req, res) {
  try {
    const body = await fetchVix();
    res.setHeader('cache-control', 'no-store');
    res.status(200).send(body);
  } catch (err) {
    res.status(502).json({ error: `could not fetch vix: ${err.message}` });
  }
}
