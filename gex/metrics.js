'use strict';

/* GexMetrics — chain-level volatility & convexity analytics for the Personal GEX dashboard.
 *
 * Classic zero-dependency script: defines globalThis.GexMetrics for the browser and
 * exports via module.exports when evaluated with a CommonJS-style shim (see metrics.test.js).
 *
 * Everything here operates on the parsed chain format produced by app.js:
 *   option: { type: 'C'|'P', strike, expiry (ms), dte, T (years), iv, bid, ask, oi }
 * Open interest is NOT required — quotes with zero OI still carry price information.
 */

(function (root) {

  // ---------------------------------------------------------------- helpers

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

  function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

  // Zelen & Severo A&S 26.2.17 — max abs error ~7.5e-8, plenty for vol work
  function normCdf(x) {
    if (x < 0) return 1 - normCdf(-x);
    const t = 1 / (1 + 0.2316419 * x);
    const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return 1 - normPdf(x) * poly;
  }

  // ---------------------------------------------------------------- black-scholes

  function d1(S, K, T, sigma, r) {
    return (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  }

  function bsPrice(S, K, T, sigma, r, type) {
    const D1 = d1(S, K, T, sigma, r);
    const D2 = D1 - sigma * Math.sqrt(T);
    if (type === 'C') return S * normCdf(D1) - K * Math.exp(-r * T) * normCdf(D2);
    return K * Math.exp(-r * T) * normCdf(-D2) - S * normCdf(-D1);
  }

  function bsDelta(S, K, T, sigma, r, type) {
    const D1 = d1(S, K, T, sigma, r);
    return type === 'C' ? normCdf(D1) : normCdf(D1) - 1;
  }

  // ---------------------------------------------------------------- per-expiry variance (CBOE VIX methodology)

  /* Model-free variance for the options of ONE expiry, following the CBOE VIX rules:
   *   - forward F from the strike K* with the smallest |call mid - put mid|:
   *       F = K* + e^(rT) (C - P)
   *   - K0 = largest strike <= F
   *   - contributions: OTM puts below K0, OTM calls above K0, (C+P)/2 at K0
   *   - zero-bid quotes are skipped; after TWO consecutive zero-bid strikes moving
   *     away from K0, everything further out is excluded
   *   - dK_i = (K_{i+1} - K_{i-1}) / 2, single-sided at the edges
   *   - sigma^2 = (2/T) sum(dK_i / K_i^2 * e^(rT) * Q_i) - (1/T)(F/K0 - 1)^2
   *
   * opts: options of one expiry; T in years; r risk-free rate.
   * Returns { ok:true, T, F, K0, sigma2, n } or { ok:false, reason }. */
  function expiryVariance(opts, T, r) {
    if (!(T > 0)) return { ok: false, reason: 'non-positive T' };

    // per-strike quotes; keep zero-bid entries so the consecutive-zero rule can see them
    const calls = new Map(), puts = new Map();
    for (const o of opts) {
      const live = o.bid > 0 && o.ask > 0;
      const q = { live, mid: live ? (o.bid + o.ask) / 2 : 0 };
      (o.type === 'C' ? calls : puts).set(o.strike, q);
    }

    // forward from put-call parity at the strike with minimal |C - P| (live quotes only)
    let kStar = NaN, bestDiff = Infinity;
    for (const [k, c] of calls) {
      const p = puts.get(k);
      if (!c.live || !p || !p.live) continue;
      const d = Math.abs(c.mid - p.mid);
      if (d < bestDiff) { bestDiff = d; kStar = k; }
    }
    if (!isFinite(kStar)) return { ok: false, reason: 'no strike quotes both call and put' };
    const F = kStar + Math.exp(r * T) * (calls.get(kStar).mid - puts.get(kStar).mid);
    if (!(F > 0)) return { ok: false, reason: 'bad forward' };

    const strikes = [...new Set([...calls.keys(), ...puts.keys()])].sort((a, b) => a - b);
    let K0 = strikes[0];
    for (const k of strikes) { if (k <= F) K0 = k; else break; }

    const i0 = strikes.indexOf(K0);
    const contrib = []; // {k, q}

    // puts below K0, walking down; stop after two consecutive zero-bid strikes
    for (let i = i0 - 1, zeros = 0; i >= 0; i--) {
      const p = puts.get(strikes[i]);
      if (!p || !p.live) { if (++zeros >= 2) break; continue; }
      zeros = 0;
      contrib.push({ k: strikes[i], q: p.mid });
    }
    // calls above K0, walking up; same rule
    for (let i = i0 + 1, zeros = 0; i < strikes.length; i++) {
      const c = calls.get(strikes[i]);
      if (!c || !c.live) { if (++zeros >= 2) break; continue; }
      zeros = 0;
      contrib.push({ k: strikes[i], q: c.mid });
    }
    // at K0: average of call and put mids (or whichever side is live)
    const c0 = calls.get(K0), p0 = puts.get(K0);
    if (c0?.live && p0?.live) contrib.push({ k: K0, q: (c0.mid + p0.mid) / 2 });
    else if (c0?.live) contrib.push({ k: K0, q: c0.mid });
    else if (p0?.live) contrib.push({ k: K0, q: p0.mid });

    contrib.sort((a, b) => a.k - b.k);
    if (contrib.length < 5) return { ok: false, reason: `only ${contrib.length} usable quotes` };

    let sum = 0;
    for (let i = 0; i < contrib.length; i++) {
      const kPrev = contrib[i - 1]?.k, kNext = contrib[i + 1]?.k;
      const dK = kNext != null && kPrev != null ? (kNext - kPrev) / 2
        : kNext != null ? kNext - contrib[i].k
        : contrib[i].k - kPrev;
      sum += (dK / (contrib[i].k * contrib[i].k)) * Math.exp(r * T) * contrib[i].q;
    }
    const sigma2 = (2 / T) * sum - (1 / T) * Math.pow(F / K0 - 1, 2);
    if (!(sigma2 > 0)) return { ok: false, reason: 'non-positive variance' };

    return { ok: true, T, F, K0, sigma2, n: contrib.length };
  }

  // ---------------------------------------------------------------- 30-day VIX-style index + term structure

  /* VIX-style index from a full chain: per-expiry model-free variance, then the CBOE
   * 30-day interpolation between the expiries bracketing 30 calendar days:
   *   VIX = 100 sqrt( [T1 s1^2 (N2-30)/(N2-N1) + T2 s2^2 (30-N1)/(N2-N1)] * 365/30 )
   * Falls back to the nearest single expiry when 30 days is not bracketed.
   *
   * options: full parsed chain; r risk-free; horizonDays defaults to 30.
   * Returns { ok, value, method, near, next, term:[{days,T,iv,F,K0,n}] } */
  function vixStyle(options, r, horizonDays = 30) {
    // group by expiry AND root: SPX (AM-settled) and SPXW (PM-settled) can share
    // an expiration date but are distinct series with distinct forwards
    const byGroup = new Map();
    for (const o of options) {
      const key = `${o.expiry}|${o.root || ''}`;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(o);
    }

    const candidates = [];
    for (const [, opts] of byGroup) {
      const T = opts[0].T;
      if (T < 0.5 / 365) continue; // sub-half-day expiries are too noisy
      const v = expiryVariance(opts, T, r);
      if (v.ok) candidates.push({ days: T * 365, T, iv: 100 * Math.sqrt(v.sigma2), sigma2: v.sigma2, F: v.F, K0: v.K0, n: v.n, expiry: opts[0].expiry, root: opts[0].root || '' });
    }
    // when two roots land on the same date, keep the series with more usable quotes
    const bestByExpiry = new Map();
    for (const c of candidates) {
      const cur = bestByExpiry.get(c.expiry);
      if (!cur || c.n > cur.n) bestByExpiry.set(c.expiry, c);
    }
    const term = [...bestByExpiry.values()];
    term.sort((a, b) => a.T - b.T);
    if (!term.length) return { ok: false, reason: 'no expiry had enough usable quotes', term };

    let near = null, next = null;
    for (const t of term) { if (t.days <= horizonDays) near = t; else { next = t; break; } }

    let value, method;
    if (near && next) {
      const N1 = near.days, N2 = next.days;
      const w = (N2 - horizonDays) / (N2 - N1);
      const totalVar = near.T * near.sigma2 * w + next.T * next.sigma2 * (1 - w);
      value = 100 * Math.sqrt(totalVar * (365 / horizonDays));
      method = 'interpolated';
    } else {
      const t = near || next; // whichever side exists, nearest to the horizon
      value = t.iv;
      method = `single-expiry (${t.days.toFixed(1)}d)`;
      near = near || t; next = next || null;
    }
    return { ok: true, value, method, near, next, term };
  }

  /* Interpolated VIX-style vol at an arbitrary horizon, linear in total variance
   * between bracketing expiries; flat extrapolation outside the curve. */
  function ivAtHorizon(term, days) {
    if (!term.length) return NaN;
    if (days <= term[0].days) return term[0].iv;
    const last = term[term.length - 1];
    if (days >= last.days) return last.iv;
    for (let i = 1; i < term.length; i++) {
      const a = term[i - 1], b = term[i];
      if (days >= a.days && days <= b.days) {
        const t = (days - a.days) / (b.days - a.days);
        const totalVar = a.T * a.sigma2 * (1 - t) + b.T * b.sigma2 * t;
        return 100 * Math.sqrt(totalVar * 365 / days);
      }
    }
    return last.iv;
  }

  // ---------------------------------------------------------------- realized vol

  /* Annualized close-to-close realized vol (zero-mean convention, in vol points)
   * over the trailing `window` daily returns. closes: oldest -> newest. */
  function realizedVol(closes, window = 21) {
    const c = closes.filter((x) => isFinite(x) && x > 0);
    if (c.length < window + 1) return { ok: false, reason: `need ${window + 1} closes, have ${c.length}` };
    let sumSq = 0;
    for (let i = c.length - window; i < c.length; i++) {
      const r = Math.log(c[i] / c[i - 1]);
      sumSq += r * r;
    }
    return { ok: true, value: 100 * Math.sqrt(252 * (sumSq / window)), window };
  }

  // ---------------------------------------------------------------- 25-delta smile (butterfly & risk reversal)

  /* Wing pricing at one expiry from quoted IVs.
   *   butterfly = (IV_25dPut + IV_25dCall)/2 - IV_ATM   (price of convexity / tails)
   *   risk reversal = IV_25dPut - IV_25dCall            (equity convention: put skew positive)
   * opts: options of one expiry; F: forward (from expiryVariance); returns vol points. */
  function smileAtExpiry(opts, S, F, T, r) {
    const quoted = opts.filter((o) => o.iv > 0.005);
    if (!quoted.length) return { ok: false, reason: 'no quoted IVs' };

    let atmK = NaN, bestD = Infinity;
    for (const o of quoted) {
      const d = Math.abs(o.strike - F);
      if (d < bestD) { bestD = d; atmK = o.strike; }
    }
    const atmIvs = quoted.filter((o) => o.strike === atmK).map((o) => o.iv);
    const atm = atmIvs.reduce((a, b) => a + b, 0) / atmIvs.length;

    const wingIv = (type) => {
      // OTM side only, sorted moving away from the money so |delta| falls toward 0
      const side = quoted
        .filter((o) => o.type === type && (type === 'C' ? o.strike >= F : o.strike <= F))
        .sort((a, b) => (type === 'C' ? a.strike - b.strike : b.strike - a.strike))
        .map((o) => ({ d: Math.abs(bsDelta(S, o.strike, T, o.iv, r, type)), iv: o.iv }));
      for (let i = 1; i < side.length; i++) {
        const a = side[i - 1], b = side[i];
        if ((a.d - 0.25) * (b.d - 0.25) <= 0 && a.d !== b.d) {
          return a.iv + (b.iv - a.iv) * ((a.d - 0.25) / (a.d - b.d));
        }
      }
      return NaN;
    };

    const c25 = wingIv('C'), p25 = wingIv('P');
    if (!isFinite(c25) || !isFinite(p25)) return { ok: false, reason: 'smile too sparse for 25-delta wings' };
    return {
      ok: true,
      atm: 100 * atm, call25: 100 * c25, put25: 100 * p25,
      fly: 100 * ((p25 + c25) / 2 - atm),
      rr: 100 * (p25 - c25),
    };
  }

  // ---------------------------------------------------------------- convexity demand read

  /* Heuristic composite: is the market bidding for convexity or supplying it?
   * Inputs (any may be null when unavailable; weights renormalize):
   *   vrp   - 30d implied minus realized vol, vol pts.
   *   slope - iv30 - iv7, vol pts. Negative (backwardation) = urgent demand
   *           for near-dated convexity.
   *   fly   - 25d butterfly, vol pts. Higher = wings/tails bid.
   *   iv30  - the vol level itself. WHEN PRESENT, every input is judged as a
   *           FRACTION of iv30 (centers 0.20/0.10/0.07 — the SPX-typical raw
   *           values 3/1.5/1 at iv=15, and exactly volMispricingScore's
   *           centers) so a +5pt premium reads rich on a 14-vol index and
   *           unremarkable on a 60-vol single name. Without iv30 the legacy
   *           raw SPX-point centers apply — index-calibrated only; the quant
   *           review showed they overstate 'bid' on high-vol names.
   * Returns { ok, score in [-1,1], verdict: 'bid'|'offered'|'balanced' }. */
  function convexityRead({ vrp = null, slope = null, fly = null, iv30 = null }) {
    const parts = [];
    if (iv30 != null && isFinite(iv30)) {
      const IVf = Math.max(iv30, 1); // same floor as volMispricingScore
      if (vrp != null && isFinite(vrp)) parts.push({ w: 0.5, x: clamp((vrp / IVf - 0.20) / 0.25, -1, 1) });
      if (slope != null && isFinite(slope)) parts.push({ w: 0.3, x: clamp(-(slope / IVf - 0.10) / 0.13, -1, 1) });
      if (fly != null && isFinite(fly)) parts.push({ w: 0.2, x: clamp((fly / IVf - 0.07) / 0.07, -1, 1) });
    } else {
      if (vrp != null && isFinite(vrp)) parts.push({ w: 0.5, x: clamp((vrp - 3) / 4, -1, 1) });
      if (slope != null && isFinite(slope)) parts.push({ w: 0.3, x: clamp(-(slope - 1.5) / 2, -1, 1) });
      if (fly != null && isFinite(fly)) parts.push({ w: 0.2, x: clamp((fly - 1) / 1, -1, 1) });
    }
    if (!parts.length) return { ok: false, reason: 'no inputs' };
    const wSum = parts.reduce((a, p) => a + p.w, 0);
    const score = parts.reduce((a, p) => a + p.w * p.x, 0) / wSum;
    return { ok: true, score, verdict: score > 0.2 ? 'bid' : score < -0.2 ? 'offered' : 'balanced' };
  }

  // ---------------------------------------------------------------- cross-ticker vol-mispricing score

  function fin(v) { return v != null && isFinite(v); } // isFinite(null) is TRUE (null->0); guard explicitly

  /* Rank of how mispriced a name's implied vol is, on a scale that is FAIR across
   * a 14-vol index and a 60-vol single name. A vol-relative generalization of
   * convexityRead(): every raw vol-points input is divided by iv30 before
   * thresholding, so equal FRACTIONS of the vol level score alike — a +5pt premium
   * is rich on 14-vol SPX (0.36 of iv) but cheap on 60-vol TSLA (0.08 of iv).
   *
   * Signed score in [-1,1]: > 0 vol RICH (implied expensive vs realized/structure —
   * a sell-premium lean), < 0 vol CHEAP (own-convexity lean). Rank by |score|; the
   * sign is the lean. Gamma metrics never enter here — they are display-only by design.
   *
   * Signals (each present iff its raw input is finite; weights renormalize over the
   * present set exactly like convexityRead, so a missing optional input never drags
   * the score toward 0). Centers equal convexityRead's SPX thresholds converted to
   * fractions at iv=15, so at SPX-typical vol this agrees with the detail-page read.
   *   iv30      - VIX-style 30d implied vol, vol pts (the normalizer; required)
   *   vrp       - iv30 - rv21, vol pts   (w 0.45, primary)
   *   slope     - iv30 - iv7,  vol pts   (w 0.25, negative = backwardation = rich)
   *   fly       - 25d butterfly, vol pts (w 0.15, wing/tail richness)
   *   convScore - convexityRead().score in [-1,1] (w 0.15, low-weight corroborator;
   *               recomputed here from vrp/slope/fly when null)
   * Returns { ok:false, reason } or
   *   { ok:true, score, magnitude, direction:'rich'|'cheap'|'fair', coverage,
   *     confidence, rankable, signals:[{name,raw,frac,x,weight,contribution,fired}], topSignal } */
  function volMispricingScore({ iv30, vrp = null, slope = null, fly = null, convScore = null }) {
    if (!fin(iv30)) return { ok: false, reason: 'no vol data' };
    const IVf = Math.max(iv30, 1); // floor: single-digit iv would blow the fractions up

    // corroborator: derive convexityRead's own score if the caller did not pass
    // one — normalized by iv30, or the raw SPX-centered legacy read would leak
    // its high-vol 'bid' bias into this deliberately vol-fair rank
    if (!fin(convScore) && (fin(vrp) || fin(slope) || fin(fly))) {
      const cr = convexityRead({ vrp, slope, fly, iv30 });
      convScore = cr.ok ? cr.score : null;
    }

    const defs = [
      { name: 'vrp',   w: 0.45, raw: vrp,       frac: fin(vrp)   ? vrp / IVf   : null, x: fin(vrp)   ? clamp((vrp / IVf - 0.20) / 0.25, -1, 1)     : null },
      { name: 'slope', w: 0.25, raw: slope,     frac: fin(slope) ? slope / IVf : null, x: fin(slope) ? clamp(-(slope / IVf - 0.10) / 0.13, -1, 1) : null },
      { name: 'fly',   w: 0.15, raw: fly,       frac: fin(fly)   ? fly / IVf   : null, x: fin(fly)   ? clamp((fly / IVf - 0.07) / 0.07, -1, 1)     : null },
      { name: 'conv',  w: 0.15, raw: convScore, frac: null,                            x: fin(convScore) ? clamp(convScore, -1, 1)                 : null },
    ];

    const present = defs.filter((d) => d.x != null);
    const W = present.reduce((a, d) => a + d.w, 0);
    if (W === 0) return { ok: false, reason: 'no vol data' };

    const score = present.reduce((a, d) => a + d.w * d.x, 0) / W;
    const signals = present.map((d) => ({
      name: d.name, raw: d.raw, frac: d.frac, x: d.x, weight: d.w,
      contribution: (d.w / W) * d.x, // signed; sums to score
      fired: Math.abs(d.x) >= 0.5,   // notably off its typical band
    }));
    let topSignal = null, best = -Infinity;
    for (const s of signals) {
      const m = Math.abs(s.contribution);
      if (m > best) { best = m; topSignal = s.name; }
    }

    // conv is derived from vrp/slope/fly, so it inflates W but carries no new
    // information — rankability keys off the INDEPENDENT primary signals only.
    const hasVrp = present.some((d) => d.name === 'vrp');
    const nPrimary = present.filter((d) => d.name !== 'conv').length;
    const coverage = W; // raw present weight (incl. conv); SPX all-signals -> 1.0, a name missing fly -> 0.85
    return {
      ok: true, score, magnitude: Math.abs(score),
      direction: score >= 0.20 ? 'rich' : score <= -0.20 ? 'cheap' : 'fair',
      coverage,
      confidence: coverage * (hasVrp ? 1 : 0.85), // only the missing-realized-vol gap; tiebreak/gate, never a score multiplier
      rankable: hasVrp || nPrimary >= 2,           // a lone thin signal is a 'low-data' row, never tops the scan
      signals, topSignal,
    };
  }

  // ---------------------------------------------------------------- exports

  const GexMetrics = {
    clamp, normCdf, normPdf, bsPrice, bsDelta,
    expiryVariance, vixStyle, ivAtHorizon, realizedVol, smileAtExpiry, convexityRead,
    volMispricingScore,
  };
  root.GexMetrics = GexMetrics;
  if (typeof module !== 'undefined' && module.exports) module.exports = GexMetrics;

})(typeof globalThis !== 'undefined' ? globalThis : this);
