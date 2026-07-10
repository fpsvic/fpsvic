'use strict';

/* Unit tests for the pure grading core of gex/backtest-reads.js:
 *   node gex/backtest.test.js
 * (importing the script must not run its CLI — the isMain guard is under test too) */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  expectedMovePct, gradeDirection, gradeRegime, gradeLevels,
  gradeReadAgainstSeries, summarize, weekdaysBetween, loadSeries,
} from './backtest-reads.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}
const approx = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? 'value'}: ${a} !~ ${b}`);

// ---------------------------------------------------------------- expected move

test('expectedMovePct: iv/16 per full day, sqrt-scaled intraday, null-safe', () => {
  approx(expectedMovePct(16, 6.5), 1.0, 1e-9, 'iv 16 -> 1%/day');
  approx(expectedMovePct(16, 6.5 * 4), 2.0, 1e-9, 'four days -> 2x');
  approx(expectedMovePct(32, 6.5), 2.0, 1e-9, 'iv scales linearly');
  assert.equal(expectedMovePct(null, 6.5), null);
  assert.equal(expectedMovePct(16, 0), null);
  assert.equal(expectedMovePct(-5, 6.5), null);
});

// ---------------------------------------------------------------- direction grades

test('gradeDirection: bullish/bearish by sign, flat tape is ungradeable', () => {
  assert.equal(gradeDirection('bullish', 0.4, 1).hit, true);
  assert.equal(gradeDirection('bullish', -0.4, 1).hit, false);
  assert.equal(gradeDirection('bearish', -0.4, 1).hit, true);
  assert.equal(gradeDirection('bearish', 0.4, 1).hit, false);
  assert.equal(gradeDirection('bullish', 0, 1).hit, null, 'exactly flat grades neither way');
  // direction-only grading survives a missing expected move
  assert.equal(gradeDirection('bullish', 0.2, null).hit, true);
});

test('gradeDirection: neutral/short_vol inside half the expected move, long_vol beyond it', () => {
  assert.equal(gradeDirection('neutral', 0.4, 1).hit, true);
  assert.equal(gradeDirection('neutral', 0.6, 1).hit, false);
  assert.equal(gradeDirection('short_vol', -0.5, 1).hit, true);
  assert.equal(gradeDirection('long_vol', 1.2, 1).hit, true);
  assert.equal(gradeDirection('long_vol', 0.8, 1).hit, false);
  // vol-style grades need an expected move
  assert.equal(gradeDirection('neutral', 0.4, null).hit, null);
  assert.equal(gradeDirection('long_vol', 2, null).hit, null);
});

// ---------------------------------------------------------------- regime grades

test('gradeRegime: pinned needs a quiet path AND intact walls; expansion needs range or a breach', () => {
  assert.equal(gradeRegime('pinned_range', { maxAbsMovePct: 0.5, expPct: 1, breachedCall: false, breachedPut: false }), true);
  assert.equal(gradeRegime('pinned_range', { maxAbsMovePct: 0.5, expPct: 1, breachedCall: true, breachedPut: false }), false, 'a breached wall kills a pin call even on a quiet tape');
  assert.equal(gradeRegime('pinned_range', { maxAbsMovePct: 1.5, expPct: 1, breachedCall: false, breachedPut: false }), false);
  assert.equal(gradeRegime('drift_grind', { maxAbsMovePct: 1.2, expPct: 1, breachedCall: false, breachedPut: false }), true, 'drift tolerates 1.5x');
  assert.equal(gradeRegime('squeeze_risk', { maxAbsMovePct: 1.2, expPct: 1, breachedCall: false, breachedPut: false }), true);
  assert.equal(gradeRegime('stress_expansion', { maxAbsMovePct: 0.3, expPct: 1, breachedCall: true, breachedPut: false }), true, 'a breach counts as expansion');
  assert.equal(gradeRegime('stress_expansion', { maxAbsMovePct: 0.3, expPct: 1, breachedCall: false, breachedPut: false }), false);
  assert.equal(gradeRegime('transition', { maxAbsMovePct: 2, expPct: 1 }), null, 'transition makes no testable claim');
  assert.equal(gradeRegime('pinned_range', { maxAbsMovePct: null, expPct: 1 }), null);
});

// ---------------------------------------------------------------- level grades

test('gradeLevels: breach detection, in-play gating, closest approach', () => {
  const levels = [
    { kind: 'call_wall', level: 102, note: '' },
    { kind: 'put_wall', level: 98, note: '' },
    { kind: 'call_wall', level: 120, note: 'far away' },
    { kind: 'gamma_flip', level: 100, note: 'ignored — not a wall' },
  ];
  const graded = gradeLevels(levels, [100.5, 101.5, 99.0, 100.0], 100);
  assert.equal(graded.length, 3, 'walls only');
  const near = graded.find((l) => l.level === 102);
  assert.equal(near.inPlay, true);
  assert.equal(near.breached, false);
  approx(near.closestApproachPct, 0.5, 1e-9, 'came within 0.5% of the call wall');
  const far = graded.find((l) => l.level === 120);
  assert.equal(far.inPlay, false, 'a wall 20% away makes no testable claim');
  const breached = gradeLevels([{ kind: 'put_wall', level: 98 }], [97.5], 100)[0];
  assert.equal(breached.breached, true);
  assert.equal(breached.closestApproachPct, 0, 'breach clamps approach to zero');
});

// ---------------------------------------------------------------- end-to-end grading on a synthetic series

const T0 = Date.UTC(2026, 6, 9, 14, 0, 0); // 10:00 ET, mid-RTH
const REC = (over = {}) => ({
  asof: new Date(T0).toISOString(),
  rubric_version: 3,
  snapshot: { symbol: 'TEST', spot: 100, vol: { iv30_vix_style: 16 }, ...(over.snapshot || {}) },
  read: {
    regime: { label: 'pinned_range', summary: '' },
    key_levels: [
      { kind: 'call_wall', level: 101, note: '' },
      { kind: 'put_wall', level: 99, note: '' },
    ],
    trade_structures: [
      { name: 'condor', direction: 'neutral', confidence: 'high', est_max_risk_usd: 500 },
      { name: 'call spread', direction: 'bullish', confidence: 'medium', est_max_risk_usd: 300 },
    ],
    ...(over.read || {}),
  },
  ...over.top,
});
const pt = (mins, spot) => ({ t: T0 + mins * 60e3, spot });

test('gradeReadAgainstSeries: quiet same-day tape grades pinned+neutral as hits at EOD', () => {
  const series = [pt(-30, 99.9), pt(30, 100.2), pt(120, 100.3), pt(300, 100.1)];
  const g = gradeReadAgainstSeries(REC(), series);
  assert.ok(g.ok, g.reason);
  assert.equal(g.primary, 'eod');
  approx(g.primaryMovePct, 0.1, 1e-6);
  assert.equal(g.regimeHit, true, 'quiet tape inside intact walls = pinned hit');
  assert.equal(g.structures.find((s) => s.direction === 'neutral').hit, true);
  assert.equal(g.structures.find((s) => s.direction === 'bullish').hit, true, '+0.1% is up');
  assert.equal(g.levels.filter((l) => l.inPlay).length, 2);
  assert.ok(g.dataPoints === 3, 'pre-read points excluded');
});

test('gradeReadAgainstSeries: a wall breach fails the pin and flags the level', () => {
  const series = [pt(30, 100.4), pt(90, 101.3), pt(300, 100.9)];
  const g = gradeReadAgainstSeries(REC(), series);
  assert.ok(g.ok);
  assert.equal(g.regimeHit, false, 'call wall breached -> pinned_range miss');
  assert.equal(g.levels.find((l) => l.kind === 'call_wall').breached, true);
});

test('gradeReadAgainstSeries: an evening read grades from the next archived day', () => {
  const series = [pt(26 * 60, 101.5), pt(27 * 60, 102.0)]; // only next-day points
  const g = gradeReadAgainstSeries(REC(), series);
  assert.ok(g.ok);
  assert.equal(g.primary, 'd1');
  approx(g.primaryMovePct, 2.0, 1e-6);
  assert.equal(g.structures.find((s) => s.direction === 'bullish').hit, true);
});

test('gradeReadAgainstSeries: no forward data is ungradeable, not a crash', () => {
  const g = gradeReadAgainstSeries(REC(), [pt(-60, 100)]);
  assert.equal(g.ok, false);
});

// ---------------------------------------------------------------- review-fix regressions

test('weekdaysBetween: strictly-after count, weekend-aware', () => {
  assert.equal(weekdaysBetween('2026-07-09', '2026-07-10'), 1, 'Thu -> Fri');
  assert.equal(weekdaysBetween('2026-07-10', '2026-07-13'), 1, 'Fri -> Mon skips the weekend');
  assert.equal(weekdaysBetween('2026-07-09', '2026-07-16'), 5, 'Thu -> next Thu = 5 trading days');
  assert.equal(weekdaysBetween('2026-07-09', '2026-07-09'), 0);
  assert.equal(weekdaysBetween('2026-07-10', '2026-07-09'), 0, 'backwards is zero, not negative');
});

test('archive gaps scale the expected move: a 5-day-later point grades against a 5-day move', () => {
  // evening Thu read; the next archived day is the FOLLOWING Thu (app was off a week)
  const rec = REC({ top: { asof: '2026-07-09T21:30:00.000Z' } });
  const gapDay = [
    { t: Date.UTC(2026, 6, 16, 15, 0, 0), spot: 102.2 }, // +2.2% over 5 trading days ~ 1 sigma at iv16
    { t: Date.UTC(2026, 6, 16, 19, 30, 0), spot: 102.2 },
  ];
  const g = gradeReadAgainstSeries(rec, gapDay);
  assert.ok(g.ok);
  assert.equal(g.primary, 'd1');
  approx(g.expPct, (16 / 16) * Math.sqrt(5), 0.01, 'expected move spans the 5 elapsed trading days');
  assert.equal(g.structures.find((s) => s.direction === 'neutral').hit, false, '2.2% is not a quiet tape, but');
  assert.equal(gradeRegime('drift_grind', { maxAbsMovePct: g.maxAbsMovePct, expPct: g.expPct, breachedCall: true, breachedPut: false }), true,
    '~1 sigma over the gap is ordinary drift once the horizon is scaled (was graded as expansion pre-fix)');
});

test('d3 is the third later day or null — never a relabeled +1d move', () => {
  const rec = REC({ top: { asof: '2026-07-09T21:30:00.000Z' } });
  const oneLaterDay = [{ t: Date.UTC(2026, 6, 10, 19, 0, 0), spot: 101 }];
  const g = gradeReadAgainstSeries(rec, oneLaterDay);
  assert.ok(g.ok);
  assert.ok('d1' in g.horizons);
  assert.ok(!('d3' in g.horizons), 'a single later day must not masquerade as +3d');
});

test('loadSeries honors the untilDay window (the first-6-days starvation fix)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gex-bt-'));
  const mk = (day, hhmmss, spot) => {
    const d = path.join(tmp, 'TEST', day);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${hhmmss}Z-cboe.json`), JSON.stringify({ computedAt: `${day}T${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4, 6)}.000Z`, spot }));
  };
  // 8 weekday archive days spanning two weeks (RTH: 15:00Z is mid-session in July/EDT)
  const days = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08', '2026-06-09', '2026-06-10'];
  days.forEach((d, i) => mk(d, '150000', 100 + i));
  const all = loadSeries('TEST', '2026-06-01', { archiveDir: tmp });
  assert.equal(all.length, 8, 'default window is unbounded — no silent 6-day cap');
  const windowed = loadSeries('TEST', '2026-06-03', { archiveDir: tmp, untilDay: '2026-06-08' });
  assert.equal(windowed.length, 4, 'from/until bounds are inclusive');
  // a read LATE in the archive still grades (the original starvation case)
  const lateRead = REC({ top: { asof: '2026-06-09T21:00:00.000Z' } });
  const g = gradeReadAgainstSeries({ ...lateRead, snapshot: { ...lateRead.snapshot, spot: 106 } }, all);
  assert.ok(g.ok, `late read grades against the full series (${g.reason || ''})`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('summarize: calibration tables count only gradeable hits', () => {
  const series = [pt(30, 100.2), pt(300, 100.1)];
  const g1 = gradeReadAgainstSeries(REC(), series);
  const g2 = { ok: false, reason: 'x' };
  const s = summarize([g1, g2]);
  assert.equal(s.confidence.high.n, 1);
  assert.equal(s.confidence.high.hits, 1);
  assert.equal(s.confidence.medium.n, 1);
  assert.equal(s.regime.pinned_range.n, 1);
  assert.equal(s.rubric.v3.n, 1);
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
