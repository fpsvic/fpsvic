# Personal GEX

A free, self-hosted gamma-exposure toolkit in the spirit of gexa.ai and gexbot.com —
built for personal use with zero dependencies and zero data-feed cost. Three views:

- a **multi-ticker scanner** (`/`) that ranks a watchlist by how mispriced each name's
  implied vol is, so you can spot top-tier situations across many symbols at once,
- the original **single-ticker dashboard** (`/index.html?symbol=SPX`) — dealer
  gamma/vanna/charm exposure, walls, the zero-gamma flip, the VIX-style vol panel, and
  the on-demand AI read — that each scanner row click-throughs into, and
- the **brain view** (`/brain.html?symbol=SPX`) — a 3D mesh of the whole chain that
  shows all four greeks at once, built for at-a-glance short-term-trading reads.

## Quick start

```bash
node gex/server.js
# open http://localhost:8787  -> the scanner
```

That's it. No npm install, no API key, no account. Requires Node 18+ (for built-in `fetch`).
`/` opens the scanner; the single-ticker dashboard lives at `/index.html?symbol=SPX`.

You can also open `gex/scan.html` or `gex/index.html` directly as a file and click
**Demo scan** / **Demo data**, but live quotes need the little server because browsers
block cross-origin requests to CBOE.

## The scanner

The landing page scans a watchlist and ranks each ticker by a **cross-ticker
vol-mispricing score** — a heuristic on the *price* of convexity (vol risk premium, term
slope, 25Δ butterfly, and the convexity read), with every raw vol-point input divided by
the ticker's own 30-day implied vol so a 14-vol index and a 60-vol single name rank on the
same footing. The signed score leans **rich** (implied expensive vs realized — a
sell-premium tilt) or **cheap** (own convexity); rows sort by magnitude, and the sign is
the lean. A `+5`-vol-point premium reads as rich on 14-vol SPX (0.36 of its vol) but cheap
on 60-vol TSLA (0.08 of its vol) — the fairness gap raw thresholds can't close. The scoring
math is `GexMetrics.volMispricingScore` in `metrics.js`, next to `convexityRead`.

- **Gamma context, not gamma ranking.** Net GEX, the gamma regime, call/put walls and the
  zero-gamma flip ride along as display columns but never enter the rank — the scan is
  about vol mispricing; the gamma picture is what you dig into on the detail page.
- **Editable watchlist**, seeded with a liquid default (SPX, SPY, QQQ, IWM, NDX, RUT, and
  the megacaps) and persisted in `localStorage`. Add/remove tickers; **Reset** restores
  the defaults.
- **CBOE for breadth.** The scan reads CBOE delayed quotes (~15 min) — one request per
  ticker, so a whole watchlist scans in seconds. Tradier's real-time feed makes ~20
  sequential per-expiry calls per ticker, which can't survive a concurrent fan-out, so the
  scanner deliberately uses CBOE and the *detail page* uses Tradier for the real-time
  deep-dive. (Pass `?source=tradier` on `/api/scan/row` to override per request.)
- **AI on the top picks.** After a scan, **Read top 3** sends the top-ranked names'
  snapshots to the same `/api/analyze` endpoint the dashboard uses (same rubric, same
  cache) and shows a compact structured read per name — regime, a one-liner, and the
  single highest-confidence structure — each linking to the full read. Manual, so it only
  spends API credits when you ask; requires an `ANTHROPIC_API_KEY`.
- **Demo scan** builds a spread of synthetic tickers entirely client-side (no server, no
  network) via the exact same row assembler the server uses.

Each row is computed server-side at `GET /api/scan/row?symbol=SYM` (the browser drives a
small concurrency pool so rows stream in and rank once the scan settles). A single bad
ticker yields an error row instead of sinking the scan. The exposure/vol/score math is
shared with the dashboard through `exposure.js` (`GexExposure`, a dual-loading module like
`metrics.js`), so the server computes exactly what the browser does — a 13 MB chain never
crosses the wire, and the snapshot serializes identically on both sides so the analyze
cache is shared. `GEX_NO_LISTEN=1 node gex/scan.test.js` and `node gex/exposure.test.js`
test the pipeline.

## The brain view

`/brain.html?symbol=SPX` renders the whole chain as a 3D "brain": four nested dome
shells — one per expiry band (0DTE / weekly / monthly / LEAP) — each a ring of strike
nodes, drawn with plain Canvas 2D and a hand-rolled perspective projection (no WebGL,
no libraries). It exists to answer one question at a glance: *where is the dealer book
concentrated, and on which greek, right now?*

- **Primary shape.** One greek (gamma by default; vanna/charm/delta selectable) deforms
  the shells: positive exposure bulges a node outward (a *gyrus* — call-side,
  dealer-stabilizing for gamma), negative folds it inward (a *sulcus*). Node size and
  bulge are normalized against the single largest value in the whole mesh, so shell-to-
  shell differences are honest: far-dated shells genuinely look quiet because they are.
- **Synapses.** The other three greeks orbit every node as small satellites at fixed
  angles: color says *which* greek (teal gamma, blue vanna, gold charm, pink delta),
  filled vs hollow says sign, distance from the node says magnitude. All four greeks are
  visible simultaneously — switching the primary just re-chooses which one drives the shape.
- **Landmarks.** A violet spot beam cuts through every shell at the current price;
  call/put walls get halo rings; the active greek's zero-crossing gets a pulsing flip
  ring; and spot/walls/flip carry on-mesh price labels with collision avoidance (walls
  merge into one label when they land on the same strike).
- **Built for short-term trading.** The camera is static by default (drag to orbit,
  scroll to zoom — it never drifts on its own), and *near-term focus* (default on) dims
  the monthly/LEAP shells so 0DTE/weekly gamma dominates the read; one button restores
  equal prominence.
- **Data path.** `GET /api/brain?symbol=SYM` returns a strike × expiry-band grid of all
  four greeks (`GexExposure.computeMeshBands`) plus the landmark levels, reusing the
  exact chain fetch/cache/parse path as the dashboard — the numbers can never drift
  between views. The response is memoized on the chain's cache TTL, and every fresh
  build is archived to `gex/data/brain/` (the raw corpus for future playback;
  `GEX_NO_ARCHIVE=1` disables). The page polls every 20 s and pulses nodes whose
  exposure moved since the last poll (a live-only stand-in for real playback).

### The macro view

`/macro.html` is the triage screen: one **mini-brain per watchlist ticker** (the
watchlist is shared with the scanner — same localStorage list), each a simplified
render — static camera, gamma only, near-term emphasis baked in — that draws exactly
once per sweep. Cards carry the regime at a glance (border + `DEALERS LONG γ` /
`SHORT γ` chip on the sign of net GEX), spot, walls, and flip, plus a **mover badge**
(Δ net GEX since the previous sweep, top-3 movers called out). Click any card for the
full brain. Sweeps run every 60 s through a small request pool with `?prefer=cboe`,
because CBOE answers a whole chain in one request per ticker — the same fan-out
reasoning as the scanner.

**CBOE delayed quotes (default).** CBOE publishes this API for free:
`https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json` (indexes use a `_`
prefix; equities/ETFs like `SPY.json` don't). Each response contains the full options
chain — every strike and expiry with bid/ask, open interest, volume, IV, and greeks —
delayed about 15 minutes. `server.js` proxies and caches it for 60 seconds.

Two more endpoints feed the volatility panel — `/api/history` (daily closes for the
21-day realized vol) and `/api/vix` (the VIX spot shown next to the chain-derived
proxy). With a Tradier token these come from Tradier (live); without one they come
from CBOE's free `charts/historical/{symbol}.json` and `quotes/_VIX.json`.

Works with SPX, SPY, QQQ, IWM, NDX, RUT, VIX, and any US ticker with listed options.

**Tradier (recommended).** With a Tradier account token, the dashboard sources
*everything* from Tradier — real-time chains and spot, daily history, and a live VIX
quote — with CBOE kept as the automatic fallback so an outage or expired token
degrades to delayed data instead of no data. Put your token in a `.env` file:

```bash
cp gex/.env.example gex/.env   # then edit gex/.env and paste your token
node gex/server.js
```

or pass it inline (`TRADIER_TOKEN=your-api-token node gex/server.js`). `gex/.env` is
gitignored, and real environment variables override it.

- Works with a brokerage API token, or a free [developer sandbox](https://documentation.tradier.com/)
  token (`TRADIER_SANDBOX=1` switches to the sandbox host).
- Quotes/spot are real-time on brokerage tokens (vs CBOE's 15-minute delay).
- Greeks and IV come from ORATS and refresh roughly hourly — fine for GEX, since open
  interest (the other big input) only updates daily anyway.
- Big chains like SPX have dozens of expirations, each a separate API call; the server
  pulls 20 by default (`TRADIER_MAX_EXPIRIES` to change it) to stay well inside
  Tradier's rate limits — the nearest few for 0DTE/weekly exposure, then dates nearest
  fixed horizons (10–180d) so the 30-day VIX proxy and term structure stay honest even
  on daily-expiry chains. Responses are normalized to the CBOE payload shape, so the
  frontend is source-agnostic.
- `?source=cboe` / `?source=tradier` on `/api/chain` forces a source per request.
- If the token is expired or revoked, the server logs a warning and quietly falls back
  to CBOE instead of failing (explicit `?source=tradier` still surfaces the error).

## What it shows

| Panel | What it is |
|---|---|
| **Net GEX by strike** | Dollar dealer gamma per 1% spot move at each strike, with the **call wall**, **put wall**, spot, and **zero-gamma flip** annotated |
| **Gamma profile vs spot** | Total net GEX recomputed at hypothetical spot levels ±10% — the zero crossing is the flip point |
| **Vanna profile / ladder** | Dollar delta dealers must re-hedge per +1 vol point — as a profile vs hypothetical spot (with its own flip) or by strike, toggle per card |
| **Charm profile / ladder** | Dollar delta decay dealers must re-hedge per calendar day — same profile/ladder toggle |
| **Volatility & convexity** | VIX-style 30-day implied vol (the "VIX proxy"), the implied-vol term structure with realized vol and the live VIX overlaid, vol risk premium, term slope, 25Δ butterfly & skew, and a labeled heuristic verdict: is convexity being **bid** or **offered**? |
| **AI read** | On demand, Claude reads the computed snapshot through a fixed rubric and returns a structured market read: regime label, key levels, if/then scenarios, and 2–4 option structures each with an explicit invalidation level and confidence. Requires an `ANTHROPIC_API_KEY` |
| **Stat tiles** | Spot, net GEX, zero-gamma level, walls, gamma regime, VIX proxy (vs the real VIX), vol premium, and the convexity read |
| **Expiry filters** | 0DTE / ≤1 week / ≤1 month / all — the exposure charts re-compute against the slice; the volatility panel is fixed-horizon and ignores it |

A per-strike table view backs every chart, and the whole thing supports dark mode.

## How the math works

- **Dealer convention** — the classic naive assumption used by most public GEX tools:
  dealers are **long calls, short puts**. Call gamma contributes positive (stabilizing)
  exposure, put gamma negative (destabilizing).
- **GEX per strike** = Σ gamma × OI × 100 × spot² × 1% (dollars of hedging per 1% move).
- **Gamma, vanna, charm** are computed with Black–Scholes from each option's quoted IV
  (flat 4% rate, no dividends). Options with no usable IV fall back to CBOE's quoted
  gamma and are excluded from vanna/charm.
- **Zero-gamma flip** — rather than a cumulative-sum shortcut, the total book gamma is
  re-priced at 81 hypothetical spot levels; the sign change closest to spot is the flip.
  Vanna and charm get the same treatment (and their own flip markers) in profile view.
- **Call/put wall** — strike with the largest call-side / put-side gamma.
- **VIX proxy** — the CBOE VIX methodology (Cboe Volatility Index Mathematics
  Methodology v5.0) applied to the loaded chain: per-expiry model-free variance from
  OTM mid quotes ( σ² = (2/T)·Σ ΔK/K²·e^(rT)·Q − (1/T)(F/K₀−1)² ), forward from
  put-call parity at the min-|C−P| strike, zero-bid/zero-ask quotes excluded with the
  two-consecutive stopping rule, then the standard 30-day interpolation between the two
  bracketing expiries. Validated in tests (a flat-IV chain recovers its IV) and, live,
  lands within a few tenths of the published VIX. All of this lives in `gex/metrics.js`
  (`node gex/metrics.test.js` runs the suite).
- **Realized vol** — annualized close-to-close over the trailing 21 sessions
  (zero-mean convention), from the free CBOE daily history.
- **Convexity read** — a transparent, weighted heuristic on three inputs, each centered
  on its typical SPX value: vol risk premium (IV30 − RV21, centered +3), term slope
  (IV30 − IV7, centered +1.5; negative = backwardation), and the 25Δ butterfly
  (centered +1). Score > 0.2 → convexity **bid** (traders paying up for optionality),
  < −0.2 → **offered** (optionality cheap / supplied), else **balanced**. It measures
  the *price* of convexity — the accepted proxy for demand vs supply — not actual
  order flow, which needs positioning data no free feed provides.

## The AI read

The "AI read" card sends a compact JSON snapshot of everything the dashboard computed —
exposures, walls, flips, the VIX proxy, term slope, smile, convexity verdict; numbers
only, never screenshots — to `POST /api/analyze`, which calls Claude
(`claude-opus-4-8` by default) with a fixed, versioned rubric and a forced JSON output
schema. Consistency is the design goal: the rubric mechanically maps regimes to
playbooks, the schema fixes the output shape, inputs are rounded so identical market
states serialize identically, and responses are cached for 10 minutes on a hash of the
snapshot. Same data in, same read out.

Setup: put `ANTHROPIC_API_KEY=...` in `gex/.env` (create a key at platform.claude.com)
and restart the server. Each read costs roughly 1–3¢ at Opus pricing; `ANTHROPIC_MODEL`
and `ANTHROPIC_EFFORT` in `.env` tune the cost/latency/quality trade-off.
`GEX_NO_LISTEN=1 node gex/analyze.test.js` tests the schema and request builder.

Guardrails, by construction: the prompt forbids position sizing and imperatives, every
structure must carry an explicit invalidation level, missing inputs must be surfaced as
cautions rather than guessed, and nothing is ever executed — the output is a read, not
an order. The model only sees numbers the dashboard computed; strings in the snapshot
are declared data, not instructions.

## Honest limitations (why the paid tools cost money)

- Data is ~15 minutes delayed; gexbot's paid tiers recalculate every minute from
  real-time feeds and track intraday order flow to infer *actual* dealer positioning.
- The long-calls/short-puts assumption is a blunt instrument. It's the same one the
  well-known free GEX charts use, but it's an approximation of reality.
- The VIX proxy is VIX-*style*, not VIX: retail-delayed mids, a flat 4% rate instead
  of per-expiry CMT-spline rates, days instead of minutes, and none of CBOE's quote
  filtering. Expect it within a few tenths of the real print, not on top of it.
- A fat vol premium or front-end backwardation can simply mean a scheduled event
  (FOMC, CPI, earnings) is being priced, not generalized stress — the convexity read
  doesn't know the calendar.
- The AI read only knows the snapshot: no news, no calendar, no order flow, no
  positioning data. It is a disciplined interpretation of dealer-positioning math,
  not a forecast — treat its structures as hypotheses with stated invalidations.
- Educational use only. Not financial advice.
