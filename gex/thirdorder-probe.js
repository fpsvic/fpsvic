'use strict';

/* gex/thirdorder-probe.js — the OFFLINE ACCURACY PASS the roadmap gates 3rd-order
 * greeks behind (#8): "measure poll-to-poll noise vs signal before any pixel is
 * drawn." Numerically noisy greeks rendered confidently erode trust in the greeks
 * that are right, so this proves-or-kills speed/color/ultima BEFORE they touch the
 * mesh.
 *
 * The archive stores computed meshes, not raw IV, and today's archive is a single
 * static holiday day — so real poll-to-poll history can't measure input noise here.
 * Instead we measure INPUT-NOISE AMPLIFICATION directly on a live chain, which works
 * any day: 3rd-order greeks are 3rd derivatives, so small errors in the quoted IV
 * (which itself is only pinned to within the bid-ask spread) get amplified. If the
 * dealer-net speed/color/ultima swing wildly under the IV uncertainty the quotes
 * already carry — while net gamma/vanna/charm barely move — they are noise, not
 * signal.
 *
 * Three tests, each comparing 3rd-order (speed/color/ultima) to the trusted
 * 2nd-order baseline (gamma/vanna/charm) under the SAME aggregation
 * (dealer-signed, OI-weighted, sign = long calls / short puts):
 *   A. Systematic: a uniform +1 vol-point shift on every option → % change of each net.
 *   B. Noise (Monte Carlo): perturb each option's IV by Normal(0, its own bid-ask-
 *      implied IV uncertainty) over many trials → coefficient of variation (std/|mean|).
 *   C. Roughness: cross-strike 2nd-difference roughness of each greek's strike profile
 *      (a coherent surface is smooth; noise is spiky).
 *
 * Run (server must be up on :8787):  node gex/thirdorder-probe.js [SYM ...]
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
function shimLoad(file) {
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  const shim = { exports: {} };
  new Function('module', 'exports', src)(shim, shim.exports);
  return shim.exports;
}
const E = shimLoad('exposure.js');

const PORT = process.env.GEX_PORT || 8787;
const TRIALS = 400;
const GREEKS2 = ['gamma', 'vanna', 'charm'];
const GREEKS3 = ['speed', 'color', 'ultima'];
const ALL = [...GREEKS2, ...GREEKS3];

function getChain(symbol) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}/api/chain?symbol=${encodeURIComponent(symbol)}`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j && j.error) reject(new Error(j.error));
          else resolve(j);
        } catch (e) { reject(new Error(`bad JSON from /api/chain (${data.slice(0, 80)})`)); }
      });
    }).on('error', reject);
  });
}

// standard normal via Box-Muller (Math.random is fine in a standalone script)
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// per-option greeks for a given IV, dealer-signed and OI-weighted, summed into `acc`.
// Same OI×sign weighting for every greek so the 3rd-vs-2nd comparison is apples-to-apples
// (the dollar-scaling constants gamma·S² etc. are per-greek constants and don't change a CV).
function addNets(acc, rows, S, ivOf) {
  for (const r of rows) {
    const iv = ivOf(r);
    if (!(iv > 0.005)) continue;
    const g2 = E.bsGreeks(S, r.strike, r.T, iv, r.type);
    const g3 = E.bsGreeks3(S, r.strike, r.T, iv);
    const w = r.sign * r.oi;
    acc.gamma += w * g2.gamma; acc.vanna += w * g2.vanna; acc.charm += w * g2.charm;
    acc.speed += w * g3.speed; acc.color += w * g3.color; acc.ultima += w * g3.ultima;
  }
  return acc;
}
const zeroAcc = () => ({ gamma: 0, vanna: 0, charm: 0, speed: 0, color: 0, ultima: 0 });

function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function std(a) { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) * (x - m)))); }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
function fmtExp(v) { return v === 0 ? '0' : v.toExponential(2); }

async function analyze(symbol) {
  const chainJson = await getChain(symbol);
  const chain = E.parseCboe(chainJson, symbol);
  const S = chain.spot;

  // usable options: real OI + a usable IV (the same gate optionGreeks uses).
  // Each carries a per-option IV uncertainty = half the bid-ask spread expressed
  // in vol points via vega (the market cannot pin IV finer than the spread).
  const rows = [];
  for (const o of chain.options) {
    if (!(o.oi > 0) || !(o.iv > 0.005)) continue;
    const vega = E.bsGreeks3(S, o.strike, o.T, o.iv).vega; // per 1.00 vol, per share
    const spread = Math.max(0, o.ask - o.bid);
    const dIv = vega > 1e-6 ? Math.min(0.5, (spread / 2) / vega) : 0.5; // clamp degenerate to 50 vol pts
    rows.push({ strike: o.strike, T: o.T, type: o.type, oi: o.oi, iv: o.iv, dte: o.dte, sign: E.dealerSign(o.type), dIv });
  }
  if (rows.length < 20) { console.log(`\n${symbol}: only ${rows.length} usable options — skipping.`); return null; }

  const spreads = rows.map((r) => r.dIv).sort((a, b) => a - b);
  const medDiv = spreads[Math.floor(spreads.length / 2)];

  const base = addNets(zeroAcc(), rows, S, (r) => r.iv);

  // --- Test A: uniform +1 vol-point shift ---
  const shifted = addNets(zeroAcc(), rows, S, (r) => r.iv + 0.01);
  const pctA = {};
  for (const g of ALL) pctA[g] = Math.abs(base[g]) > 0 ? Math.abs((shifted[g] - base[g]) / base[g]) * 100 : Infinity;

  // --- Test B: Monte Carlo over per-option spread-implied IV noise → CV ---
  const samples = {}; for (const g of ALL) samples[g] = [];
  for (let t = 0; t < TRIALS; t++) {
    const acc = addNets(zeroAcc(), rows, S, (r) => r.iv + gauss() * r.dIv);
    for (const g of ALL) samples[g].push(acc[g]);
  }
  const cv = {};
  for (const g of ALL) { const m = mean(samples[g]); cv[g] = Math.abs(m) > 0 ? std(samples[g]) / Math.abs(m) : Infinity; }

  // --- Test C: cross-strike roughness of each greek's per-strike net profile ---
  const byStrike = new Map();
  for (const r of rows) {
    const g2 = E.bsGreeks(S, r.strike, r.T, r.iv, r.type);
    const g3 = E.bsGreeks3(S, r.strike, r.T, r.iv);
    let e = byStrike.get(r.strike);
    if (!e) byStrike.set(r.strike, (e = zeroAcc()));
    const w = r.sign * r.oi;
    e.gamma += w * g2.gamma; e.vanna += w * g2.vanna; e.charm += w * g2.charm;
    e.speed += w * g3.speed; e.color += w * g3.color; e.ultima += w * g3.ultima;
  }
  const ks = [...byStrike.keys()].sort((a, b) => a - b);
  const rough = {};
  for (const g of ALL) {
    const prof = ks.map((k) => byStrike.get(k)[g]);
    let curv = 0, mag = 0;
    for (let i = 1; i < prof.length - 1; i++) curv += Math.abs(prof[i - 1] - 2 * prof[i] + prof[i + 1]);
    for (const v of prof) mag += Math.abs(v);
    rough[g] = mag > 0 ? curv / mag : Infinity;
  }

  // --- 0DTE concentration: how much of each |net| sits in same-day contracts ---
  const z = addNets(zeroAcc(), rows.filter((r) => r.dte <= 1), S, (r) => r.iv);
  const conc0dte = {};
  for (const g of ALL) conc0dte[g] = Math.abs(base[g]) > 0 ? Math.abs(z[g] / base[g]) * 100 : 0;

  // ---- report ----
  console.log(`\n${'='.repeat(64)}\n${symbol}  spot ${S}  ·  ${rows.length} usable options  ·  median IV uncertainty ${(medDiv * 100).toFixed(2)} vol pts`);
  console.log(`${pad('greek', 8)}${padL('net', 13)}${padL('+1volpt %Δ', 13)}${padL('noise CV', 12)}${padL('roughness', 12)}${padL('0DTE %', 9)}`);
  const line = (g) => console.log(
    pad(g, 8) + padL(fmtExp(base[g]), 13) +
    padL(isFinite(pctA[g]) ? pctA[g].toFixed(1) + '%' : '—', 13) +
    padL(isFinite(cv[g]) ? cv[g].toFixed(3) : '—', 12) +
    padL(isFinite(rough[g]) ? rough[g].toFixed(3) : '—', 12) +
    padL(conc0dte[g].toFixed(0) + '%', 9));
  GREEKS2.forEach(line);
  console.log('  ' + '-'.repeat(60));
  GREEKS3.forEach(line);

  // ratios: 3rd-order metric vs the WORST-CASE 2nd-order baseline (the strictest bar)
  const base2 = { cv: Math.max(...GREEKS2.map((g) => cv[g]).filter(isFinite)), rough: Math.max(...GREEKS2.map((g) => rough[g]).filter(isFinite)), pct: Math.max(...GREEKS2.map((g) => pctA[g]).filter(isFinite)) };
  const ratio = {};
  for (const g of GREEKS3) ratio[g] = { cv: cv[g] / base2.cv, rough: rough[g] / base2.rough, pct: pctA[g] / base2.pct };
  console.log(`  vs worst 2nd-order (×):  ` + GREEKS3.map((g) => `${g} CV×${ratio[g].cv.toFixed(1)}/rough×${ratio[g].rough.toFixed(1)}`).join('  ·  '));
  return { symbol, cv, rough, pctA, ratio, base2 };
}

const symbols = process.argv.slice(2).map((s) => s.toUpperCase()).filter(Boolean);
const targets = symbols.length ? symbols : ['SPX', 'SPY', 'NVDA'];

(async () => {
  console.log(`3rd-order greek accuracy pass — ${TRIALS} Monte-Carlo trials per symbol`);
  console.log('Reading: net = dealer-signed OI-weighted sum · CV = std/|mean| under spread-implied IV noise · lower is better.');
  const results = [];
  for (const sym of targets) {
    try { const r = await analyze(sym); if (r) results.push(r); }
    catch (e) { console.log(`\n${sym}: FAILED — ${e.message}`); }
  }
  if (!results.length) { console.log('\nNo symbols analyzed.'); return; }

  // verdict: 3rd-order greeks are renderable only if their noise amplification is
  // within a small multiple of the trusted 2nd-order greeks across symbols
  console.log(`\n${'='.repeat(64)}\nVERDICT`);
  const worst = {};
  for (const g of GREEKS3) worst[g] = { cv: Math.max(...results.map((r) => r.ratio[g].cv)), rough: Math.max(...results.map((r) => r.ratio[g].rough)) };
  const CV_BAR = 4, ROUGH_BAR = 4; // "within ~4x of the noisiest trusted greek" is the renderable bar
  for (const g of GREEKS3) {
    const ok = worst[g].cv <= CV_BAR && worst[g].rough <= ROUGH_BAR;
    console.log(`  ${pad(g, 8)} worst CV ×${worst[g].cv.toFixed(1)}, worst roughness ×${worst[g].rough.toFixed(1)}  →  ${ok ? 'RENDERABLE' : 'TOO NOISY — do not render as-is'}`);
  }
  console.log(`\n  (bar: a 3rd-order net must stay within ${CV_BAR}x the noise CV and ${ROUGH_BAR}x the roughness of the WORST trusted 2nd-order greek.)`);
})();
