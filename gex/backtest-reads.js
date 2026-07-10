'use strict';

/* gex/backtest-reads.js — grade saved AI reads against the market-state archive.
 *
 * Every /api/analyze read is archived with its input snapshot
 * (gex/data/reads/{SYM}/{day}/{stamp}Z-read.json), and the server archives the
 * computed market state ~1/min per swept symbol (gex/data/brain/...). This
 * script pairs them: for each saved read it replays what spot actually did
 * afterwards and grades the read's regime call, its wall levels, and each
 * trade structure's direction — then aggregates hit rates by confidence,
 * direction, regime, and rubric version. The confidence table is the
 * calibration check: HIGH-confidence structures should hit more often than
 * LOW ones, or the rubric's calibration anchors are miscalibrated.
 *
 * Honest scope — this is a DIRECTION/REGIME scorer, not a P&L backtest:
 *   - structures are graded on their stated direction over fixed horizons
 *     (+1h, +3h, EOD, +1d, +3d of RTH data), not on option prices — the
 *     archive has no option quotes to reprice legs;
 *   - neutral / long_vol / short_vol grades are heuristics against the
 *     snapshot's own expected move (iv30/16 %/day, scaled by sqrt(time)):
 *     neutral & short_vol hit when |move| <= 0.5x expected, long_vol when
 *     |move| >= 1x expected;
 *   - reads generated outside RTH have no same-day forward data and grade
 *     from the next trading day in the archive;
 *   - the archive only exists while the app was running — gaps are gaps.
 *
 * Run:  node gex/backtest-reads.js [SYM ...] [--json]
 * (No server needed — reads straight from gex/data/.)
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
function shimLoad(file) {
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  const shim = { exports: {} };
  new Function('module', 'exports', src)(shim, shim.exports);
  return shim.exports;
}
const E = shimLoad('exposure.js'); // for DST-aware nyCloseUtc

const READS_DIR = path.resolve(process.env.GEX_READS_DIR || path.join(dir, 'data', 'reads'));
const ARCHIVE_DIR = path.resolve(process.env.GEX_ARCHIVE_DIR || path.join(dir, 'data', 'brain'));
const RTH_HOURS = 6.5;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SNAP_RE = /^\d{6}Z-[a-z]{1,12}\.json(\.gz)?$/;
const READ_RE = /^\d{6,9}Z-read\.json$/; // 6-digit legacy stamps and 9-digit ms stamps

// ---------------------------------------------------------------- pure grading core (exported for tests)

/* Weekdays strictly after `fromDay` up to and including `toDay` (YYYY-MM-DD) —
 * the trading-day distance between two archive days. Calendar-only: market
 * holidays still count as a day, an acceptable overestimate for grading. */
export function weekdaysBetween(fromDay, toDay) {
  if (!fromDay || !toDay || toDay <= fromDay) return 0;
  let n = 0;
  const d = new Date(`${fromDay}T00:00:00Z`);
  const end = Date.parse(`${toDay}T00:00:00Z`);
  for (;;) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getTime() > end) break;
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

/* Expected |move| in percent over `tradingHours` of RTH, from annualized iv30:
 * one trading day's expected move is ~ iv30/16 percent (sqrt(252) ~ 15.9). */
export function expectedMovePct(iv30, tradingHours) {
  if (iv30 == null || !isFinite(iv30) || iv30 <= 0 || !isFinite(tradingHours) || tradingHours <= 0) return null;
  return (iv30 / 16) * Math.sqrt(tradingHours / RTH_HOURS);
}

/* Grade one structure direction against a realized percent move.
 * Returns { hit: true|false|null, ratio } — null = ungradeable (flat tape for
 * a directional call, or no expected move for the vol-style grades). */
export function gradeDirection(direction, movePct, expPct) {
  if (movePct == null || !isFinite(movePct)) return { hit: null, ratio: null };
  const ratio = expPct ? movePct / expPct : null;
  switch (direction) {
    case 'bullish': return { hit: movePct === 0 ? null : movePct > 0, ratio };
    case 'bearish': return { hit: movePct === 0 ? null : movePct < 0, ratio };
    case 'neutral':
    case 'short_vol':
      return expPct == null ? { hit: null, ratio } : { hit: Math.abs(movePct) <= 0.5 * expPct, ratio };
    case 'long_vol':
      return expPct == null ? { hit: null, ratio } : { hit: Math.abs(movePct) >= 1.0 * expPct, ratio };
    default: return { hit: null, ratio };
  }
}

/* Grade the regime label against what the tape did up to the primary horizon.
 * maxAbsMovePct = the largest |move| from the read's spot seen at ANY point
 * (regimes are about the path, not just the endpoint). */
export function gradeRegime(label, { maxAbsMovePct, expPct, breachedCall, breachedPut }) {
  if (maxAbsMovePct == null || expPct == null) return null;
  switch (label) {
    case 'pinned_range': return maxAbsMovePct <= 1.0 * expPct && !breachedCall && !breachedPut;
    case 'drift_grind': return maxAbsMovePct <= 1.5 * expPct; // dampened tape, drift allowed
    case 'squeeze_risk':
    case 'stress_expansion': return maxAbsMovePct >= 1.0 * expPct || !!breachedCall || !!breachedPut;
    default: return null; // 'transition' makes no testable claim
  }
}

/* Wall levels from the read's own key_levels: only walls within inPlayPct of
 * the read-time spot make a testable claim ("in play"); a wall 6% away is
 * trivially unbreached. Returns per-level {kind, level, inPlay, breached,
 * closestApproachPct} where closestApproachPct is how near spot got, signed
 * distance remaining (0 = touched). */
export function gradeLevels(keyLevels, spots, spot0, { inPlayPct = 3 } = {}) {
  const out = [];
  for (const l of keyLevels || []) {
    if (l.kind !== 'call_wall' && l.kind !== 'put_wall') continue;
    if (!isFinite(l.level) || !isFinite(spot0) || spot0 <= 0) continue;
    const inPlay = Math.abs(l.level - spot0) / spot0 * 100 <= inPlayPct;
    let breached = false, closest = Infinity;
    for (const s of spots) {
      if (l.kind === 'call_wall') { if (s > l.level) breached = true; closest = Math.min(closest, (l.level - s) / spot0 * 100); }
      else { if (s < l.level) breached = true; closest = Math.min(closest, (s - l.level) / spot0 * 100); }
    }
    out.push({
      kind: l.kind, level: l.level, inPlay, breached,
      closestApproachPct: spots.length ? +Math.max(0, closest).toFixed(3) : null,
    });
  }
  return out;
}

/* Grade one saved read record against an RTH spot series [{t(ms), spot}...].
 * Horizons: +1h, +3h, EOD (last same-UTC-day point), +1d / +3d (last point of
 * the 1st / 3rd later day with data). The PRIMARY horizon for the hit tables
 * is EOD when >=1h of same-day data exists, else +1d. */
export function gradeReadAgainstSeries(record, series) {
  const t0 = Date.parse(record.asof);
  const spot0 = record?.snapshot?.spot;
  if (!isFinite(t0) || !isFinite(spot0) || spot0 <= 0) return { ok: false, reason: 'unreadable record (asof/spot)' };
  const iv30 = record?.snapshot?.vol?.iv30_vix_style ?? null;
  const after = series.filter((p) => p.t > t0 && isFinite(p.spot) && p.spot > 0);
  if (!after.length) return { ok: false, reason: 'no market data after the read' };

  const day0 = record.asof.slice(0, 10);
  const dayOf = (p) => new Date(p.t).toISOString().slice(0, 10);
  const laterDays = [...new Set(after.map(dayOf))].sort();
  const movePct = (p) => (p.spot - spot0) / spot0 * 100;
  const lastAtOrBefore = (cutoff) => { let best = null; for (const p of after) if (p.t <= cutoff) best = p; return best; };
  const lastOfDay = (d) => { let best = null; for (const p of after) if (dayOf(p) === d) best = p; return best; };

  const horizons = {};
  const h1 = lastAtOrBefore(t0 + 3600e3), h3 = lastAtOrBefore(t0 + 3 * 3600e3);
  const eod = laterDays.includes(day0) ? lastOfDay(day0) : null;
  const nextDays = laterDays.filter((d) => d > day0);
  const d1 = nextDays[0] ? lastOfDay(nextDays[0]) : null;
  // d3 is the THIRD later archived day or nothing — falling back to a nearer
  // day would report a +1d move under the '+3d' label (review finding)
  const d3 = nextDays[2] ? lastOfDay(nextDays[2]) : null;
  const hoursSameDay = eod ? Math.max(0.5, (eod.t - t0) / 3600e3) : 0; // wall-clock ~ RTH here since the series is RTH-filtered
  // the expected move must span the time that actually ELAPSED, not "one
  // archived day = one trading day": archive gaps (app off, holidays) put
  // nextDays[0] several trading days out, and grading a 5-day move against a
  // 1-day expected move fails ordinary drift as an "expansion" (review finding).
  // Weekday count is a calendar-only approximation (holidays still count) —
  // close enough for a 0.5x/1x/1.5x grading scale.
  const tradingHoursTo = (p) => (eod ? Math.min(RTH_HOURS, hoursSameDay) : 0) + weekdaysBetween(day0, dayOf(p)) * RTH_HOURS;
  if (h1) horizons.h1 = { movePct: movePct(h1), hours: 1 };
  if (h3) horizons.h3 = { movePct: movePct(h3), hours: 3 };
  if (eod) horizons.eod = { movePct: movePct(eod), hours: Math.min(RTH_HOURS, hoursSameDay) };
  if (d1) horizons.d1 = { movePct: movePct(d1), hours: tradingHoursTo(d1) };
  if (d3) horizons.d3 = { movePct: movePct(d3), hours: tradingHoursTo(d3) };

  const primaryKey = eod && hoursSameDay >= 1 ? 'eod' : (d1 ? 'd1' : (eod ? 'eod' : Object.keys(horizons).pop()));
  if (!primaryKey || !horizons[primaryKey]) return { ok: false, reason: 'no gradeable horizon' };
  const primary = horizons[primaryKey];
  const expPct = expectedMovePct(iv30, primary.hours);

  // path stats up to the primary cutoff
  const cutoffT = { h1: t0 + 3600e3, h3: t0 + 3 * 3600e3, eod: eod?.t, d1: d1?.t, d3: d3?.t }[primaryKey];
  const pathPts = after.filter((p) => p.t <= cutoffT);
  const spots = pathPts.map((p) => p.spot);
  const maxAbsMovePct = spots.length ? Math.max(...spots.map((s) => Math.abs(s - spot0) / spot0 * 100)) : null;

  const levels = gradeLevels(record.read?.key_levels, spots, spot0);
  const breachedCall = levels.some((l) => l.kind === 'call_wall' && l.inPlay && l.breached);
  const breachedPut = levels.some((l) => l.kind === 'put_wall' && l.inPlay && l.breached);
  const regimeHit = gradeRegime(record.read?.regime?.label, { maxAbsMovePct, expPct, breachedCall, breachedPut });

  const structures = (record.read?.trade_structures || []).map((t) => ({
    name: t.name, direction: t.direction, confidence: t.confidence,
    est_max_risk_usd: t.est_max_risk_usd ?? null,
    ...gradeDirection(t.direction, primary.movePct, expPct),
  }));

  return {
    ok: true,
    symbol: record.snapshot.symbol, asof: record.asof, rubric_version: record.rubric_version ?? null,
    regime: record.read?.regime?.label ?? null, regimeHit,
    spot0, iv30, primary: primaryKey, primaryMovePct: +primary.movePct.toFixed(3),
    expPct: expPct == null ? null : +expPct.toFixed(3),
    maxAbsMovePct: maxAbsMovePct == null ? null : +maxAbsMovePct.toFixed(3),
    horizons: Object.fromEntries(Object.entries(horizons).map(([k, v]) => [k, +v.movePct.toFixed(3)])),
    levels, structures,
    dataPoints: pathPts.length,
  };
}

/* Aggregate graded reads into the calibration tables. */
export function summarize(grades) {
  const bucket = () => ({ n: 0, hits: 0 });
  const by = { confidence: {}, direction: {}, regime: {}, rubric: {} };
  const tally = (map, key, hit) => {
    if (hit === null || hit === undefined || key == null) return;
    const b = (map[key] = map[key] || bucket());
    b.n++; if (hit) b.hits++;
  };
  for (const g of grades) {
    if (!g.ok) continue;
    tally(by.regime, g.regime, g.regimeHit);
    tally(by.rubric, `v${g.rubric_version}`, g.regimeHit);
    for (const s of g.structures) {
      tally(by.confidence, s.confidence, s.hit);
      tally(by.direction, s.direction, s.hit);
    }
  }
  for (const map of Object.values(by)) {
    for (const b of Object.values(map)) b.rate = b.n ? +(b.hits / b.n).toFixed(2) : null;
  }
  return by;
}

// ---------------------------------------------------------------- archive IO

function readMaybeGz(p) {
  if (p.endsWith('.gz')) return zlib.gunzipSync(fs.readFileSync(p)).toString('utf8');
  return fs.readFileSync(p, 'utf8');
}
const listDays = (root) => { try { return fs.readdirSync(root).filter((d) => DAY_RE.test(d)).sort(); } catch { return []; } };

/* Load the RTH-filtered spot series for a symbol from `fromDay` through
 * `untilDay` (inclusive; defaults to everything — the window must cover the
 * LAST read plus its horizons, not just the first: a capped window silently
 * starved every later read, per the review). One point per archived snapshot,
 * deduped on the base filename so a compacted day isn't double-counted. */
export function loadSeries(sym, fromDay, { archiveDir = ARCHIVE_DIR, untilDay = '9999-12-31', maxDays = 400 } = {}) {
  const symDir = path.join(archiveDir, sym);
  const days = listDays(symDir).filter((d) => d >= fromDay && d <= untilDay).slice(0, maxDays);
  const pts = [];
  for (const day of days) {
    const [y, m, dd] = day.split('-').map(Number);
    const close = E.nyCloseUtc(y, m, dd);
    const open = close - RTH_HOURS * 3600e3;
    let files = [];
    try { files = fs.readdirSync(path.join(symDir, day)).filter((f) => SNAP_RE.test(f)); } catch { continue; }
    const seen = new Set();
    for (const f of files.sort()) {
      const base = f.replace(/\.gz$/, '');
      if (seen.has(base)) continue;
      seen.add(base);
      try {
        const snap = JSON.parse(readMaybeGz(path.join(symDir, day, f)));
        const t = Date.parse(snap.computedAt || `${day}T${base.slice(0, 2)}:${base.slice(2, 4)}:${base.slice(4, 6)}Z`);
        if (!isFinite(t) || t < open || t > close + 60e3) continue; // RTH only: after-hours spot is frozen and would fake 'pinned'
        if (isFinite(snap.spot) && snap.spot > 0) pts.push({ t, spot: snap.spot });
      } catch { /* unreadable snapshot -> gap */ }
    }
  }
  return pts.sort((a, b) => a.t - b.t);
}

export function loadReads(sym, { readsDir = READS_DIR } = {}) {
  const symDir = path.join(readsDir, sym);
  const out = [];
  for (const day of listDays(symDir)) {
    let files = [];
    try { files = fs.readdirSync(path.join(symDir, day)).filter((f) => READ_RE.test(f)).sort(); } catch { continue; }
    for (const f of files) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(symDir, day, f), 'utf8'))); }
      catch { /* skip unreadable */ }
    }
  }
  return out;
}

// ---------------------------------------------------------------- CLI

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const wanted = args.filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase());
  let all = [];
  try { all = fs.readdirSync(READS_DIR).sort(); } catch { /* no reads archived yet */ }
  const symbols = (wanted.length ? wanted : all)
    .filter((s) => { try { return fs.statSync(path.join(READS_DIR, s)).isDirectory(); } catch { return false; } });
  if (!symbols.length) { console.error('No saved reads found under', READS_DIR); process.exitCode = 1; return; }

  const grades = [];
  for (const sym of symbols) {
    const reads = loadReads(sym);
    if (!reads.length) continue;
    const readDays = reads.map((r) => String(r.asof).slice(0, 10)).sort();
    // span every read plus a horizon tail — the last read needs +3d of data too
    const tail = new Date(`${readDays[readDays.length - 1]}T00:00:00Z`);
    tail.setUTCDate(tail.getUTCDate() + 10);
    const series = loadSeries(sym, readDays[0], { untilDay: tail.toISOString().slice(0, 10) });
    for (const rec of reads) grades.push({ ...gradeReadAgainstSeries(rec, series), _sym: sym, _asof: rec.asof, _v: rec.rubric_version });
  }

  if (asJson) { console.log(JSON.stringify({ grades, summary: summarize(grades) }, null, 2)); return; }

  const graded = grades.filter((g) => g.ok);
  const skipped = grades.filter((g) => !g.ok);
  console.log(`\nAI-read backtest — ${graded.length} graded, ${skipped.length} ungradeable (no forward market data yet)\n`);
  for (const g of graded) {
    const exp = g.expPct != null ? ` vs ±${g.expPct}% expected` : '';
    console.log(`${g.symbol}  ${g.asof}  v${g.rubric_version}  ${g.regime}${g.regimeHit === null ? '' : g.regimeHit ? '  regime✓' : '  regime✗'}`);
    console.log(`  ${g.primary}: ${g.primaryMovePct > 0 ? '+' : ''}${g.primaryMovePct}%${exp} · path max |move| ${g.maxAbsMovePct}% · ${g.dataPoints} pts`);
    for (const s of g.structures) {
      const mark = s.hit === null ? '·' : s.hit ? '✓' : '✗';
      console.log(`    ${mark} [${s.confidence}] ${s.direction}  ${s.name}`);
    }
    for (const l of g.levels.filter((x) => x.inPlay)) {
      console.log(`    wall ${l.kind} ${l.level}: ${l.breached ? 'BREACHED' : `held (closest ${l.closestApproachPct}%)`}`);
    }
  }
  for (const g of skipped) console.log(`—  ${g._sym}  ${g._asof}  v${g._v}: ${g.reason}`);

  const s = summarize(grades);
  const table = (title, map) => {
    const keys = Object.keys(map);
    if (!keys.length) return;
    console.log(`\n${title}`);
    for (const k of keys) console.log(`  ${k.padEnd(18)} ${String(map[k].hits).padStart(2)}/${String(map[k].n).padEnd(3)} ${map[k].rate == null ? '' : (map[k].rate * 100).toFixed(0) + '%'}`);
  };
  table('Structure hit rate by CONFIDENCE (the calibration check)', s.confidence);
  table('Structure hit rate by direction', s.direction);
  table('Regime hit rate by label', s.regime);
  table('Regime hit rate by rubric version', s.rubric);
  console.log(`\nCaveats: direction/regime grading only (no option-price P&L); neutral/vol grades are
heuristics vs the snapshot's own expected move; small samples prove nothing — this
table becomes meaningful over weeks of saved reads. Reads outside RTH grade from the
next archived trading day.`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
