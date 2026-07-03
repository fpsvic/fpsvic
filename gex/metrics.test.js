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

test('convexityRead verdicts', () => {
  assert.equal(M.convexityRead({ vrp: 10, slope: -3, fly: 3 }).verdict, 'bid');
  assert.equal(M.convexityRead({ vrp: -2, slope: 4, fly: 0 }).verdict, 'offered');
  assert.equal(M.convexityRead({ vrp: 3, slope: 1.5, fly: 1 }).verdict, 'balanced');
  assert.equal(M.convexityRead({}).ok, false);
  // partial inputs still produce a read
  assert.ok(M.convexityRead({ slope: -4 }).ok);
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
