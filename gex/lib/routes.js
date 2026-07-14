'use strict';

/* Route-level logic shared between server.js's raw http.Server and the
 * Vercel functions in gex/api/ — everything here is transport-agnostic
 * (takes plain params, returns { status, body } or throws), so both callers
 * stay byte-for-byte identical instead of two hand-maintained copies. */

import { cached, fetchChain, buildBrainSnapshot, CACHE_MS } from './core.js';
import { archiveBrainSnapshot, latestReadFor, listReadDays, listReadFiles, getReadFile, READ_FILE_RE } from './archive.js';

export async function handleBrain(symbolRaw, sourceRaw, preferParam) {
  const symbol = String(symbolRaw || '').toUpperCase().replace(/[^A-Z^_.]/g, '');
  const source = { tradier: 'tradier', cboe: 'cboe' }[sourceRaw] || '';
  const preferCboe = !source && preferParam === 'cboe';
  if (!symbol) return { status: 400, body: { error: 'missing ?symbol=' } };
  try {
    const body = await cached(`brain:${source || (preferCboe ? 'cboe1st' : 'auto')}:${symbol}`, CACHE_MS, async () => {
      const { chain, payload } = await buildBrainSnapshot(symbol, source, { preferCboe });
      archiveBrainSnapshot(chain.symbol, payload, Date.now(), chain.source);
      return payload;
    });
    return { status: 200, raw: body };
  } catch (err) {
    return { status: 502, body: { error: `could not build brain mesh for ${symbol}: ${err.message}` } };
  }
}

export async function handleReadsLatest(symbolsRaw) {
  const symbols = [...new Set(String(symbolsRaw || '').toUpperCase()
    .split(',').map((s) => s.replace(/[^A-Z0-9^_.]/g, '')).filter(Boolean))].slice(0, 40);
  const reads = {};
  await Promise.all(symbols.map(async (sym) => {
    const rec = await latestReadFor(sym).catch(() => null);
    if (rec) reads[sym] = rec;
  }));
  return { status: 200, body: { reads } };
}

export async function handleReads(symbolRaw, dayParam, fileParam) {
  const symbol = String(symbolRaw || '').toUpperCase().replace(/[^A-Z^_.0-9]/g, '');
  if (!symbol) return { status: 400, body: { error: 'missing ?symbol=' } };

  if (fileParam) { // one full record
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayParam || '') || !READ_FILE_RE.test(fileParam)) {
      return { status: 400, body: { error: 'need ?symbol=&day=YYYY-MM-DD&file=HHMMSSZ-read.json' } };
    }
    try {
      const body = await getReadFile(symbol, dayParam, fileParam);
      return { status: 200, raw: body, immutable: true };
    } catch {
      return { status: 404, body: { error: 'read not found' } };
    }
  }

  const days = await listReadDays(symbol);
  if (!days.length) return { status: 200, body: { symbol, days: [], day: null, reads: [] } };
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayParam || '') && days.includes(dayParam) ? dayParam : days[days.length - 1];
  const files = await listReadFiles(symbol, day);
  // records are a few KB each and a day holds only manual reads — reading
  // them for a one-liner index is cheap and makes the journal scannable
  const entries = await Promise.all(files.map(async (f) => {
    try {
      const rec = JSON.parse(await getReadFile(symbol, day, f));
      return {
        file: f,
        asof: rec.asof,
        regime: rec.read?.regime?.label ?? null,
        one_liner: rec.read?.one_liner ?? null,
        rubric_version: rec.rubric_version ?? null,
      };
    } catch { return { file: f, asof: null, regime: null, one_liner: null, rubric_version: null }; }
  }));
  return { status: 200, body: { symbol, days, day, reads: entries } };
}
