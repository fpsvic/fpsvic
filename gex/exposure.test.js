'use strict';

/* Unit tests for gex/exposure.js — plain node, zero dependencies:
 *   node gex/exposure.test.js
 * exposure.js and metrics.js are classic scripts (the repo is ESM), so load them
 * through the same CommonJS-style Function shim metrics.test.js uses. */

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
const M = shimLoad('metrics.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}
const approx = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? 'value'}: ${a} !~ ${b} (tol ${tol})`);

// fixed clock so parse cutoffs / T floors are deterministic
const NOW = Date.UTC(2026, 0, 15, 15, 0, 0);
const ymd = (ms) => { const d = new Date(ms); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; };
function occSym(root, y, m, d, type, strike) {
  const k = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${root}${String(y % 100).padStart(2, '0')}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}${type}${k}`;
}

// A flat-IV CBOE-shaped payload across two expiries, BS-priced so the vol calc works.
function flatCboe({ S = 100, sigma = 0.2, dtes = [20, 40], lo = 60, hi = 140, step = 1, oi = 100, root = 'TEST' } = {}) {
  const options = [];
  for (const dte of dtes) {
    const [y, m, d] = ymd(NOW + dte * 86400e3);
    const T = Math.max((Date.UTC(y, m - 1, d, 20, 0, 0) - NOW) / E.MS_YEAR, 1 / (365 * 96));
    for (let K = lo; K <= hi; K += step) {
      for (const type of ['C', 'P']) {
        const mid = M.bsPrice(S, K, T, sigma, E.RISK_FREE, type);
        const live = isFinite(mid) && mid >= 0.05;
        options.push({
          option: occSym(root, y, m, d, type, K),
          open_interest: oi, volume: 0,
          bid: live ? mid * 0.99 : 0, ask: live ? mid * 1.01 : 0.05,
          iv: sigma, gamma: NaN,
        });
      }
    }
  }
  return { timestamp: '2026-01-15T15:00:00.000Z', _source: 'synthetic', data: { symbol: 'TEST', current_price: S, options } };
}

// A single strike / expiry with chosen call and put OI (for exposure-sign tests).
function twoLegged(callOi, putOi, { S = 100, K = 100, dte = 30, root = 'XYZ' } = {}) {
  const [y, m, d] = ymd(NOW + dte * 86400e3);
  const leg = (type, oi) => ({ option: occSym(root, y, m, d, type, K), open_interest: oi, volume: 0, bid: 5, ask: 5.2, iv: 0.2, gamma: NaN });
  return { timestamp: 't', _source: 's', data: { symbol: root, current_price: S, options: [leg('C', callOi), leg('P', putOi)] } };
}

// ---------------------------------------------------------------- parseCboe

test('parseCboe reads spot, strips index prefixes, dedupes to future options', () => {
  const ch = E.parseCboe(flatCboe({ root: 'TEST' }), 'TEST', NOW);
  assert.equal(ch.spot, 100);
  assert.equal(ch.symbol, 'TEST');
  assert.ok(ch.options.length > 0);
  for (const o of ch.options) {
    assert.ok(o.T > 0, 'positive time to expiry');
    assert.ok(o.expiry > NOW - 12 * 3600e3, 'no stale expiries');
    assert.ok(o.type === 'C' || o.type === 'P');
  }
});

test('parseCboe strips a leading underscore from the returned symbol', () => {
  const p = flatCboe();
  p.data.symbol = '_SPX';
  assert.equal(E.parseCboe(p, 'SPX', NOW).symbol, 'SPX');
});

test('parseCboe drops malformed symbols and >12h-stale expiries', () => {
  const p = twoLegged(100, 100);
  p.data.options.push({ option: 'not-an-occ-symbol', open_interest: 999, bid: 1, ask: 1 });
  // an expiry two days in the past must be excluded
  const [y, m, d] = ymd(NOW - 2 * 86400e3);
  p.data.options.push({ option: occSym('XYZ', y, m, d, 'C', 100), open_interest: 999, bid: 1, ask: 1, iv: 0.2 });
  const ch = E.parseCboe(p, 'XYZ', NOW);
  assert.equal(ch.options.length, 2, 'only the two valid future legs survive');
});

test('parseCboe throws on unusable payloads', () => {
  assert.throws(() => E.parseCboe({ data: {} }, 'X', NOW), /Unexpected CBOE payload/);
  assert.throws(() => E.parseCboe({ data: { current_price: 0, options: [] } }, 'X', NOW), /No spot price/);
  const allZeroOi = twoLegged(0, 0);
  assert.throws(() => E.parseCboe(allZeroOi, 'XYZ', NOW), /no open interest/);
});

// ---------------------------------------------------------------- greeks

test('bsGreeks.gamma matches a finite difference of GexMetrics.bsPrice', () => {
  const [S, K, T, sig] = [100, 100, 0.1, 0.2];
  const h = 0.05;
  const p = (s) => M.bsPrice(s, K, T, sig, E.RISK_FREE, 'C');
  const fdGamma = (p(S + h) - 2 * p(S) + p(S - h)) / (h * h);
  approx(E.bsGreeks(S, K, T, sig).gamma, fdGamma, 1e-4, 'analytic gamma vs FD');
});

test('bsGreeks.gamma is positive and peaks near the money', () => {
  const g = (K) => E.bsGreeks(100, K, 0.1, 0.2).gamma;
  assert.ok(g(100) > 0);
  assert.ok(g(100) > g(80) && g(100) > g(120), 'gamma peaks ATM');
});

test('dealerSign: long calls (+1), short puts (-1)', () => {
  assert.equal(E.dealerSign('C'), 1);
  assert.equal(E.dealerSign('P'), -1);
});

test('optionGreeks falls back to quoted gamma without a usable IV', () => {
  const g = E.optionGreeks({ strike: 100, T: 0.1, iv: 0, gammaQuoted: 0.042 }, 100);
  assert.equal(g.gamma, 0.042);
  assert.equal(g.vanna, 0);
  assert.equal(g.charm, 0);
});

// ---------------------------------------------------------------- computeMetrics

test('computeMetrics: net GEX sign follows the call/put OI balance', () => {
  const callsHeavy = E.computeMetrics(E.parseCboe(twoLegged(1000, 100), 'XYZ', NOW), 'all');
  const putsHeavy = E.computeMetrics(E.parseCboe(twoLegged(100, 1000), 'XYZ', NOW), 'all');
  assert.ok(callsHeavy.netGex > 0, 'dealers long gamma when calls dominate');
  assert.ok(putsHeavy.netGex < 0, 'dealers short gamma when puts dominate');
});

test('computeMetrics: call wall = max call gamma strike, put wall = min put gamma strike', () => {
  const p = { timestamp: 't', _source: 's', data: { symbol: 'W', current_price: 100, options: [] } };
  const [y, m, d] = ymd(NOW + 30 * 86400e3);
  const leg = (type, K, oi) => ({ option: occSym('W', y, m, d, type, K), open_interest: oi, volume: 0, bid: 3, ask: 3.2, iv: 0.2 });
  p.data.options.push(leg('C', 105, 5000), leg('P', 105, 0), leg('C', 95, 0), leg('P', 95, 5000));
  const m2 = E.computeMetrics(E.parseCboe(p, 'W', NOW), 'all');
  assert.equal(m2.callWall.strike, 105, 'call wall at the call-OI spike');
  assert.equal(m2.putWall.strike, 95, 'put wall at the put-OI spike');
});

test('zeroCrossing interpolates a sign change and returns null for a one-signed book', () => {
  approx(E.zeroCrossing([{ s: 90, gex: -5 }, { s: 100, gex: 5 }], 'gex', 100), 95, 1e-9);
  // an all-calls chain is long gamma everywhere -> no flip
  const callsOnly = twoLegged(1000, 0);
  const m3 = E.computeMetrics(E.parseCboe(callsOnly, 'XYZ', NOW), 'all');
  assert.equal(m3.flip, null, 'no zero-gamma crossing in a pure long-gamma book');
});

test('computeMetrics respects the maxDte filter', () => {
  const p = flatCboe({ dtes: [3, 40] });
  const ch = E.parseCboe(p, 'TEST', NOW);
  const wk = E.computeMetrics(ch, '7');
  const all = E.computeMetrics(ch, 'all');
  assert.ok(wk.optionCount < all.optionCount, 'the 1-week slice drops the 40-day expiry');
});

// ---------------------------------------------------------------- buildVolMetrics

test('buildVolMetrics recovers a flat vol surface and handles missing history', () => {
  const ch = E.parseCboe(flatCboe({ sigma: 0.2 }), 'TEST', NOW);
  const withHist = E.buildVolMetrics(ch, Array(40).fill(100), M);
  assert.ok(withHist.ok, withHist.reason);
  approx(withHist.vix30, 20, 1.0, 'VIX-style ~ 20 on a flat 20-vol surface');
  assert.equal(withHist.rv, 0, 'constant closes -> zero realized');
  approx(withHist.vrp, 20, 1.0, 'vrp = iv30 - 0');
  // no history: still ok, but vrp is null (never fabricated)
  const noHist = E.buildVolMetrics(ch, [], M);
  assert.ok(noHist.ok);
  assert.equal(noHist.vrp, null);
});

test('buildVolMetrics degrades without the metrics module or a chain', () => {
  assert.equal(E.buildVolMetrics(null, [], M), null);
  assert.equal(E.buildVolMetrics({ options: [] }, [], null).ok, false);
});

// ---------------------------------------------------------------- buildSnapshot (cache-key parity)

test('buildSnapshot is deterministic and re-parse-stable (guards the /api/analyze cache)', () => {
  const payload = flatCboe();
  const chA = E.parseCboe(payload, 'TEST', NOW);
  const volmA = E.buildVolMetrics(chA, Array(40).fill(100), M);
  const snap1 = JSON.stringify(E.buildSnapshot(chA, volmA, { vixOfficial: 18.3, chg5d: 1.234 }));
  const snap2 = JSON.stringify(E.buildSnapshot(chA, volmA, { vixOfficial: 18.3, chg5d: 1.234 }));
  assert.equal(snap1, snap2, 'same inputs -> byte-identical snapshot');
  // a fresh parse of the SAME json must serialize identically (browser vs server)
  const chB = E.parseCboe(payload, 'TEST', NOW);
  const volmB = E.buildVolMetrics(chB, Array(40).fill(100), M);
  const snap3 = JSON.stringify(E.buildSnapshot(chB, volmB, { vixOfficial: 18.3, chg5d: 1.234 }));
  assert.equal(snap1, snap3, 'a re-parse of the same payload yields the same cache key');
});

test('buildSnapshot shape: required fields, r2 rounding, null-safe vol block', () => {
  const ch = E.parseCboe(flatCboe(), 'TEST', NOW);
  const snap = E.buildSnapshot(ch, { ok: false }, { chg5d: null });
  assert.equal(snap.kind, 'gex-dashboard-snapshot');
  assert.equal(snap.symbol, 'TEST');
  assert.equal(snap.vol, null, 'vol block is null when volm is not ok');
  assert.equal(snap.price_change_5d_pct, null);
  assert.ok('net_gex_all_usd' in snap.exposures);
  // r2 rounds spot to 2 decimals
  const ch2 = E.parseCboe({ ...flatCboe(), data: { ...flatCboe().data, current_price: 100.98765 } }, 'TEST', NOW);
  assert.equal(E.buildSnapshot(ch2, { ok: false }, {}).spot, 100.99);
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
