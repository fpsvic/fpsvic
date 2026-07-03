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
chain — every strike and expiry with open interest, volume, IV, and greeks — delayed
about 15 minutes. `server.js` proxies and caches it for 60 seconds.

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

## What it shows

| Panel | What it is |
|---|---|
| **Net GEX by strike** | Dollar dealer gamma per 1% spot move at each strike, with the **call wall**, **put wall**, spot, and **zero-gamma flip** annotated |
| **Gamma profile vs spot** | Total net GEX recomputed at hypothetical spot levels ±10% — the zero crossing is the flip point |
| **Vanna exposure** | Dollar delta dealers must re-hedge per +1 vol point, by strike |
| **Charm exposure** | Dollar delta decay dealers must re-hedge per calendar day, by strike |
| **Stat tiles** | Spot, net GEX, zero-gamma level, walls, and the gamma regime (positive = vol-suppressing, negative = vol-amplifying) |
| **Expiry filters** | 0DTE / ≤1 week / ≤1 month / all — everything on the page re-computes against the slice |

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
- **Call/put wall** — strike with the largest call-side / put-side gamma.

## Honest limitations (why the paid tools cost money)

- Data is ~15 minutes delayed; gexbot's paid tiers recalculate every minute from
  real-time feeds and track intraday order flow to infer *actual* dealer positioning.
- The long-calls/short-puts assumption is a blunt instrument. It's the same one the
  well-known free GEX charts use, but it's an approximation of reality.
- Educational use only. Not financial advice.
