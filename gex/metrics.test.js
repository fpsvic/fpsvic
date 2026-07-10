'use strict';

/* Unit tests for gex/metrics.js — plain node, zero dependencies:
 *   node gex/metrics.test.js
 * metrics.js is a classic script (the repo is ESM), so load it through a
 * CommonJS-style shim instead of import. */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, 'metrics.js'), 'utf8');
const shim = { exports: {} };
new Function('module', 'exports', src)(shim, shim.exports);
const M = shim.exports;

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

// Synthetic chain builder: options at every strike, both types, priced at flat BS IV.
function flatChain({ S = 100, sigma = 0.2, r = 0, days = 30, lo = 40, hi = 200, step = 1, expiry = 1 }) {
  const T = days / 365;
  const out = [];
  for (let K = lo; K <= hi; K += step) {
    for (const type of ['C', 'P']) {
      const mid = M.bsPrice(S, K, T, sigma, r, type);
      out.push({ type, strike: K, expiry, dte: days, T, iv: sigma, bid: mid, ask: mid, oi: 1 });
    }
  }
  return out;
}

// ---------------------------------------------------------------- black-scholes basics

test('normCdf matches known values', () => {
  approx(M.normCdf(0), 0.5, 1e-9);
  approx(M.normCdf(1.96), 0.9750021, 1e-4);
  approx(M.normCdf(-1.96), 0.0249979, 1e-4);
});

test('bsPrice satisfies put-call parity', () => {
  const [S, K, T, sig, r] = [105, 98, 0.4, 0.27, 0.04];
  const c = M.bsPrice(S, K, T, sig, r, 'C');
  const p = M.bsPrice(S, K, T, sig, r, 'P');
  approx(c - p, S - K * Math.exp(-r * T), 1e-9, 'C - P vs S - K e^{-rT}');
});

test('bsPrice matches textbook ATM value', () => {
  // S=K=100, T=1, sigma=0.2, r=0 -> call ~ 7.9656
  approx(M.bsPrice(100, 100, 1, 0.2, 0, 'C'), 7.9656, 2e-3);
});

test('bsDelta: put delta = call delta - 1', () => {
  const dc = M.bsDelta(100, 110, 0.25, 0.3, 0.04, 'C');
  const dp = M.bsDelta(100, 110, 0.25, 0.3, 0.04, 'P');
  approx(dc - dp, 1, 1e-12);
  assert.ok(dc > 0 && dc < 0.5, 'OTM call delta in (0, 0.5)');
});

// ---------------------------------------------------------------- expiry variance

test('expiryVariance recovers a flat implied vol', () => {
  const days = 30, sigma = 0.2;
  const v = M.expiryVariance(flatChain({ sigma, days }), days / 365, 0);
  assert.ok(v.ok, v.reason);
  approx(Math.sqrt(v.sigma2), sigma, 0.002, 'sqrt(sigma2)');
  approx(v.F, 100, 0.15, 'forward');
  assert.ok(v.K0 <= v.F, 'K0 <= F');
});

test('expiryVariance with r > 0 still recovers flat vol', () => {
  const days = 45, sigma = 0.3, r = 0.05;
  const v = M.expiryVariance(flatChain({ sigma, days, r }), days / 365, r);
  assert.ok(v.ok, v.reason);
  approx(Math.sqrt(v.sigma2), sigma, 0.003, 'sqrt(sigma2)');
  approx(v.F, 100 * Math.exp(r * days / 365), 0.2, 'forward ~ S e^{rT}');
});

test('expiryVariance zero-bid exclusion truncates the wing', () => {
  const chain = flatChain({ sigma: 0.2, days: 30 }).map((o) =>
    o.strike < 70 ? { ...o, bid: 0 } : o);
  const v = M.expiryVariance(chain, 30 / 365, 0);
  assert.ok(v.ok, v.reason);
  approx(Math.sqrt(v.sigma2), 0.2, 0.002, 'tail truncation is negligible for flat vol');
});

test('expiryVariance rejects hopeless inputs', () => {
  assert.equal(M.expiryVariance([], 0.1, 0).ok, false);
  const oneSided = flatChain({ sigma: 0.2, days: 30 }).filter((o) => o.type === 'C');
  assert.equal(M.expiryVariance(oneSided, 30 / 365, 0).ok, false);
});

// ---------------------------------------------------------------- vix-style index

test('vixStyle interpolates two flat expiries to the same vol', () => {
  const chain = [
    ...flatChain({ sigma: 0.2, days: 20, expiry: 20 }),
    ...flatChain({ sigma: 0.2, days: 40, expiry: 40 }),
  ];
  const v = M.vixStyle(chain, 0);
  assert.ok(v.ok, v.reason);
  assert.equal(v.method, 'interpolated');
  approx(v.value, 20, 0.25, '30d index on a flat 20-vol surface');
  assert.equal(v.term.length, 2);
});

test('vixStyle falls back to single expiry when 30d is not bracketed', () => {
  const v = M.vixStyle(flatChain({ sigma: 0.25, days: 10, expiry: 10 }), 0);
  assert.ok(v.ok, v.reason);
  assert.match(v.method, /single-expiry/);
  approx(v.value, 25, 0.3);
});

test('ivAtHorizon interpolates between expiries and clamps outside', () => {
  const chain = [
    ...flatChain({ sigma: 0.15, days: 20, expiry: 20 }),
    ...flatChain({ sigma: 0.25, days: 40, expiry: 40 }),
  ];
  const { term } = M.vixStyle(chain, 0);
  const at20 = M.ivAtHorizon(term, 20), at30 = M.ivAtHorizon(term, 30), at40 = M.ivAtHorizon(term, 40);
  approx(at20, 15, 0.25);
  approx(at40, 25, 0.3);
  assert.ok(at30 > at20 && at30 < at40, `30d (${at30}) between 20d and 40d`);
  approx(M.ivAtHorizon(term, 5), at20, 1e-9, 'flat extrapolation below');
  approx(M.ivAtHorizon(term, 90), at40, 1e-9, 'flat extrapolation above');
});

// ---------------------------------------------------------------- realized vol

test('realizedVol: constant closes -> zero', () => {
  const rv = M.realizedVol(Array(40).fill(100));
  assert.ok(rv.ok, rv.reason);
  approx(rv.value, 0, 1e-9);
});

test('realizedVol matches hand-computed alternating series', () => {
  const closes = [100];
  for (let i = 0; i < 30; i++) closes.push(closes[closes.length - 1] * (i % 2 ? 1 / 1.01 : 1.01));
  const r = Math.log(1.01);
  const expected = 100 * Math.sqrt(252 * r * r); // every squared return identical
  const rv = M.realizedVol(closes, 21);
  assert.ok(rv.ok, rv.reason);
  approx(rv.value, expected, 1e-6);
});

test('realizedVol refuses short histories', () => {
  assert.equal(M.realizedVol([100, 101, 102], 21).ok, false);
});

// ---------------------------------------------------------------- smile

function smileChain(ivOf, { S = 100, days = 30, r = 0 } = {}) {
  const T = days / 365;
  const out = [];
  for (let K = 60; K <= 140; K += 1) {
    for (const type of ['C', 'P']) out.push({ type, strike: K, expiry: 1, dte: days, T, iv: ivOf(K), bid: 1, ask: 1, oi: 1 });
  }
  return out;
}

test('smileAtExpiry: flat smile has zero fly and rr', () => {
  const s = M.smileAtExpiry(smileChain(() => 0.2), 100, 100, 30 / 365, 0);
  assert.ok(s.ok, s.reason);
  approx(s.atm, 20, 1e-9);
  approx(s.fly, 0, 0.02);
  approx(s.rr, 0, 0.02);
});

test('smileAtExpiry: curved skewed smile has positive fly and rr', () => {
  // put wing richer than call wing, both wings above ATM; 25d strikes sit ~±4%
  // from the money at 30d/20 vol, so the quadratic needs a hefty coefficient
  const ivOf = (K) => 0.2 - 0.3 * ((K - 100) / 100) + 5 * Math.pow((K - 100) / 100, 2);
  const s = M.smileAtExpiry(smileChain(ivOf), 100, 100, 30 / 365, 0);
  assert.ok(s.ok, s.reason);
  assert.ok(s.fly > 0.4, `fly ${s.fly} > 0.4`);
  assert.ok(s.rr > 0.5, `rr ${s.rr} > 0.5 (put skew)`);
});

// ---------------------------------------------------------------- convexity read

test('convexityRead verdicts (legacy raw-point path, no iv30)', () => {
  assert.equal(M.convexityRead({ vrp: 10, slope: -3, fly: 3 }).verdict, 'bid');
  assert.equal(M.convexityRead({ vrp: -2, slope: 4, fly: 0 }).verdict, 'offered');
  assert.equal(M.convexityRead({ vrp: 3, slope: 1.5, fly: 1 }).verdict, 'balanced');
  assert.equal(M.convexityRead({}).ok, false);
  // partial inputs still produce a read
  assert.ok(M.convexityRead({ slope: -4 }).ok);
});

test('convexityRead normalized by iv30: fair across vol levels', () => {
  // at SPX-typical iv=15 the fraction centers equal the legacy raw centers, so
  // the balanced point is preserved: vrp 3 / slope 1.5 / fly ~1 stays balanced
  assert.equal(M.convexityRead({ vrp: 3, slope: 1.5, fly: 1.05, iv30: 15 }).verdict, 'balanced');
  // the quant-review case: +5 vrp on a 60-vol name is NOISE (0.083 of iv) —
  // normalized it reads offered/cheap, while the legacy path overrates it
  const highVol = { vrp: 5, slope: 2, fly: 1.5 };
  assert.equal(M.convexityRead({ ...highVol, iv30: 60 }).verdict, 'offered', 'normalized: mild premium on 60-vol = convexity offered');
  // and a genuinely bid high-vol name still reads bid: +20 vrp on 60-vol (0.33 of iv)
  assert.equal(M.convexityRead({ vrp: 20, slope: -4, fly: 5, iv30: 60 }).verdict, 'bid');
  // score scales with the FRACTION: +5 vrp is a strong signal at iv=14, noise at iv=60
  const idx = M.convexityRead({ vrp: 5, iv30: 14 }).score;
  const single = M.convexityRead({ vrp: 5, iv30: 60 }).score;
  assert.ok(idx > 0.4 && single < 0, `fractional scaling (idx ${idx.toFixed(2)} vs single ${single.toFixed(2)})`);
});

test('volMispricingScore corroborator inherits the normalized convexity read', () => {
  // 60-vol name, mild raw premium: the old raw-centered corroborator pushed the
  // conv signal toward rich; normalized, it agrees with the primary signals
  const r = M.volMispricingScore({ iv30: 60, vrp: 5, slope: 2, fly: 1.5 });
  assert.ok(r.ok);
  const conv = r.signals.find((s) => s.name === 'conv');
  assert.ok(conv, 'corroborator present');
  assert.ok(conv.x <= 0, `conv signal is non-rich for a mild premium on a 60-vol name (x=${conv.x.toFixed(2)})`);
  assert.equal(r.direction, 'cheap');
});

// ---------------------------------------------------------------- vol-mispricing score

test('volMispricingScore: rich SPX example ranks rich, VRP-led, full coverage', () => {
  // iv30=14, vrp=+5 (0.36 of iv), backwardation slope=-1.5, wings bid fly=1.3
  const r = M.volMispricingScore({ iv30: 14, vrp: 5, slope: -1.5, fly: 1.3, convScore: 0.61 });
  assert.ok(r.ok, r.reason);
  approx(r.score, 0.67, 0.03, 'SPX score ~ +0.67');
  assert.equal(r.direction, 'rich');
  approx(r.coverage, 1, 1e-9, 'all four signals present');
  assert.equal(r.confidence, 1, 'vrp present -> no penalty');
  assert.equal(r.rankable, true);
  assert.equal(r.topSignal, 'vrp');
  // contributions reconstruct the score exactly
  approx(r.signals.reduce((a, s) => a + s.contribution, 0), r.score, 1e-12, 'contributions sum to score');
});

test('volMispricingScore: same +5pt premium reads CHEAP-ward on a 60-vol name', () => {
  // identical absolute vrp=+5 but iv30=60 -> only 0.08 of iv -> below the normal premium
  const spx = M.volMispricingScore({ iv30: 14, vrp: 5 });
  const tsla = M.volMispricingScore({ iv30: 60, vrp: 5 });
  assert.ok(spx.signals[0].x > 0.5, 'rich on the index');
  assert.ok(tsla.signals[0].x < 0, 'not rich on the high-vol name — the fairness fix');
});

test('volMispricingScore: TSLA worked example, missing fly not penalized', () => {
  // iv30=60, vrp=+5, contango slope=+3, no 25d smile (fly null), weak conv
  const r = M.volMispricingScore({ iv30: 60, vrp: 5, slope: 3, fly: null, convScore: 0.03 });
  assert.ok(r.ok, r.reason);
  approx(r.score, -0.13, 0.03, 'TSLA score ~ -0.13');
  assert.equal(r.direction, 'fair', '|score| < 0.20');
  approx(r.coverage, 0.85, 1e-9, 'fly dropped, coverage 1 - 0.15');
  assert.ok(!r.signals.some((s) => s.name === 'fly'), 'fly signal absent, not scored 0');
});

test('volMispricingScore: weights renormalize over present signals', () => {
  // VRP present -> conv is auto-derived from it too, so W = 0.45 + 0.15 = 0.60,
  // and the score is the renormalized blend of the two (NOT divided by 1.0)
  const r = M.volMispricingScore({ iv30: 20, vrp: 8 });
  assert.ok(r.ok, r.reason);
  approx(r.coverage, 0.60, 1e-9, 'vrp 0.45 + derived conv 0.15');
  const vrp = r.signals.find((s) => s.name === 'vrp');
  const conv = r.signals.find((s) => s.name === 'conv');
  approx(r.score, (0.45 * vrp.x + 0.15 * conv.x) / 0.60, 1e-12, 'renormalized over the present weight');
  assert.equal(r.rankable, true, 'vrp present -> rankable');
});

test('volMispricingScore: a lone thin signal is not rankable', () => {
  // no vrp and only one primary (conv auto-derives but carries no new info)
  const slopeOnly = M.volMispricingScore({ iv30: 20, slope: -5 });
  assert.equal(slopeOnly.rankable, false, 'slope alone does not top the scan');
  assert.ok(slopeOnly.signals.some((s) => s.name === 'conv'), 'conv corroborator auto-derived');
  approx(slopeOnly.confidence, slopeOnly.coverage * 0.85, 1e-9, 'no realized-vol history -> 0.85 factor');
  assert.equal(M.volMispricingScore({ iv30: 20, fly: 3 }).rankable, false, 'fly alone not rankable');
  // two independent structural signals (no vrp) ARE rankable
  assert.equal(M.volMispricingScore({ iv30: 20, slope: -5, fly: 3 }).rankable, true);
});

test('volMispricingScore: ok:false when no vol data', () => {
  assert.equal(M.volMispricingScore({ iv30: NaN, vrp: 5 }).ok, false);
  assert.equal(M.volMispricingScore({ iv30: 20 }).ok, false, 'iv30 alone is not a signal');
  assert.equal(M.volMispricingScore({ iv30: 20, vrp: null, slope: null, fly: null }).ok, false);
});

test('volMispricingScore: null inputs are not mistaken for zero (isFinite(null) trap)', () => {
  // isFinite(null) === true; a naive guard would score a null vrp as x for 0
  const r = M.volMispricingScore({ iv30: 20, vrp: null, slope: 2, fly: null });
  assert.ok(!r.signals.some((s) => s.name === 'vrp'), 'null vrp is absent');
  assert.ok(!r.signals.some((s) => s.name === 'fly'), 'null fly is absent');
});

test('volMispricingScore: x stays clamped to [-1,1]', () => {
  const hot = M.volMispricingScore({ iv30: 10, vrp: 50, slope: -30, fly: 20, convScore: 5 });
  for (const s of hot.signals) assert.ok(s.x >= -1 && s.x <= 1, `${s.name} x in range`);
  assert.ok(hot.score <= 1 && hot.score >= -1, 'score in range');
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
