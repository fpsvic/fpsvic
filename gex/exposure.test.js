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

test('parseCboe drops malformed symbols and settled expiries', () => {
  const p = twoLegged(100, 100);
  p.data.options.push({ option: 'not-an-occ-symbol', open_interest: 999, bid: 1, ask: 1 });
  // yesterday's expiry settled at yesterday's close — must be excluded
  const [y, m, d] = ymd(NOW - 1 * 86400e3);
  p.data.options.push({ option: occSym('XYZ', y, m, d, 'C', 100), open_interest: 999, bid: 1, ask: 1, iv: 0.2 });
  const ch = E.parseCboe(p, 'XYZ', NOW);
  assert.equal(ch.options.length, 2, 'only the two valid future legs survive');
});

test('nyCloseUtc is DST-aware: EST winter close is 21:00 UTC, EDT summer close is 20:00 UTC', () => {
  assert.equal(E.nyCloseUtc(2026, 1, 15), Date.UTC(2026, 0, 15, 21, 0, 0), 'January (EST) -> 21:00 UTC');
  assert.equal(E.nyCloseUtc(2026, 7, 3), Date.UTC(2026, 6, 3, 20, 0, 0), 'July (EDT) -> 20:00 UTC');
});

test('parseCboe: same-day contracts stay alive through the close, drop once settled past the feed delay', () => {
  const [y, m, d] = ymd(NOW); // Jan 15 — EST, so today\'s close is 21:00 UTC
  const todayLeg = (root) => {
    const p = twoLegged(100, 100, { root, dte: 30 }); // a live far leg keeps the parse valid
    p.data.options.push({ option: occSym(root, y, m, d, 'C', 100), open_interest: 500, bid: 1, ask: 1.1, iv: 0.2 });
    return p;
  };
  // 3:30pm ET (20:30 UTC): the fixed 20:00-UTC stamp would call this settled — it must be alive
  const lastHour = E.parseCboe(todayLeg('AAA'), 'AAA', Date.UTC(2026, 0, 15, 20, 30, 0));
  assert.equal(lastHour.options.length, 3, 'live 0DTE survives the last trading hour in winter');
  assert.ok(lastHour.options.every((o) => o.dte >= 1), 'a live same-day contract is dte 1, not 0');
  // 4:10pm ET: settled 10 min ago, still inside the 15-min delayed-feed slack -> kept
  const justSettled = E.parseCboe(todayLeg('BBB'), 'BBB', Date.UTC(2026, 0, 15, 21, 10, 0));
  assert.equal(justSettled.options.length, 3, 'contract settled less than the feed delay ago is kept');
  // 4:30pm ET: settled past the slack -> dropped (no more T-floor gamma monsters after hours)
  const evening = E.parseCboe(todayLeg('CCC'), 'CCC', Date.UTC(2026, 0, 15, 21, 30, 0));
  assert.equal(evening.options.length, 2, 'settled contract is gone from the evening chain');
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

test('bsGreeks.delta: call delta in (0,1), put delta = call delta - 1, defaults to call', () => {
  const call = E.bsGreeks(100, 110, 0.25, 0.3, 'C');
  const put = E.bsGreeks(100, 110, 0.25, 0.3, 'P');
  assert.ok(call.delta > 0 && call.delta < 1, 'OTM call delta in (0,1)');
  approx(put.delta, call.delta - 1, 1e-9, 'put delta = call delta - 1');
  approx(E.bsGreeks(100, 110, 0.25, 0.3).delta, call.delta, 1e-9, 'type defaults to C');
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

// ---------------------------------------------------------------- computeMeshBands

test('computeMeshBands: strikes are restricted to the range window and sorted', () => {
  const ch = E.parseCboe(flatCboe({ S: 100, lo: 60, hi: 140, step: 1 }), 'TEST', NOW);
  const mesh = E.computeMeshBands(ch, E.DEFAULT_MESH_BANDS, 0.10);
  assert.ok(mesh.strikes.length > 0);
  assert.ok(mesh.strikes[0] >= 90 && mesh.strikes[mesh.strikes.length - 1] <= 110, 'strikes stay within +/-10%');
  for (let i = 1; i < mesh.strikes.length; i++) assert.ok(mesh.strikes[i] > mesh.strikes[i - 1], 'strikes sorted ascending');
});

test('computeMeshBands: a band with no options in range is all zeros, and gex re-sums to computeMetrics-style net GEX', () => {
  // flatCboe is symmetric call/put OI, which cancels exactly (BS gamma is
  // identical for a call and put at the same strike/expiry) — bias the puts
  // so the Monthly band has a real nonzero signal to check.
  const ch = E.parseCboe(twoLegged(200, 500, { S: 100, K: 102, dte: 40 }), 'XYZ', NOW);
  const mesh = E.computeMeshBands(ch, E.DEFAULT_MESH_BANDS, 0.10);
  const zeroDte = mesh.bands.find((b) => b.name === '0DTE');
  assert.ok(zeroDte.gex.every((v) => v === 0), '~40dte-only chain contributes nothing to the 0DTE band');
  assert.ok(zeroDte.vanna.every((v) => v === 0) && zeroDte.charm.every((v) => v === 0) && zeroDte.delta.every((v) => v === 0));
  assert.ok(zeroDte.speed.every((v) => v === 0), 'speed is empty in the untouched 0DTE band too');
  const monthly = mesh.bands.find((b) => b.name === 'Monthly');
  assert.ok(monthly.gex.some((v) => v !== 0), 'the ~40dte options land in the Monthly band');
  assert.ok(monthly.vanna.some((v) => v !== 0), 'vanna is populated alongside gex');
  assert.ok(monthly.charm.some((v) => v !== 0), 'charm is populated alongside gex');
  assert.ok(monthly.delta.some((v) => v !== 0), 'delta is populated alongside gex');
  assert.ok(monthly.speed.some((v) => v !== 0), 'speed (3rd-order) is populated alongside gex');
  assert.ok(monthly.speed.every((v) => isFinite(v)), 'every speed value is finite');
  const bandTotal = mesh.bands.reduce((sum, b) => sum + b.gex.reduce((s, v) => s + v, 0), 0);
  const all = E.computeMetrics(ch, 'all').strikes
    .filter((r) => r.strike >= mesh.strikes[0] && r.strike <= mesh.strikes[mesh.strikes.length - 1])
    .reduce((s, r) => s + r.gex, 0);
  approx(bandTotal, all, Math.abs(all) * 1e-6 + 1e-6, 'mesh bands re-sum to the same net gex as computeMetrics over the same strikes');
});

test('computeMeshBands: distinct bands can disagree in sign at the same strike, on every greek (a strike can be gyrus and sulcus at once)', () => {
  const S = 100, K = 105;
  const near = twoLegged(0, 500, { S, K, dte: 0 });   // near-term (lands in 0DTE): put-heavy at 105 -> negative
  const far = twoLegged(500, 0, { S, K, dte: 40 });   // far-term (lands in Monthly): call-heavy at 105 -> positive
  near.data.options.push(...far.data.options);
  const ch = E.parseCboe(near, 'XYZ', NOW);
  const mesh = E.computeMeshBands(ch, E.DEFAULT_MESH_BANDS, 0.10);
  const idx = mesh.strikes.indexOf(K);
  assert.ok(idx >= 0);
  const zeroDte = mesh.bands.find((b) => b.name === '0DTE');
  const monthly = mesh.bands.find((b) => b.name === 'Monthly');
  assert.ok(zeroDte.gex[idx] < 0, '0DTE band is put-heavy (sulcus) on gamma at strike 105');
  assert.ok(monthly.gex[idx] > 0, 'Monthly band is call-heavy (gyrus) on gamma at the same strike');
  // delta is the IMBALANCE (raw delta * OI, no dealer sign): the put-only near
  // band reads negative (put-side directional OI), the call-only far band
  // positive — dealer NET delta would be positive in both, a dead sign channel.
  assert.ok(zeroDte.delta[idx] < 0, '0DTE band: puts only -> negative delta imbalance');
  assert.ok(monthly.delta[idx] > 0, 'Monthly band: calls only -> positive delta imbalance');
});

// ---------------------------------------------------------------- computeBandLandmarks

test('computeMetrics minDte bounds the band from below', () => {
  const p = flatCboe({ dtes: [3, 40] });
  const ch = E.parseCboe(p, 'TEST', NOW);
  const near = E.computeMetrics(ch, '7', 0);
  const far = E.computeMetrics(ch, 'all', 8);
  const all = E.computeMetrics(ch, 'all');
  assert.ok(near.optionCount > 0 && far.optionCount > 0);
  assert.equal(near.optionCount + far.optionCount, all.optionCount, 'disjoint bands partition the book');
});

test('computeMetrics: a one-sided book has no wall on its empty side', () => {
  const putsOnly = E.computeMetrics(E.parseCboe(twoLegged(0, 500), 'XYZ', NOW), 'all');
  assert.equal(putsOnly.callWall, null, 'no call OI -> no call wall, not a zero-tie artifact');
  assert.ok(putsOnly.putWall, 'the put side is real');
  const callsOnly = E.computeMetrics(E.parseCboe(twoLegged(500, 0), 'XYZ', NOW), 'all');
  assert.equal(callsOnly.putWall, null, 'no put OI -> no put wall');
  assert.ok(callsOnly.callWall, 'the call side is real');
});

test('computeBandLandmarks: each band gets its own walls from its own options; empty bands return nulls', () => {
  // near band: call-heavy at 103; far band: put-heavy at 97 — walls must differ per band
  const near = twoLegged(800, 100, { S: 100, K: 103, dte: 0 });
  const far = twoLegged(100, 800, { S: 100, K: 97, dte: 40 });
  near.data.options.push(...far.data.options);
  const ch = E.parseCboe(near, 'XYZ', NOW);
  const bands = E.computeBandLandmarks(ch);
  const b0 = bands.find((b) => b.name === '0DTE');
  const bm = bands.find((b) => b.name === 'Monthly');
  const bw = bands.find((b) => b.name === 'Weekly');
  assert.equal(b0.callWall, 103, '0DTE call wall comes from the near-band book only');
  assert.equal(bm.putWall, 97, 'Monthly put wall comes from the far-band book only');
  assert.ok(b0.netGex > 0, 'call-heavy near band is net positive');
  assert.ok(bm.netGex < 0, 'put-heavy far band is net negative');
  assert.equal(bw.optionCount, 0, 'weekly band is empty');
  assert.equal(bw.callWall, null);
  assert.equal(bw.putWall, null);
  assert.equal(bw.flip, null);
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

test('buildSnapshot carries the vanna/charm picture: flips, 1w nets, per-strike curves', () => {
  const ch = E.parseCboe(flatCboe(), 'TEST', NOW);
  const snap = E.buildSnapshot(ch, { ok: false }, {});
  const ex = snap.exposures;
  assert.ok('charm_flip' in ex, 'charm_flip serialized (was computed but dropped before rubric v2)');
  assert.ok('vanna_flip' in ex);
  assert.ok(Number.isInteger(ex.net_vanna_1w_usd_per_volpt), 'front-week vanna net present');
  assert.ok(Number.isInteger(ex.net_charm_1w_usd_per_day), 'front-week charm net present');
  assert.ok(ex.top_strikes_by_gex.length > 0);
  for (const row of ex.top_strikes_by_gex) {
    assert.ok(Number.isInteger(row.net_vanna_usd), 'per-strike vanna on gamma top strikes');
    assert.ok(Number.isInteger(row.net_charm_usd), 'per-strike charm on gamma top strikes');
  }
  assert.ok(ex.top_strikes_by_vanna.length > 0, 'vanna concentration list present');
  for (const row of ex.top_strikes_by_vanna) {
    assert.ok(isFinite(row.strike) && Number.isInteger(row.net_vanna_usd) && Number.isInteger(row.net_charm_usd));
  }
  // the vanna list is sorted by |vanna| descending
  for (let i = 1; i < ex.top_strikes_by_vanna.length; i++) {
    assert.ok(Math.abs(ex.top_strikes_by_vanna[i - 1].net_vanna_usd) >= Math.abs(ex.top_strikes_by_vanna[i].net_vanna_usd));
  }
});

test('buildSnapshot tradeability hints: strike grid step and real listed expiries', () => {
  const ch = E.parseCboe(flatCboe({ S: 100, lo: 60, hi: 140, step: 1 }), 'TEST', NOW);
  const snap = E.buildSnapshot(ch, { ok: false }, {});
  assert.equal(snap.strike_increment, 1, 'unit-spaced synthetic grid -> increment 1');
  assert.ok(Array.isArray(snap.listed_dte) && snap.listed_dte.length > 0, 'listed expiries present');
  for (let i = 1; i < snap.listed_dte.length; i++) assert.ok(snap.listed_dte[i] > snap.listed_dte[i - 1], 'dte ascending');
  const chainDtes = new Set(ch.options.map((o) => o.dte));
  for (const d of snap.listed_dte) assert.ok(chainDtes.has(d), 'every listed_dte is a REAL chain expiry');
});

// ---------------------------------------------------------------- third-order greeks

test('bsGreeks3: speed/color/zomma/vomma/ultima match finite differences of the lower greeks', () => {
  const S = 100, K = 105, T = 0.25, sig = 0.22;
  const g3 = E.bsGreeks3(S, K, T, sig);
  const gamma = (s, k, t, v) => E.bsGreeks(s, k, t, v).gamma;
  const vega = (s, k, t, v) => E.bsGreeks3(s, k, t, v).vega;
  const vomma = (s, k, t, v) => E.bsGreeks3(s, k, t, v).vomma;
  const hS = S * 1e-4, hT = 1e-6, hV = 1e-5;
  const fdSpeed = (gamma(S + hS, K, T, sig) - gamma(S - hS, K, T, sig)) / (2 * hS);   // dGamma/dSpot
  const fdColor = (gamma(S, K, T + hT, sig) - gamma(S, K, T - hT, sig)) / (2 * hT);   // dGamma/dTimeToExpiry
  const fdZomma = (gamma(S, K, T, sig + hV) - gamma(S, K, T, sig - hV)) / (2 * hV);   // dGamma/dVol
  const fdVomma = (vega(S, K, T, sig + hV) - vega(S, K, T, sig - hV)) / (2 * hV);     // dVega/dVol
  const fdUltima = (vomma(S, K, T, sig + hV) - vomma(S, K, T, sig - hV)) / (2 * hV);  // dVomma/dVol
  const rel = (a, b) => Math.abs(a - b) / (Math.abs(b) + 1e-12);
  assert.ok(rel(g3.speed, fdSpeed) < 1e-3, `speed ${g3.speed} !~ fd ${fdSpeed}`);
  assert.ok(rel(g3.color, fdColor) < 1e-3, `color ${g3.color} !~ fd ${fdColor}`);
  assert.ok(rel(g3.zomma, fdZomma) < 1e-3, `zomma ${g3.zomma} !~ fd ${fdZomma}`);
  assert.ok(rel(g3.vomma, fdVomma) < 1e-3, `vomma ${g3.vomma} !~ fd ${fdVomma}`);
  assert.ok(rel(g3.ultima, fdUltima) < 5e-3, `ultima ${g3.ultima} !~ fd ${fdUltima}`);
});

test('bsGreeks3: all outputs finite for a normal ATM contract', () => {
  const g3 = E.bsGreeks3(100, 100, 0.1, 0.2);
  for (const k of ['speed', 'color', 'zomma', 'vomma', 'ultima', 'vega']) {
    assert.ok(isFinite(g3[k]), `${k} is finite`);
  }
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
