# GEX Brain — state snapshot & upgrade roadmap

Produced by a 5-dimension audit (frontend bugs, financial math, render perf, trading UX, API design;
44 raw findings, 34 confirmed after adversarial verification) at snapshot commit `2c74bc3`, 2026-07-03.
This is the working backlog — prune items as they land.

**Status 2026-07-03, "trust the picture" batch:** fix-first **#1** (painter's sort), **#2**
(expired contracts — now DST-aware NY-close settlement via `nyCloseUtc`, dropped past the
15-min feed delay), **#3** (memoized `/api/brain` + pinned clock), **#5 in full** (delta is
now the call-minus-put imbalance, restoring a real sign channel — roadmap #7 effectively
done with it), **#7** (off-mesh landmarks labeled instead of snapped), and **#8** (walls/flip
drawn as cross-shell beams, "(all expiries)" in the legend) are **landed**, plus the charm
hedge-direction copy from #16. The **snapshot archiver** (roadmap #2's write side) ships with
the same batch: every fresh brain build lands in `gex/data/brain/` (gitignored;
`GEX_NO_ARCHIVE=1` to disable). Still open from fix-first: #6
(node tooltip), #9 (synapse sign legibility), #10 (strike ticks), #12–15, rest of #16.

**Status 2026-07-03, node inspection (fix-first #6) + per-band landmarks (roadmap #3): landed.**
Hover any node for strike/band + all four raw dollar exposures (DOM tooltip, color-coded
per greek, primary marked "(shape)"); click to PIN — pinned nodes keep ring + tooltip
across polls with live-updating values, dropped if the strike leaves the mesh.
`computeBandLandmarks` (exposure.js, via a new `minDte` bound on `computeMetrics`)
computes each band's OWN walls/flip/net from only that band's options; served as
`bandLandmarks` in /api/brain, drawn as ring markers (○ wall, ◇ flip) on each band's own
shell, with per-band net GEX in the top-left band key. On real SPX data the per-band
flips (Weekly 7472, Monthly 7469) visibly diverge from the aggregate flip (7436) —
exactly the gap this feature exists to show. Remaining from fix-first: #9 (synapse sign
legibility — partially improved), #10 (strike ticks), #12–15, rest of #16.

**Status 2026-07-03, macro view (roadmap #5): landed.** `gex/macro.html` + `gex/macro.js`:
one mini-brain per watchlist ticker (watchlist shared with the scanner via the same
localStorage key), regime-tinted cards with net-GEX/flip/wall stats and Δ-net-GEX mover
badges, click-through to the full brain. Each mini renders exactly once per 60s sweep —
no animation loop on the page at all. Server side: `/api/brain?prefer=cboe` flips the
source order CBOE-first for fan-out breadth (cache-key namespaced), and archive
filenames carry a source tag so cross-source same-second writes can't clobber each
other. Verified live: 24/24 tickers, zero errors, click-through works.

**Status 2026-07-03, render pipeline (roadmap #1 / fix-first #4 + #11): landed.** brain.js
render core rewritten: render-on-demand (idle = zero frames — the rAF loop stops entirely;
verified live: 1 frame per poll/greek-switch/toggle, frames only while dragging), glow
sprites via drawImage replace all per-draw `shadowBlur` (survives only on the ≤4 landmark
beams), edge strokes batched into color buckets, projections written into node fields and
reused (depth sort + reproject only on camera change), pulse decay moved to absolute time
so irregular frames can't stretch it, DPR re-read on resize. The macro/watchlist view's
client-side cost gate is now clear.

## 1. STATE

The GEX Brain is live and self-contained: `gex/brain.html` + `gex/brain.js` (classic script, zero deps, Canvas 2D with hand-rolled Y/X rotation + perspective in `project()`, brain.js:251–261) render four nested dome shells (0DTE/Weekly/Monthly/LEAP, `BAND_META` brain.js:44–49) of strike nodes fed by `GET /api/brain?symbol=X` (server.js:632+), which reuses the same fetch/cache/parse path as the dashboard and returns per-band arrays for all four greeks plus landmarks from `GexExposure.computeMeshBands()` / `computeMetrics()` (exposure.js). The primary greek (chip-selectable, no refetch — all four ship in every payload) deforms the shell via `bump = g * BUMP_SCALE` with global per-greek normalization (deliberate); the other three greeks render as fixed-angle satellite dots per node. Working today: spot beam with gradient + label, call/put wall halos on the 0DTE ring, pulsing flip ring, on-mesh labels with a functioning anti-overlap pass (brain.js:426–468), drag-rotate/wheel-zoom from a tuned static default camera, near-term-focus dimming applied at render time (instant toggle), `prefers-reduced-motion` support, a 20s poll loop with stale-response guarding via `loadSeq`, and per-greek diff-glow pulse seeding (brain.js:121–157). The core concept — one brain, all greeks, expiry-separated — is implemented end to end and renders correctly at the default camera. What's broken underneath: depth sort is inverted, per-frame cost is dominated by ~1,400–2,500 `shadowBlur` passes at unconditional 60fps, several landmarks are all-expiry aggregates drawn as if they were 0DTE facts, expired contracts contaminate the 0DTE band after the close, and the server recomputes ~0.5s of blocking CPU per poll off a 60s-cached body.

## 2. FIX-FIRST

Ordered by (trading impact × effort). Items 1–6 are the "trust the picture" tier; 7–11 the "trust the numbers" tier; 12–16 polish.

| # | Finding | Fix plan (one line) |
|---|---|---|
| 1 | **Inverted painter's sort** (high, ~2-line fix) | Flip both comparators to descending z (`b.p.z - a.p.z`, `b.z - a.z`) at brain.js:307/317 so far geometry draws first. |
| 2 | **Expired contracts in 0DTE band** (high) | Drop `expiry < now` options from exposure math in `parseCboe`/`computeMeshBands` AND `computeMetrics` so the after-hours mesh and landmarks aren't 22x-inflated by dead contracts at the T floor. |
| 3 | **/api/brain memoization + pinned clock** (high) | Wrap the whole response build in the existing `cached()` helper keyed `brain:{source}:{symbol}` with the chain TTL, capturing `now` once per body — kills the 0.5s/poll stall and the dte-rollover phantom pulses in one change. |
| 4 | **shadowBlur on ~2,500 draws/frame** (critical perf) | Pre-render ~20–30 glow sprites at buildScene time and `drawImage` them; keep real shadows only for walls/flip/beam/pulses (<10/frame). |
| 5 | **Delta sign channel is degenerate** (high) | Short-term: fix the copy (shell = magnitude of dealer long-delta, remove impossible "hollow"/"sulcus" claims); follow-up: plot call-minus-put dealer delta to restore a real sign channel. |
| 6 | **No node inspection** (critical UX) | Hit-test projected node positions on pointermove, draw an on-canvas tooltip (band, strike, raw primary via `fmtGex`, three satellites with sign/raw — store raws in buildScene), click-to-pin re-resolved by band+strike across polls. |
| 7 | **Out-of-window walls/flip snap to edge strike** (3 findings converge) | `nearestIdx` returns −1 beyond one strike-spacing outside `[strikes[0], strikes[last]]`; render an edge-pinned "PUT WALL 5,000 → off-mesh" label instead of a wrong halo. |
| 8 | **All-expiry flip/walls drawn on the 0DTE shell** (high) | Render aggregate landmarks as vertical markers spanning all four shells (like the spot beam) and add "(all expiries)" to legend/readout; per-band landmarks are a roadmap item. |
| 9 | **Synapse sign unreadable** (high UX) | Floor dot radius at ~2.5·DPR, clear the hollow center with a bg disc (or switch sign to dot-vs-dash), and show both variants in the legend. |
| 10 | **Strike prices absent from rings** (high UX) | Mono price ticks every N strikes on the 0DTE ring (~60px apart at current zoom) plus round-number strikes, using existing theta geometry. |
| 11 | **60fps redraw of a static scene + per-frame alloc/string churn + unbatched edges** (perf trio) | One pass: `needsRender` flag + pulse deadline, precompute all color strings/emph at buildScene, project into reused node fields, offscreen static-edge layer with ~20 color buckets. |
| 12 | **Symbol-switch state bleed** (header/readout mismatch, cross-symbol prevValues) | Commit `currentSymbol`/title/backLink only on successful load; clear `prevValues` when the symbol changes. |
| 13 | **Stale non-primary diff maps + renormalization pulses** | Update `prevValues` for all four greeks every poll and diff raw values scaled by prior maxAbs so pulses require the node's own exposure to move. |
| 14 | **Poll economics + error handling** | Send `dataAsof`/ETag so unchanged polls short-circuit; negative-cache upstream failures 30–60s; 400/404/502 distinction; client backoff after consecutive errors. |
| 15 | **Diff-glow decays in 1.4s of a 20s cycle, unsigned** | Stretch decay to ~12–15s, tint teal/orange by `sign(g - prior)`, add "N nodes changed" to the status line. |
| 16 | **Copy/label batch** (all low, one sitting) | Unit suffixes + scope tags on net rows; `r-asof` = real timestamp + "delayed CBOE" header; charm hedge-direction wording; precision-aware `fmtPrice` from strike step; on-mesh band labels replacing the fake color key; regime tint on the spot beam; reset-view button + stale-timer status; `classList.toggle` for hud; per-pointerId drag filtering; recompute DPR in `resize()`. |

## 3. ROADMAP

Ranked for short-term-trading value. Owner candidates (a) macro view, (b) history/playback, (c) 3rd-order greeks are folded in at #2, #5, #8.

1. **Render pipeline overhaul** (fix-first #4 + #11 done as one project) — **M**. Why: the tool's job is to sit open all day next to an execution platform; today it pins a core doing nothing. Unblocks: everything downstream — playback scrubbing needs cheap rebuilds, and the macro view needs N brains per page, which is arithmetic impossibility at current per-brain cost.
2. **Real snapshot history + playback** (owner candidate b) — **L**. Server archives each fresh (memoized) `/api/brain` payload to disk (JSON-per-timestamp is fine at ~1 payload/min); client gets a scrub bar + "since open" / "last 30 min" diff modes. Why: the single highest-value trading question — *is the wall building or pulling?* — is unanswerable live-only; the diff-glow is an admitted stopgap that catches at most 1-in-3 polls. Unblocks: retires the entire diff-glow fragility cluster (#13, #15), enables open-vs-now regime reads, and feeds the macro view's change columns. **Start archiving now even before the UI exists — data not written today is gone forever.**
3. **Per-band landmarks from the server** — **M**. `computeMetrics` per expiry band (walls, flip, net per band), drawn on each band's own ring; aggregate landmarks stay as the cross-shell vertical markers from fix #8. Why: on expiry days the 0DTE flip vs aggregate flip gap is exactly what a scalper trades; this makes the "shells separate exposure by expiry" premise actually true for levels, not just texture. Unblocks: honest 0DTE-only reads, band-level regime tags.
4. **Node selection → action loop** — **M** (builds on tooltip fix #6). Pinned nodes persist across polls with their own raw-value sparkline (from #2's history), click-through deep-links to the dashboard's strike detail, optional threshold alert ("pulse + status flash when 6050 gamma changes >X"). Why: closes the loop from *see the fold* to *watch the level* to *act*; a trading tool's endgame is levels you're stalking, not a picture you admire.
5. **Macro / whole-watchlist brain view** (owner candidate a) — **L**. Grid of mini-brains (static camera, no satellites, primary greek only, shared render loop) with net-GEX regime tint and biggest-mover badges, click-through to the full brain. Why: short-term traders triage the tape before drilling in; one symbol at a time forces the triage into another tool. Gated on: #1 (client cost) and fix #3 (server cost — N symbols × recompute would flatten Node without memoization). Unblocks: the brain becoming the toolkit's home screen.
6. **Freshness & reliability layer** (fix-first #14 grown up) — **S**. `dataAsof` in payload, ETag/304 polls, live "asof 14:32:05 (18s ago)" counter, stale-desaturation on failure, error backoff. Why: a 20s-polling tool built on 60s-cached 15-min-delayed data must be honest about age or it will get someone run over at the open. Unblocks: fast polling becomes nearly free, so `POLL_MS` can stay at 20s guilt-free once the server is memoized.
7. **Signed delta view** (completes fix #5) — **S/M**. Plot call-minus-put dealer delta (or demeaned per-strike delta) so the delta shell's fold/color channel carries information again. Why: today the delta chip is a wasted quarter of the "one brain, all greeks" promise. Unblocks: delta as a legitimate fourth primary, delta-drift overlays with charm.
8. **3rd-order greeks prototype** (owner candidate c) — **M**, explicitly last and gated. Offline accuracy pass first: compute speed/color/ultima from quoted IV on archived snapshots (#2 provides the corpus), measure poll-to-poll noise vs signal before any pixel is drawn. Why last: numerically noisy greeks rendered confidently would erode trust in the greeks that are right; the archive is the cheap way to prove or kill the idea.

## 4. RISKS

1. **Every day without archiving is unrecoverable data loss.** History (#2) is the roadmap's centerpiece, and its raw material can't be backfilled — CBOE delayed snapshots not written to disk today don't exist tomorrow. The write side is a ~20-line addition to the memoized route; deferring it until the playback UI is designed forfeits weeks of corpus. Ship the archiver first, the UI later.
2. **Wrong-at-the-close kills trust faster than any missing feature.** The current after-hours picture is actively false (expired contracts at 22x gamma in the 0DTE band, all-expiry landmarks masquerading as 0DTE levels, walls snapped to wrong strikes, a delta view whose sign channel can't fire). A short-term trader burned once by a phantom wall stops opening the page; no amount of rendering polish recovers that. Fixes #2, #5, #7, #8 are cheap and existential.
3. **Perf debt silently caps the product at one brain.** The 60fps shadowBlur loop plus the 0.5s single-threaded server recompute per poll means the macro/watchlist view — the most likely path to this becoming the daily driver — is currently infeasible, and each new visual feature added before the pipeline overhaul makes the overhaul harder. Treat #1 (client) and fix #3 (server) as the foundation the roadmap stands on, not as optimizations to do "when it feels slow."

Files: `D:\claude\gexbot\fpsvic\gex\brain.js`, `D:\claude\gexbot\fpsvic\gex\brain.html`, `D:\claude\gexbot\fpsvic\gex\server.js` (route at line 632), `D:\claude\gexbot\fpsvic\gex\exposure.js`.