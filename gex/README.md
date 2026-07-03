# Personal GEX

A free, self-hosted gamma-exposure dashboard in the spirit of gexa.ai and gexbot.com —
built for personal use with zero dependencies and zero data-feed cost.

## Quick start

```bash
node gex/server.js
# open http://localhost:8787
```

That's it. No npm install, no API key, no account. Requires Node 18+ (for built-in `fetch`).

You can also open `gex/index.html` directly as a file and click **Demo data**, but live
quotes need the little server because browsers block cross-origin requests to CBOE.

## Where the data comes from

**CBOE delayed quotes (default).** CBOE publishes this API for free:
`https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json` (indexes use a `_`
prefix; equities/ETFs like `SPY.json` don't). Each response contains the full options
chain — every strike and expiry with bid/ask, open interest, volume, IV, and greeks —
delayed about 15 minutes. `server.js` proxies and caches it for 60 seconds.

Two more free CBOE endpoints feed the volatility panel:

- `charts/historical/{symbol}.json` — daily OHLC back to 1975, used for the 21-day
  realized vol (proxied as `/api/history`, trimmed to the last 80 sessions).
- `quotes/_VIX.json` — a ~500-byte delayed VIX spot, shown next to the chain-derived
  proxy as a sanity reference (proxied as `/api/vix`).

Works with SPX, SPY, QQQ, IWM, NDX, RUT, VIX, and any US ticker with listed options.

**Tradier (optional).** If you have a Tradier account, the same dashboard can pull from
Tradier's market-data API instead. Put your token in a `.env` file:

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
  pulls the nearest 12 by default (`TRADIER_MAX_EXPIRIES=20` to raise it) to stay well
  inside Tradier's rate limits. Responses are normalized to the CBOE payload shape, so
  the frontend is source-agnostic.
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
- Educational use only. Not financial advice.
