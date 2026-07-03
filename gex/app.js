'use strict';

/* Personal GEX — dealer gamma / vanna / charm exposure dashboard.
 * Data: CBOE free delayed quotes JSON (via ./server.js proxy, or direct fetch, or demo data).
 * Convention: dealers long calls, short puts (classic naive GEX assumption). */

// ---------------------------------------------------------------- config

const RISK_FREE = 0.04;          // flat risk-free rate for BS greeks
const CONTRACT_SIZE = 100;
const PROFILE_POINTS = 81;       // samples for the gamma-vs-spot profile
const PROFILE_RANGE = 0.10;      // +/- 10% of spot
const LADDER_STRIKES = 55;       // strikes shown in the ladders, nearest to spot
const MS_YEAR = 365 * 24 * 3600 * 1000;

// ---------------------------------------------------------------- state

let chain = null;                // parsed chain {symbol, spot, timestamp, options[]}
let expFilter = 'all';           // '0' | '7' | '31' | 'all'  (max DTE)
let metrics = null;              // computed exposures for current filter

// ---------------------------------------------------------------- dom helpers

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (k in node && k !== 'style') node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

// ---------------------------------------------------------------- formatting

function fmtDollars(v) {
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  const trim = (x, d) => x.toFixed(d).replace(/\.?0+$/, '');
  if (a >= 1e12) return `${sign}$${trim(a / 1e12, 2)}T`;
  if (a >= 1e9) return `${sign}$${trim(a / 1e9, 2)}B`;
  if (a >= 1e6) return `${sign}$${trim(a / 1e6, 1)}M`;
  if (a >= 1e3) return `${sign}$${trim(a / 1e3, 0)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

function fmtStrike(v) {
  return v.toLocaleString('en-US', { maximumFractionDigits: v < 100 ? 1 : 0 });
}

function fmtInt(v) {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// ---------------------------------------------------------------- black-scholes

function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/* Greeks shared by calls and puts (with zero dividend yield):
 * gamma, vanna (dDelta/dVol, per 1.00 vol), charm (dDelta/dt, per year). */
function bsGreeks(S, K, T, sigma) {
  const sqT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (RISK_FREE + 0.5 * sigma * sigma) * T) / (sigma * sqT);
  const d2 = d1 - sigma * sqT;
  const pdf = normPdf(d1);
  const gamma = pdf / (S * sigma * sqT);
  const vanna = -pdf * d2 / sigma;
  const charm = -pdf * (2 * RISK_FREE * T - d2 * sigma * sqT) / (2 * T * sigma * sqT);
  return { gamma, vanna, charm };
}

// ---------------------------------------------------------------- cboe parsing

// e.g. "SPXW250702C06200000" -> root SPXW, 2025-07-02, Call, 6200
const OCC_RE = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

function parseCboe(json, requestedSymbol) {
  const data = json && json.data;
  if (!data || !Array.isArray(data.options)) throw new Error('Unexpected CBOE payload shape');
  const spot = Number(data.current_price ?? data.close ?? data.last ?? NaN);
  if (!isFinite(spot) || spot <= 0) throw new Error('No spot price in CBOE payload');
  const now = Date.now();
  const options = [];
  for (const o of data.options) {
    const m = OCC_RE.exec(String(o.option || ''));
    if (!m) continue;
    const oi = Number(o.open_interest ?? o.oi ?? 0);
    if (!(oi > 0)) continue;
    // expiries settle end of day; approximate 4pm ET as 20:00 UTC
    const expiry = Date.UTC(2000 + +m[2], +m[3] - 1, +m[4], 20, 0, 0);
    if (expiry < now - 12 * 3600e3) continue;
    options.push({
      type: m[5],
      strike: +m[6] / 1000,
      expiry,
      dte: Math.max(0, Math.ceil((expiry - now) / 86400e3)),
      T: Math.max((expiry - now) / MS_YEAR, 1 / (365 * 96)), // floor ~15 min
      oi,
      volume: Number(o.volume ?? 0),
      iv: Number(o.iv ?? 0),
      gammaQuoted: Number(o.gamma ?? NaN),
    });
  }
  if (!options.length) throw new Error('Chain parsed but contained no open interest');
  return {
    symbol: String(data.symbol || requestedSymbol).replace(/^_/, '').replace(/^\^/, ''),
    spot,
    timestamp: json.timestamp || new Date().toISOString(),
    source: json._source || 'CBOE delayed quotes',
    options,
  };
}

// ---------------------------------------------------------------- exposure math

function optionGreeks(o, S) {
  if (o.iv > 0.005) return bsGreeks(S, o.strike, o.T, o.iv);
  // no usable IV: fall back to the quoted gamma, skip vanna/charm
  const g = isFinite(o.gammaQuoted) ? o.gammaQuoted : 0;
  return { gamma: g, vanna: 0, charm: 0 };
}

function dealerSign(type) { return type === 'C' ? 1 : -1; } // long calls, short puts

function computeMetrics(ch, maxDte) {
  const S = ch.spot;
  const opts = ch.options.filter((o) => maxDte === 'all' || o.dte <= +maxDte);

  const byStrike = new Map();
  let netGex = 0, netVanna = 0, netCharm = 0;

  for (const o of opts) {
    const { gamma, vanna, charm } = optionGreeks(o, S);
    const sign = dealerSign(o.type);
    const gex = sign * gamma * o.oi * CONTRACT_SIZE * S * S * 0.01;   // $ per 1% spot move
    const vex = sign * vanna * o.oi * CONTRACT_SIZE * S * 0.01;       // $ delta per +1 vol pt
    const cex = sign * (charm / 365) * o.oi * CONTRACT_SIZE * S;      // $ delta per day

    let row = byStrike.get(o.strike);
    if (!row) {
      row = { strike: o.strike, callGex: 0, putGex: 0, gex: 0, vanna: 0, charm: 0, callOi: 0, putOi: 0 };
      byStrike.set(o.strike, row);
    }
    row.gex += gex;
    row.vanna += vex;
    row.charm += cex;
    if (o.type === 'C') { row.callGex += gex; row.callOi += o.oi; }
    else { row.putGex += gex; row.putOi += o.oi; }
    netGex += gex; netVanna += vex; netCharm += cex;
  }

  const strikes = [...byStrike.values()].sort((a, b) => a.strike - b.strike);

  let callWall = null, putWall = null;
  for (const r of strikes) {
    if (!callWall || r.callGex > callWall.callGex) callWall = r;
    if (!putWall || r.putGex < putWall.putGex) putWall = r;
  }

  // gamma profile: total net GEX recomputed at hypothetical spot levels
  const profile = [];
  const lo = S * (1 - PROFILE_RANGE), hi = S * (1 + PROFILE_RANGE);
  for (let i = 0; i < PROFILE_POINTS; i++) {
    const s = lo + (hi - lo) * (i / (PROFILE_POINTS - 1));
    let total = 0;
    for (const o of opts) {
      const g = o.iv > 0.005
        ? bsGreeks(s, o.strike, o.T, o.iv).gamma
        : (isFinite(o.gammaQuoted) ? o.gammaQuoted : 0);
      total += dealerSign(o.type) * g * o.oi * CONTRACT_SIZE * s * s * 0.01;
    }
    profile.push({ s, gex: total });
  }

  // zero-gamma flip: sign change in the profile closest to spot
  let flip = null, bestDist = Infinity;
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1], b = profile[i];
    if ((a.gex <= 0 && b.gex > 0) || (a.gex >= 0 && b.gex < 0)) {
      const x = a.s + (b.s - a.s) * (0 - a.gex) / (b.gex - a.gex);
      const d = Math.abs(x - S);
      if (d < bestDist) { bestDist = d; flip = x; }
    }
  }

  return { spot: S, strikes, netGex, netVanna, netCharm, callWall, putWall, profile, flip, optionCount: opts.length };
}

// ladder rows: nearest N strikes to spot with any OI, sorted high strike first
function ladderRows(m) {
  return [...m.strikes]
    .sort((a, b) => Math.abs(a.strike - m.spot) - Math.abs(b.strike - m.spot))
    .slice(0, LADDER_STRIKES)
    .sort((a, b) => b.strike - a.strike);
}

// ---------------------------------------------------------------- tooltip

const tip = $('#tip');

function showTip(clientX, clientY, headText, rows) {
  tip.replaceChildren();
  tip.append(el('div', { className: 't-head', text: headText }));
  for (const r of rows) {
    const label = el('span', {});
    if (r.color) label.append(el('span', { className: 't-key', style: `background:${r.color}` }));
    label.append(document.createTextNode(r.label));
    tip.append(el('div', { className: 't-row' }, [label, el('b', { text: r.value })]));
  }
  tip.style.display = 'block';
  const rect = tip.getBoundingClientRect();
  let x = clientX + 14, y = clientY + 14;
  if (x + rect.width > window.innerWidth - 8) x = clientX - rect.width - 14;
  if (y + rect.height > window.innerHeight - 8) y = clientY - rect.height - 14;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function hideTip() { tip.style.display = 'none'; }

// ---------------------------------------------------------------- ladder chart (shared)

/* Horizontal diverging bars, one row per strike.
 * rows: [{strike, ...}], valueKey: which field to plot,
 * annotate: true adds spot / flip / wall annotations (main GEX ladder). */
function renderLadder(container, m, valueKey, { annotate = false, tooltipRows }) {
  const rows = ladderRows(m);
  container.replaceChildren();
  if (!rows.length) { container.append(el('p', { className: 'desc', text: 'No data for this filter.' })); return; }

  const W = annotate ? 640 : 460;
  const rowH = annotate ? 13 : 9.5;
  const barH = rowH - 2;                       // 2px surface gap between adjacent bars
  const mL = 52, mR = annotate ? 112 : 16, mT = 6, mB = 26;
  const H = rows.length * rowH + mT + mB;
  const plotW = W - mL - mR;
  const cx = mL + plotW / 2;

  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r[valueKey])));
  const xScale = (v) => cx + (v / maxAbs) * (plotW / 2) * 0.96;
  const yOf = (i) => mT + i * rowH;
  // strike -> y (interpolated), for spot/flip lines; rows are descending in strike
  const yAtPrice = (p) => {
    const top = rows[0].strike, bot = rows[rows.length - 1].strike;
    const t = (top - p) / (top - bot || 1);
    return mT + Math.max(0, Math.min(1, t)) * (rows.length * rowH - rowH) + barH / 2;
  };

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Exposure by strike' });

  // x gridlines + ticks (clean symmetric values)
  const tickVals = niceSymmetricTicks(maxAbs);
  for (const tv of tickVals) {
    const x = xScale(tv);
    svg.append(svgEl('line', { x1: x, y1: mT, x2: x, y2: H - mB, stroke: 'var(--grid)', 'stroke-width': 1 }));
    svg.append(svgEl('text', { x, y: H - mB + 14, 'text-anchor': 'middle', class: 'tick', text: fmtDollars(tv) }));
  }
  // zero baseline slightly stronger
  svg.append(svgEl('line', { x1: cx, y1: mT, x2: cx, y2: H - mB, stroke: 'var(--axis)', 'stroke-width': 1 }));

  // strike tick labels (every k rows, <= ~16 labels)
  const k = Math.max(1, Math.ceil(rows.length / 16));
  rows.forEach((r, i) => {
    if (i % k === 0) {
      svg.append(svgEl('text', { x: mL - 6, y: yOf(i) + barH / 2 + 3.5, 'text-anchor': 'end', class: 'tick', text: fmtStrike(r.strike) }));
    }
  });

  // bars
  rows.forEach((r, i) => {
    const v = r[valueKey];
    const w = xScale(v) - cx;
    if (Math.abs(w) > 0.4) {
      const rad = Math.min(4, barH / 2, Math.abs(w));
      svg.append(svgEl('path', {
        d: divergingBarPath(cx, yOf(i), w, barH, rad),
        fill: v >= 0 ? 'var(--pos)' : 'var(--neg)',
        'data-row': i,
      }));
    }
  });

  // annotations: spot hairline always; on the main ladder a right-margin label
  // stack for spot / flip / walls with collision nudging + leader ticks
  const annos = [{ p: m.spot, label: `Spot ${fmtStrike(m.spot)}`, line: true, strong: true }];
  if (annotate) {
    if (m.flip) annos.push({ p: m.flip, label: `Flip ${fmtStrike(m.flip)}`, line: true });
    const sameStrike = m.callWall && m.putWall && m.callWall.strike === m.putWall.strike;
    if (sameStrike) annos.push({ p: m.callWall.strike, label: `C+P wall ${fmtStrike(m.callWall.strike)}` });
    else {
      if (m.callWall) annos.push({ p: m.callWall.strike, label: `Call wall ${fmtStrike(m.callWall.strike)}` });
      if (m.putWall) annos.push({ p: m.putWall.strike, label: `Put wall ${fmtStrike(m.putWall.strike)}` });
    }
  }
  for (const a of annos) { a.yLine = yAtPrice(a.p); a.y = a.yLine; }
  annos.sort((a, b) => a.y - b.y);
  for (let i = 1; i < annos.length; i++) {
    if (annos[i].y - annos[i - 1].y < 13) annos[i].y = annos[i - 1].y + 13;
  }
  for (const a of annos) {
    if (a.line) {
      svg.append(svgEl('line', {
        x1: mL, y1: a.yLine, x2: W - mR + 2, y2: a.yLine,
        stroke: a.strong ? 'var(--text-secondary)' : 'var(--text-muted)', 'stroke-width': a.strong ? 1.5 : 1,
      }));
    }
    if (annotate) {
      // short leader from the row's true y to the (possibly nudged) label y
      svg.append(svgEl('polyline', {
        points: `${W - mR + 2},${a.yLine} ${W - mR + 6},${a.y} ${W - mR + 9},${a.y}`,
        fill: 'none', stroke: 'var(--text-muted)', 'stroke-width': 1,
      }));
      svg.append(svgEl('text', { x: W - mR + 11, y: a.y + 3.5, class: 'anno', text: a.label }));
    }
  }

  // full-row transparent hit targets with tooltip + hover lift
  rows.forEach((r, i) => {
    const hit = svgEl('rect', {
      x: 0, y: yOf(i) - 1, width: W, height: rowH, fill: 'transparent', tabindex: 0,
      'aria-label': `Strike ${fmtStrike(r.strike)}`,
    });
    const bar = () => svg.querySelector(`path[data-row="${i}"]`);
    const show = (cx2, cy2) => showTip(cx2, cy2, `Strike ${fmtStrike(r.strike)}`, tooltipRows(r));
    hit.addEventListener('pointermove', (e) => { show(e.clientX, e.clientY); bar()?.setAttribute('opacity', '0.75'); });
    hit.addEventListener('pointerleave', () => { hideTip(); bar()?.removeAttribute('opacity'); });
    hit.addEventListener('focus', () => { const b = svg.getBoundingClientRect(); show(b.left + W / 2, b.top + yOf(i)); bar()?.setAttribute('opacity', '0.75'); });
    hit.addEventListener('blur', () => { hideTip(); bar()?.removeAttribute('opacity'); });
    svg.append(hit);
  });

  container.append(svg);
}

function divergingBarPath(x0, y, w, h, r) {
  if (w >= 0) {
    return `M${x0},${y} L${x0 + w - r},${y} Q${x0 + w},${y} ${x0 + w},${y + r} L${x0 + w},${y + h - r} Q${x0 + w},${y + h} ${x0 + w - r},${y + h} L${x0},${y + h} Z`;
  }
  return `M${x0},${y} L${x0 + w + r},${y} Q${x0 + w},${y} ${x0 + w},${y + r} L${x0 + w},${y + h - r} Q${x0 + w},${y + h} ${x0 + w + r},${y + h} L${x0},${y + h} Z`;
}

function niceSymmetricTicks(maxAbs) {
  const step = niceNum(maxAbs / 2);
  const out = [];
  for (let v = -Math.floor(maxAbs / step) * step; v <= maxAbs; v += step) out.push(v);
  return out;
}

function niceNum(x) {
  const exp = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / exp;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * exp;
}

// ---------------------------------------------------------------- profile chart

function renderProfile(container, m) {
  container.replaceChildren();
  const pts = m.profile;
  if (!pts.length) return;

  const W = 460, H = 240, mL = 56, mR = 14, mT = 10, mB = 30;
  const xs = pts.map((p) => p.s), ys = pts.map((p) => p.gex);
  const xMin = xs[0], xMax = xs[xs.length - 1];
  let yMin = Math.min(0, ...ys), yMax = Math.max(0, ...ys);
  const pad = (yMax - yMin) * 0.08 || 1;
  yMin -= pad; yMax += pad;

  const X = (v) => mL + ((v - xMin) / (xMax - xMin)) * (W - mL - mR);
  const Y = (v) => mT + ((yMax - v) / (yMax - yMin)) * (H - mT - mB);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Net GEX versus spot level' });

  // y gridlines / ticks
  const yStep = niceNum((yMax - yMin) / 4);
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep) {
    svg.append(svgEl('line', { x1: mL, y1: Y(v), x2: W - mR, y2: Y(v), stroke: 'var(--grid)', 'stroke-width': 1 }));
    svg.append(svgEl('text', { x: mL - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'tick', text: fmtDollars(v) }));
  }
  // zero line stronger
  svg.append(svgEl('line', { x1: mL, y1: Y(0), x2: W - mR, y2: Y(0), stroke: 'var(--axis)', 'stroke-width': 1 }));
  // x ticks
  const xStep = niceNum((xMax - xMin) / 4);
  for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax; v += xStep) {
    svg.append(svgEl('text', { x: X(v), y: H - mB + 15, 'text-anchor': 'middle', class: 'tick', text: fmtStrike(v) }));
  }

  // spot vertical hairline
  svg.append(svgEl('line', { x1: X(m.spot), y1: mT, x2: X(m.spot), y2: H - mB, stroke: 'var(--text-muted)', 'stroke-width': 1 }));
  svg.append(svgEl('text', { x: X(m.spot) + 4, y: mT + 10, class: 'anno', text: 'Spot' }));

  // the line (single series -> slot 1, no legend box)
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.s).toFixed(1)},${Y(p.gex).toFixed(1)}`).join('');
  svg.append(svgEl('path', { d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  // flip marker: >=8px dot with 2px surface ring + direct label
  if (m.flip) {
    svg.append(svgEl('circle', { cx: X(m.flip), cy: Y(0), r: 6, fill: 'var(--accent)', stroke: 'var(--surface-1)', 'stroke-width': 2 }));
    const anchor = m.flip > (xMin + xMax) / 2 ? 'end' : 'start';
    svg.append(svgEl('text', {
      x: X(m.flip) + (anchor === 'start' ? 9 : -9), y: Y(0) - 8,
      'text-anchor': anchor, class: 'anno', text: `Flip ${fmtStrike(m.flip)}`,
    }));
  }

  // crosshair + tooltip
  const cross = svgEl('line', { y1: mT, y2: H - mB, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
  const dot = svgEl('circle', { r: 4.5, fill: 'var(--accent)', stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' });
  svg.append(cross, dot);
  const hit = svgEl('rect', { x: mL, y: mT, width: W - mL - mR, height: H - mT - mB, fill: 'transparent' });
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const sx = xMin + ((e.clientX - box.left) * (W / box.width) - mL) / (W - mL - mR) * (xMax - xMin);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.s - sx) < Math.abs(best.s - sx)) best = p;
    cross.setAttribute('x1', X(best.s)); cross.setAttribute('x2', X(best.s));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', X(best.s)); dot.setAttribute('cy', Y(best.gex));
    dot.setAttribute('visibility', 'visible');
    showTip(e.clientX, e.clientY, `Spot at ${fmtStrike(best.s)}`, [
      { label: 'Net GEX', value: fmtDollars(best.gex), color: 'var(--accent)' },
    ]);
  });
  hit.addEventListener('pointerleave', () => {
    hideTip(); cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden');
  });
  svg.append(hit);

  container.append(svg);
}

// ---------------------------------------------------------------- tiles & table

function renderTiles(m) {
  const tiles = $('#tiles');
  tiles.replaceChildren();
  const regime = m.netGex >= 0 ? 'Positive' : 'Negative';
  const regimeColor = m.netGex >= 0 ? 'var(--pos)' : 'var(--neg)';
  const defs = [
    { label: 'Spot', value: fmtStrike(m.spot), hint: 'delayed ~15 min' },
    { label: 'Net GEX', value: fmtDollars(m.netGex), hint: 'per 1% move' },
    { label: 'Zero gamma', value: m.flip ? fmtStrike(m.flip) : '—', hint: m.flip ? 'flip level' : 'no flip in ±10%' },
    { label: 'Call wall', value: m.callWall ? fmtStrike(m.callWall.strike) : '—', hint: 'max call gamma' },
    { label: 'Put wall', value: m.putWall ? fmtStrike(m.putWall.strike) : '—', hint: 'max put gamma' },
    { label: 'Gamma regime', value: regime, dot: regimeColor, hint: m.netGex >= 0 ? 'vol-suppressing' : 'vol-amplifying' },
  ];
  for (const d of defs) {
    const value = el('div', { className: 'value' });
    if (d.dot) value.append(el('span', { className: 'dot', style: `background:${d.dot}` }));
    value.append(document.createTextNode(d.value));
    tiles.append(el('div', { className: 'tile' }, [
      el('div', { className: 'label', text: d.label }),
      value,
      el('div', { className: 'hint', text: d.hint }),
    ]));
  }
}

function renderTable(m) {
  const wrap = $('#tablewrap');
  wrap.replaceChildren();
  const head = el('tr', {}, ['Strike', 'Call OI', 'Put OI', 'Call GEX', 'Put GEX', 'Net GEX', 'Vanna $/volpt', 'Charm $/day']
    .map((t) => el('th', { text: t })));
  const body = ladderRows(m).map((r) => el('tr', {}, [
    el('td', { text: fmtStrike(r.strike) }),
    el('td', { text: fmtInt(r.callOi) }),
    el('td', { text: fmtInt(r.putOi) }),
    el('td', { text: fmtDollars(r.callGex) }),
    el('td', { text: fmtDollars(r.putGex) }),
    el('td', { text: fmtDollars(r.gex) }),
    el('td', { text: fmtDollars(r.vanna) }),
    el('td', { text: fmtDollars(r.charm) }),
  ]));
  wrap.append(el('table', {}, [el('thead', {}, [head]), el('tbody', {}, body)]));
}

// ---------------------------------------------------------------- render all

function renderAll() {
  if (!chain) return;
  metrics = computeMetrics(chain, expFilter);
  const ts = new Date(chain.timestamp);
  $('#stamp').textContent =
    `${chain.symbol} · ${metrics.optionCount.toLocaleString()} options with OI in filter · ` +
    `${chain.source} · as of ${isNaN(ts) ? chain.timestamp : ts.toLocaleString()}`;

  renderTiles(metrics);
  renderLadder($('#ladder'), metrics, 'gex', {
    annotate: true,
    tooltipRows: (r) => [
      { label: 'Net GEX', value: fmtDollars(r.gex) },
      { label: 'Call GEX', value: fmtDollars(r.callGex), color: 'var(--pos)' },
      { label: 'Put GEX', value: fmtDollars(r.putGex), color: 'var(--neg)' },
      { label: 'Call OI', value: fmtInt(r.callOi) },
      { label: 'Put OI', value: fmtInt(r.putOi) },
    ],
  });
  renderProfile($('#profile'), metrics);
  renderLadder($('#vanna'), metrics, 'vanna', {
    tooltipRows: (r) => [{ label: 'Vanna exposure', value: `${fmtDollars(r.vanna)} / vol pt` }],
  });
  renderLadder($('#charm'), metrics, 'charm', {
    tooltipRows: (r) => [{ label: 'Charm exposure', value: `${fmtDollars(r.charm)} / day` }],
  });
  renderTable(metrics);
}

// ---------------------------------------------------------------- data loading

function banner(msg) {
  const b = $('#banner');
  if (!msg) { b.className = ''; b.replaceChildren(); return; }
  b.className = 'show';
  b.replaceChildren();
  b.append(document.createTextNode(msg));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    // the proxy puts the real reason in the body — surface it
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* not json */ }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json();
}

async function loadSymbol(symRaw) {
  const sym = symRaw.trim().toUpperCase().replace(/[^A-Z^_.]/g, '');
  if (!sym) return;
  banner('');
  document.querySelector('.grid').classList.add('loading');
  $('#stamp').textContent = `Loading ${sym}…`;
  try {
    let json = null;
    const errors = [];
    // 1) local proxy (when served by server.js) — avoids CORS entirely
    try { json = await fetchJson(`api/chain?symbol=${encodeURIComponent(sym)}`); }
    catch (e) { errors.push(`proxy: ${e.message}`); }
    // 2) direct CBOE (works when opened where CORS permits)
    if (!json) {
      for (const s of [sym, `_${sym}`]) {
        try { json = await fetchJson(`https://cdn.cboe.com/api/global/delayed_quotes/options/${s}.json`); break; }
        catch (e) { errors.push(`cboe ${s}: ${e.message}`); }
      }
    }
    if (!json) throw new Error(errors.join(' · '));
    chain = parseCboe(json, sym);
    renderAll();
  } catch (err) {
    banner(`Could not load ${sym}: ${err.message}. ` +
      'Run "node gex/server.js" and open http://localhost:8787 so the built-in proxy can reach CBOE, ' +
      'check the ticker (indexes like SPX/NDX/RUT/VIX are supported), or click "Demo data".');
    $('#stamp').textContent = chain ? $('#stamp').textContent : 'No data loaded yet.';
  } finally {
    document.querySelector('.grid').classList.remove('loading');
  }
}

// ---------------------------------------------------------------- demo data

// deterministic PRNG so the demo is stable
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function demoChain() {
  const rnd = mulberry32(20260702);
  const spot = 6187.5;
  const now = Date.now();
  const options = [];
  const dtes = [0, 1, 2, 4, 7, 14, 30, 45];
  const step = 25;
  const lo = Math.round((spot * 0.88) / step) * step;
  const hi = Math.round((spot * 1.12) / step) * step;
  for (const dte of dtes) {
    const expiry = now + Math.max(dte * 86400e3, 4 * 3600e3);
    for (let K = lo; K <= hi; K += step) {
      const money = (K - spot) / spot;
      const round = K % 100 === 0 ? 2.4 : K % 50 === 0 ? 1.3 : 1;
      const term = Math.exp(-dte / 22);
      // calls pile up above spot, puts below; both fade with distance
      const callOi = Math.round(9000 * round * term * Math.exp(-Math.pow((money - 0.018) / 0.028, 2)) * (0.5 + rnd()));
      const putOi = Math.round(11500 * round * term * Math.exp(-Math.pow((money + 0.03) / 0.038, 2)) * (0.5 + rnd()));
      const iv = Math.max(0.07, 0.135 - 0.55 * money + 0.9 * money * money + 0.01 * Math.sqrt(dte + 0.3));
      const T = Math.max((expiry - now) / MS_YEAR, 1 / (365 * 96));
      const base = { strike: K, expiry, dte, T, iv, volume: 0, gammaQuoted: NaN };
      if (callOi > 0) options.push({ ...base, type: 'C', oi: callOi });
      if (putOi > 0) options.push({ ...base, type: 'P', oi: putOi });
    }
  }
  return { symbol: 'SPX (demo)', spot, timestamp: new Date(now).toISOString(), source: 'synthetic demo chain', options };
}

// ---------------------------------------------------------------- wiring

$('#load').addEventListener('click', () => loadSymbol($('#symbol').value));
$('#symbol').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadSymbol($('#symbol').value); });
$('#presets').addEventListener('click', (e) => {
  const sym = e.target.closest('[data-sym]')?.dataset.sym;
  if (sym) { $('#symbol').value = sym; loadSymbol(sym); }
});
$('#expchips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-exp]');
  if (!chip) return;
  expFilter = chip.dataset.exp;
  for (const c of document.querySelectorAll('#expchips .chip')) {
    c.setAttribute('aria-pressed', String(c === chip));
  }
  renderAll();
});
$('#demo').addEventListener('click', () => { banner(''); chain = demoChain(); renderAll(); });
$('#tabletoggle').addEventListener('click', () => {
  const wrap = $('#tablewrap');
  const show = wrap.hidden;
  wrap.hidden = !show;
  const btn = $('#tabletoggle');
  btn.textContent = show ? 'Hide table' : 'Show table';
  btn.setAttribute('aria-expanded', String(show));
});

const params = new URLSearchParams(location.search);
if (params.get('demo')) {
  chain = demoChain();
  renderAll();
} else {
  loadSymbol(params.get('symbol') || $('#symbol').value);
}
