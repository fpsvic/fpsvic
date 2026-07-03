'use strict';

/* Hermetic unit tests for the scan pipeline in gex/server.js:
 *   GEX_NO_LISTEN=1 node gex/scan.test.js
 * assembleScanRow is pure given already-fetched bodies, so we feed it synthetic
 * CBOE-shaped payloads and never open a socket. scanRow's error isolation is
 * exercised by temporarily disabling global fetch. */

process.env.GEX_NO_LISTEN = '1';

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
function shimLoad(file) {
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  const shim = { exports: {} };
  new Function('module', 'exports', src)(shim, shim.exports);
  return shim.exports;
}
const E = shimLoad('exposure.js');
const Mx = shimLoad('metrics.js');

// dynamic import so GEX_NO_LISTEN is set before server.js evaluates (no port bind)
const { assembleScanRow, scanRow, validateSnapshot } = await import('./server.js');

let passed = 0;
// returns a promise so async tests can be awaited; sync tests resolve immediately
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}
const approx = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, `${m ?? 'value'}: ${a} !~ ${b} (tol ${tol})`);

// --- synthetic CBOE payloads ---------------------------------------------
const NOW = Date.UTC(2026, 0, 15, 15, 0, 0);
const ymd = (ms) => { const d = new Date(ms); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; };
function occSym(root, y, m, d, type, strike) {
  const k = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${root}${String(y % 100).padStart(2, '0')}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}${type}${k}`;
}

/* Flat-IV CBOE payload. `live` toggles real bid/ask (needed for the vol calc);
 * callOi/putOi drive the gamma balance INDEPENDENTLY of the vol structure. */
function chainPayload({ S = 100, sigma = 0.2, callOi = 200, putOi = 200, live = true, root = 'TEST', dtes = [20, 40], lo = 60, hi = 140, now = NOW } = {}) {
  const options = [];
  for (const dte of dtes) {
    const [y, m, d] = ymd(now + dte * 86400e3);
    const T = Math.max((Date.UTC(y, m - 1, d, 20, 0, 0) - now) / E.MS_YEAR, 1 / (365 * 96));
    for (let K = lo; K <= hi; K += 1) {
      for (const type of ['C', 'P']) {
        const mid = Mx.bsPrice(S, K, T, sigma, E.RISK_FREE, type);
        const good = live && isFinite(mid) && mid >= 0.05;
        options.push({
          option: occSym(root, y, m, d, type, K),
          open_interest: type === 'C' ? callOi : putOi, volume: 0,
          bid: good ? mid * 0.99 : 0, ask: good ? mid * 1.01 : (live ? 0.05 : 0),
          iv: sigma, gamma: NaN,
        });
      }
    }
  }
  return { timestamp: '2026-01-15T15:00:00.000Z', _source: 'synthetic', data: { symbol: root, current_price: S, options } };
}
const bodyOf = (p) => JSON.stringify(p);
// closes that realize ~0 vol (flat) or ~30% (alternating) for the vrp tests
const flatCloses = (n = 40) => Array(n).fill(100);
function noisyCloses(n = 40, step = 0.019) { const c = [100]; for (let i = 1; i < n; i++) c.push(c[i - 1] * (i % 2 ? 1 / (1 + step) : 1 + step)); return c; }
const histBody = (closes) => JSON.stringify({ symbol: 'H', days: closes.map((close) => ({ close })) });

// ---------------------------------------------------------------- direction

await test('assembleScanRow: implied rich vs realized -> direction "rich"', () => {
  const row = assembleScanRow({
    symbol: 'RICH', chainBody: bodyOf(chainPayload({ sigma: 0.30 })),
    historyBody: histBody(flatCloses()), vixOfficial: 22, now: NOW,
  });
  assert.equal(row.ok, true);
  assert.equal(row.direction, 'rich', 'high implied, ~0 realized');
  assert.ok(row.magnitude > 0.3, `magnitude ${row.magnitude}`);
  assert.equal(row.rankable, true);
  assert.ok(row.vol.vrp > 10, 'fat vol risk premium');
});

await test('assembleScanRow: implied below realized -> direction "cheap"', () => {
  const row = assembleScanRow({
    symbol: 'CHEAP', chainBody: bodyOf(chainPayload({ sigma: 0.12 })),
    historyBody: histBody(noisyCloses()), now: NOW,
  });
  assert.equal(row.direction, 'cheap', 'low implied vs high realized');
  assert.ok(row.vol.vrp < 0, 'negative vol risk premium');
});

// ---------------------------------------------------------------- gamma never ranks

await test('assembleScanRow: gamma balance moves net_gex but NOT the score', () => {
  const common = { sigma: 0.25, live: true };
  const callHeavy = assembleScanRow({ symbol: 'A', chainBody: bodyOf(chainPayload({ ...common, callOi: 5000, putOi: 100 })), historyBody: histBody(flatCloses()), now: NOW });
  const putHeavy = assembleScanRow({ symbol: 'B', chainBody: bodyOf(chainPayload({ ...common, callOi: 100, putOi: 5000 })), historyBody: histBody(flatCloses()), now: NOW });
  // identical vol structure -> identical mispricing score (vol calc ignores OI)
  assert.equal(callHeavy.score, putHeavy.score, 'score is OI-independent');
  assert.equal(callHeavy.direction, putHeavy.direction);
  // but the gamma context differs and even flips regime
  assert.ok(callHeavy.gamma.net_gex > 0 && putHeavy.gamma.net_gex < 0, 'net GEX flips with the OI balance');
  assert.equal(callHeavy.gamma.regime, 'positive');
  assert.equal(putHeavy.gamma.regime, 'negative');
});

// ---------------------------------------------------------------- sparse chain

await test('assembleScanRow: no live quotes -> unranked but gamma context survives', () => {
  const row = assembleScanRow({ symbol: 'SPARSE', chainBody: bodyOf(chainPayload({ live: false })), now: NOW });
  assert.equal(row.ok, true, 'the row itself is fine');
  assert.equal(row.vol, null, 'no VIX-style vol without live bid/ask');
  assert.equal(row.score, null);
  assert.equal(row.rankable, false);
  assert.equal(row.data_flags.no_vol, true);
  assert.equal(row.data_flags.low_data, true);
  assert.ok(Number.isFinite(row.gamma.net_gex), 'gamma still computes from IV + OI');
  assert.ok(row.snapshot && row.snapshot.vol === null, 'snapshot present, vol block null');
});

// ---------------------------------------------------------------- parity with the direct math

await test('assembleScanRow: snapshot + score match a direct GexExposure/GexMetrics computation', () => {
  const payload = chainPayload({ sigma: 0.22, callOi: 300, putOi: 500 });
  const closes = noisyCloses();
  const vixOfficial = 19.4;
  const row = assembleScanRow({ symbol: 'PAR', chainBody: bodyOf(payload), historyBody: histBody(closes), vixOfficial, now: NOW });

  // recompute independently the way the browser dashboard would
  const chain = E.parseCboe(payload, 'PAR', NOW);
  const volm = E.buildVolMetrics(chain, closes.filter((c) => isFinite(c) && c > 0), Mx);
  const chg5d = closes.length >= 6 ? (closes[closes.length - 1] / closes[closes.length - 6] - 1) * 100 : null;
  const snap = E.buildSnapshot(chain, volm, { vixOfficial, chg5d });
  assert.equal(JSON.stringify(row.snapshot), JSON.stringify(snap), 'byte-identical snapshot -> shared analyze cache key');

  const score = Mx.volMispricingScore({ iv30: volm.vix30, vrp: volm.vrp, slope: volm.slope, fly: volm.smile ? volm.smile.fly : null, convScore: volm.read ? volm.read.score : null });
  const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
  assert.equal(row.score, r2(score.score), 'row score matches the pure scorer');
  assert.equal(row.topSignal, score.topSignal);

  // the snapshot is analyze-ready
  assert.equal(validateSnapshot(row.snapshot), null, 'passes /api/analyze validation');
});

// ---------------------------------------------------------------- shared-cache regression

await test('scanRow: a warmed shared cache does not break later rows', async () => {
  // Regression: cached() returns a BARE value on a hit, so once the first ticker
  // warms the shared VIX (and history) entry, a raw .catch() on it would throw
  // and every later row would fail. Two rows here; the second hits cached VIX.
  const realFetch = globalThis.fetch;
  const jsonRes = (status, obj) => Promise.resolve({
    ok: status >= 200 && status < 300, status,
    text: () => Promise.resolve(JSON.stringify(obj)), json: () => Promise.resolve(obj),
  });
  const liveNow = Date.now(); // scanRow parses with the real clock, so expiries must be genuinely future
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('tradier.com')) return Promise.reject(new Error('tradier disabled in test')); // force CBOE fallbacks
    if (u.includes('/delayed_quotes/options/')) return jsonRes(200, chainPayload({ sigma: 0.28, now: liveNow }));
    if (u.includes('/charts/historical/')) return jsonRes(200, { data: noisyCloses(40).map((c, i) => ({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, close: String(c) })) });
    if (u.includes('/quotes/_VIX')) return jsonRes(200, { data: { current_price: 15.5, last_trade_time: null } });
    return Promise.reject(new Error('unexpected url: ' + u));
  };
  try {
    const first = await scanRow('AAA', 'cboe', { refresh: true });  // warms the shared 'vix' cache
    const second = await scanRow('BBB', 'cboe', { refresh: true }); // hits cached VIX (a bare string) -> must not throw
    assert.equal(first.ok, true, first.error || 'first row failed');
    assert.equal(second.ok, true, 'a warmed VIX cache must not break the second row');
    assert.ok(second.vol && Number.isFinite(second.vol.iv30), 'second row still carries vol');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------- error isolation

await test('scanRow: a failed fetch yields an ok:false row, not a throw', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('network disabled for test'));
  try {
    const row = await scanRow('BOGUS', '', { refresh: true });
    assert.equal(row.ok, false, 'one dead ticker cannot sink the scan');
    assert.equal(row.symbol, 'BOGUS');
    assert.ok(typeof row.error === 'string' && row.error.length, 'carries an error message');
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
