'use strict';

/* GexExposure — dealer gamma/vanna/charm exposure math for the Personal GEX tools.
 *
 * The pure, DOM-free computational core that used to live inside app.js. It is
 * extracted here so BOTH the browser dashboard (app.js) AND the server-side
 * scanner (server.js) compute the exact same numbers from the exact same code —
 * a chain (a single SPX payload is ~13 MB) never has to cross the wire, and the
 * /api/analyze snapshot serializes identically no matter which side built it.
 *
 * Classic zero-dependency dual-load, same pattern as metrics.js: defines
 * globalThis.GexExposure for the browser and module.exports under a CommonJS
 * Function-shim (see exposure.test.js). It carries its own Black-Scholes so it
 * has NO hard dependency on metrics.js; the one function that needs the vol math
 * (buildVolMetrics) takes GexMetrics as an injected argument. No mutable module
 * state — safe to call concurrently from the server.
 *
 * Convention: dealers long calls, short puts (the classic naive GEX assumption). */

(function (root) {

  // ---------------------------------------------------------------- config
  const RISK_FREE = 0.04;          // flat risk-free rate for BS greeks
  const CONTRACT_SIZE = 100;
  const PROFILE_POINTS = 81;       // samples for the gamma-vs-spot profile
  const PROFILE_RANGE = 0.10;      // +/- 10% of spot
  const MS_YEAR = 365 * 24 * 3600 * 1000;

  // ---------------------------------------------------------------- black-scholes

  function normPdf(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  }

  // same Abramowitz-Stegun approximation GexMetrics.normCdf uses, duplicated
  // here so bsGreeks' delta stays dependency-free like the rest of this module.
  function normCdf(x) {
    if (x < 0) return 1 - normCdf(-x);
    const t = 1 / (1 + 0.2316419 * x);
    const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return 1 - normPdf(x) * poly;
  }

  /* Greeks shared by calls and puts (with zero dividend yield), plus delta
   * (which DOES differ by type — defaults to 'C' so existing call sites that
   * only want gamma/vanna/charm are unaffected):
   * gamma, vanna (dDelta/dVol, per 1.00 vol), charm (dDelta/dt, per year),
   * delta. */
  function bsGreeks(S, K, T, sigma, type = 'C') {
    const sqT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (RISK_FREE + 0.5 * sigma * sigma) * T) / (sigma * sqT);
    const d2 = d1 - sigma * sqT;
    const pdf = normPdf(d1);
    const gamma = pdf / (S * sigma * sqT);
    const vanna = -pdf * d2 / sigma;
    const charm = -pdf * (2 * RISK_FREE * T - d2 * sigma * sqT) / (2 * T * sigma * sqT);
    const delta = type === 'P' ? normCdf(d1) - 1 : normCdf(d1);
    return { gamma, vanna, charm, delta };
  }

  /* Third-order (and vol-convexity) greeks, split out from bsGreeks so the hot
   * 1st/2nd-order path stays lean — these are computed only by the 3rd-order
   * feasibility probe (and an opt-in mesh, if the probe clears them). Closed-form
   * Black-Scholes, zero dividend yield; same d1/d2 as bsGreeks:
   *   speed  = dGamma/dSpot           (d3V/dS3)
   *   color  = dGamma/dTimeToExpiry   (as maturity shrinks by dt, gamma moves by -color; per year)
   *   zomma  = dGamma/dVol            (per 1.00 vol)
   *   vomma  = dVega/dVol   (volga)   (per 1.00 vol)
   *   ultima = dVomma/dVol            (d3V/dSigma3, per 1.00 vol)
   *   vega   = dV/dVol                (per 1.00 vol; returned for exposure scaling) */
  function bsGreeks3(S, K, T, sigma) {
    const sqT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (RISK_FREE + 0.5 * sigma * sigma) * T) / (sigma * sqT);
    const d2 = d1 - sigma * sqT;
    const pdf = normPdf(d1);
    const gamma = pdf / (S * sigma * sqT);
    const vega = S * sqT * pdf;
    const speed = -gamma / S * (d1 / (sigma * sqT) + 1);
    const color = -pdf / (2 * S * T * sigma * sqT) * (1 + d1 * (2 * RISK_FREE * T - d2 * sigma * sqT) / (sigma * sqT));
    const zomma = gamma * (d1 * d2 - 1) / sigma;
    const vomma = vega * d1 * d2 / sigma;
    const ultima = -vega / (sigma * sigma) * (d1 * d2 * (1 - d1 * d2) + d1 * d1 + d2 * d2);
    return { speed, color, zomma, vomma, ultima, vega };
  }

  // ---------------------------------------------------------------- cboe parsing

  // e.g. "SPXW250702C06200000" -> root SPXW, 2025-07-02, Call, 6200
  const OCC_RE = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

  /* 4:00pm America/New_York on a given calendar date, as a UTC timestamp —
   * DST-aware without dependencies (EDT is 20:00 UTC, EST is 21:00 UTC). A
   * fixed 20:00 UTC stamp is an hour early all winter, which would mark live
   * 0DTE contracts as settled for the entire last hour of the session — the
   * exact window a short-term trader cares about most. Intl gives the real
   * offset for that date; memoized because parseCboe calls this per option row. */
  const NY_CLOSE_CACHE = new Map();
  function nyCloseUtc(y, mo, d) {
    const key = y * 10000 + mo * 100 + d;
    let close = NY_CLOSE_CACHE.get(key);
    if (close !== undefined) return close;
    let offset = -5;
    try {
      // noon UTC is mid-morning in New York, safely inside the same civil date
      const tz = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
        .formatToParts(Date.UTC(y, mo - 1, d, 12, 0, 0))
        .find((p) => p.type === 'timeZoneName');
      const m = /GMT([+-]\d+)/.exec(tz ? tz.value : '');
      if (m) offset = +m[1];
    } catch { /* no Intl/ICU: fall back to a rough DST-by-month approximation */
      if (mo >= 4 && mo <= 10) offset = -4;
    }
    close = Date.UTC(y, mo - 1, d, 16 - offset, 0, 0); // 4pm NY == (16 - offset):00 UTC
    NY_CLOSE_CACHE.set(key, close);
    return close;
  }

  // Settled contracts create no hedging need, but the delayed feed's quotes/OI
  // describe the world ~15 minutes ago — so a contract only drops out once it
  // has been settled longer than the feed delay. Anything younger would still
  // have been alive in the data we're actually looking at.
  const SETTLE_SLACK_MS = 15 * 60e3;

  /* Parse a CBOE (or CBOE-shaped) delayed-quotes payload into the internal chain
   * format app.js and the scanner both consume. `now` is injectable so tests are
   * deterministic (expiry cutoff + T floor depend on the clock). */
  function parseCboe(json, requestedSymbol, now = Date.now()) {
    const data = json && json.data;
    if (!data || !Array.isArray(data.options)) throw new Error('Unexpected CBOE payload shape');
    const spot = Number(data.current_price ?? data.close ?? data.last ?? NaN);
    if (!isFinite(spot) || spot <= 0) throw new Error('No spot price in CBOE payload');
    const options = [];
    for (const o of data.options) {
      const m = OCC_RE.exec(String(o.option || ''));
      if (!m) continue;
      // keep even zero-OI/zero-bid rows: the VIX-style calc prices OTM quotes
      // regardless of OI, and its stop rule needs to SEE the zero-bid strikes
      // (exposure math filters to oi > 0 downstream)
      const oi = Number(o.open_interest ?? o.oi ?? 0);
      // DST-aware 4pm-ET settlement; drop contracts settled longer than the
      // feed delay — an expired 0DTE priced at the 15-minute T floor otherwise
      // dwarfs the live book (gamma ~ 1/sqrt(T)) all evening and overnight
      const expiry = nyCloseUtc(2000 + +m[2], +m[3], +m[4]);
      if (expiry <= now - SETTLE_SLACK_MS) continue;
      options.push({
        root: m[1], // e.g. SPX vs SPXW — distinct settlement series
        type: m[5],
        strike: +m[6] / 1000,
        expiry,
        dte: Math.max(0, Math.ceil((expiry - now) / 86400e3)),
        T: Math.max((expiry - now) / MS_YEAR, 1 / (365 * 96)), // floor ~15 min
        oi,
        bid: Number(o.bid ?? 0),
        ask: Number(o.ask ?? 0),
        volume: Number(o.volume ?? 0),
        iv: Number(o.iv ?? 0),
        gammaQuoted: Number(o.gamma ?? NaN),
      });
    }
    if (!options.some((o) => o.oi > 0)) throw new Error('Chain parsed but contained no open interest');
    return {
      symbol: String(data.symbol || requestedSymbol).replace(/^_/, '').replace(/^\^/, ''),
      spot,
      timestamp: json.timestamp || new Date(now).toISOString(),
      source: json._source || 'CBOE delayed quotes',
      options,
    };
  }

  // ---------------------------------------------------------------- exposure math

  function optionGreeks(o, S) {
    if (o.iv > 0.005) return bsGreeks(S, o.strike, o.T, o.iv, o.type);
    // no usable IV: fall back to the quoted gamma, skip vanna/charm/delta
    // (CBOE's payload carries no quoted delta to fall back to)
    const g = isFinite(o.gammaQuoted) ? o.gammaQuoted : 0;
    return { gamma: g, vanna: 0, charm: 0, delta: 0 };
  }

  function dealerSign(type) { return type === 'C' ? 1 : -1; } // long calls, short puts

  /* minDte is optional (defaults unbounded below) so a single expiry band can
   * be metered in isolation — per-band walls/flip for the brain view. Existing
   * two-argument callers are unaffected. */
  function computeMetrics(ch, maxDte, minDte) {
    const S = ch.spot;
    const dteLo = minDte == null ? -Infinity : +minDte;
    // exposure math wants open interest; zero-OI quoted options exist only for the vol calcs
    const opts = ch.options.filter((o) => o.oi > 0 && (maxDte === 'all' || o.dte <= +maxDte) && o.dte >= dteLo);

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

    // a wall requires a genuine signal on its own side: a book with zero call
    // gamma has no call wall (routine for one-sided per-band slices — a
    // puts-only 0DTE book must not report its largest-put strike as a "call
    // wall" just because every candidate ties at zero)
    let callWall = null, putWall = null;
    for (const r of strikes) {
      if (r.callGex > 0 && (!callWall || r.callGex > callWall.callGex)) callWall = r;
      if (r.putGex < 0 && (!putWall || r.putGex < putWall.putGex)) putWall = r;
    }

    // gamma / vanna / charm profiles: net exposures recomputed at hypothetical spot levels
    const profile = [];
    const lo = S * (1 - PROFILE_RANGE), hi = S * (1 + PROFILE_RANGE);
    for (let i = 0; i < PROFILE_POINTS; i++) {
      const s = lo + (hi - lo) * (i / (PROFILE_POINTS - 1));
      let gex = 0, vex = 0, cex = 0;
      for (const o of opts) {
        const sign = dealerSign(o.type);
        if (o.iv > 0.005) {
          const g = bsGreeks(s, o.strike, o.T, o.iv);
          gex += sign * g.gamma * o.oi * CONTRACT_SIZE * s * s * 0.01;
          vex += sign * g.vanna * o.oi * CONTRACT_SIZE * s * 0.01;
          cex += sign * (g.charm / 365) * o.oi * CONTRACT_SIZE * s;
        } else if (isFinite(o.gammaQuoted)) {
          gex += sign * o.gammaQuoted * o.oi * CONTRACT_SIZE * s * s * 0.01;
        }
      }
      profile.push({ s, gex, vanna: vex, charm: cex });
    }

    return {
      spot: S, strikes, netGex, netVanna, netCharm, callWall, putWall, profile,
      flip: zeroCrossing(profile, 'gex', S),
      vannaFlip: zeroCrossing(profile, 'vanna', S),
      charmFlip: zeroCrossing(profile, 'charm', S),
      optionCount: opts.length,
    };
  }

  // sign change in a profile series closest to spot (null if none in range)
  function zeroCrossing(profile, key, S) {
    let flip = null, bestDist = Infinity;
    for (let i = 1; i < profile.length; i++) {
      const a = profile[i - 1][key], b = profile[i][key];
      if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) {
        const x = profile[i - 1].s + (profile[i].s - profile[i - 1].s) * (0 - a) / (b - a);
        const d = Math.abs(x - S);
        if (d < bestDist) { bestDist = d; flip = x; }
      }
    }
    return flip;
  }

  // ---------------------------------------------------------------- banded mesh (brain view)

  /* Default expiry bands for the 3D "brain" mesh: near-term structure (0DTE,
   * weekly) matters strike-by-strike; far-dated OI is sparse and coarser bands
   * are enough. dte is the same integer field parseCboe already computes. */
  const DEFAULT_MESH_BANDS = [
    { name: '0DTE', minDte: 0, maxDte: 1 },
    { name: 'Weekly', minDte: 2, maxDte: 7 },
    { name: 'Monthly', minDte: 8, maxDte: 45 },
    { name: 'LEAP', minDte: 46, maxDte: Infinity },
  ];

  // one dollar-exposure accumulator map per greek, all keyed by strike
  function zeroMap(strikes) {
    return new Map(strikes.map((s) => [s, 0]));
  }

  /* Strike x expiry-band net GEX/vanna/charm/delta grid for the brain-mesh
   * visualization — unlike computeMetrics (which collapses every expiry into
   * one row per strike), this keeps a strike's exposure separate per band so a
   * strike can be a gyrus at 0DTE and a sulcus at LEAP simultaneously, on any
   * of the four greeks. Strikes are restricted to +/- rangePct of spot
   * (matching the profile chart's default window) so a mesh isn't built from
   * thousands of illiquid deep OTM strikes. Pure given `chain`.
   *   delta is the one greek NOT under the dealer sign convention: dealer net
   *   delta (long calls, short puts) is positive at every strike by
   *   construction — a dead sign channel. Instead delta here is the
   *   IMBALANCE, sum of raw delta * OI (call delta positive, put delta
   *   negative): positive = the strike's directional OI is call-side, negative
   *   = put-side. No natural zero-crossing "flip" is derived from it. */
  function computeMeshBands(chain, bandDefs = DEFAULT_MESH_BANDS, rangePct = PROFILE_RANGE) {
    const S = chain.spot;
    const lo = S * (1 - rangePct), hi = S * (1 + rangePct);
    const strikeSet = new Set();
    for (const o of chain.options) {
      if (o.oi > 0 && o.strike >= lo && o.strike <= hi) strikeSet.add(o.strike);
    }
    const strikes = [...strikeSet].sort((a, b) => a - b);

    const bands = bandDefs.map((def) => {
      const gex = zeroMap(strikes), vanna = zeroMap(strikes), charm = zeroMap(strikes), delta = zeroMap(strikes);
      // speed = dGamma/dSpot (3rd-order). Only 'speed' passed the accuracy-pass
      // gate (gex/thirdorder-probe.js): color/ultima were too IV-noisy to draw.
      // Expressed as the change in this strike's dollar-GEX for the NEXT +1%
      // spot move, from gamma's own curvature: d(dollar-gamma)/dS * (S*0.01) =
      // speed * S^2 * 0.01 * S * 0.01 = speed * S^3 * 1e-4 PER SHARE, then
      // weighted by OI * CONTRACT_SIZE exactly like the gamma line above.
      // Positive => dealer gamma here builds as spot rises (pin strengthening).
      const speed = zeroMap(strikes);
      for (const o of chain.options) {
        if (o.oi <= 0 || !gex.has(o.strike)) continue;
        if (o.dte < def.minDte || o.dte > def.maxDte) continue;
        const gk = optionGreeks(o, S);
        const sign = dealerSign(o.type);
        const strike = o.strike;
        gex.set(strike, gex.get(strike) + sign * gk.gamma * o.oi * CONTRACT_SIZE * S * S * 0.01);
        vanna.set(strike, vanna.get(strike) + sign * gk.vanna * o.oi * CONTRACT_SIZE * S * 0.01);
        charm.set(strike, charm.get(strike) + sign * (gk.charm / 365) * o.oi * CONTRACT_SIZE * S);
        // no dealer sign: raw delta*OI so calls push positive, puts negative (imbalance)
        delta.set(strike, delta.get(strike) + gk.delta * o.oi * CONTRACT_SIZE * S);
        // speed needs the same usable-IV guard optionGreeks uses (bsGreeks3
        // divides by sigma); a quoted-only contract contributes 0 rather than a blowup
        if (o.iv > 0.005) {
          const g3 = bsGreeks3(S, o.strike, o.T, o.iv);
          speed.set(strike, speed.get(strike) + sign * g3.speed * o.oi * CONTRACT_SIZE * S * S * S * 1e-4);
        }
      }
      return {
        name: def.name,
        gex: strikes.map((s) => gex.get(s)),
        vanna: strikes.map((s) => vanna.get(s)),
        charm: strikes.map((s) => charm.get(s)),
        delta: strikes.map((s) => delta.get(s)),
        speed: strikes.map((s) => speed.get(s)),
      };
    });

    return { strikes, bands };
  }

  /* Per-band landmark levels: walls, flip, and net GEX computed from ONLY the
   * options inside each expiry band — the honest counterpart to the all-expiry
   * aggregates. On expiry days the gap between the 0DTE flip and the aggregate
   * flip is exactly what a short-term trader wants to see. Bands with no open
   * interest return null walls/flip and optionCount 0 so the UI can skip them
   * rather than draw a landmark that doesn't exist. */
  function computeBandLandmarks(chain, bandDefs = DEFAULT_MESH_BANDS) {
    return bandDefs.map((def) => {
      const m = computeMetrics(chain, def.maxDte === Infinity ? 'all' : def.maxDte, def.minDte);
      return {
        name: def.name,
        netGex: m.netGex,
        callWall: m.callWall ? m.callWall.strike : null,
        putWall: m.putWall ? m.putWall.strike : null,
        flip: m.flip,
        optionCount: m.optionCount,
      };
    });
  }

  // ---------------------------------------------------------------- volatility & convexity

  /* De-globalized computeVolMetrics: chain-level VIX-style implied vol, term
   * structure, realized vol, ~30d smile, and the convexity read. All the heavy
   * math lives in metrics.js, injected as M (so this module stays dependency-free).
   *   chain  - parsed chain from parseCboe (or app.js/demo)
   *   closes - array of daily closes oldest->newest for realized vol (may be empty)
   *   M      - the GexMetrics object; null => { ok:false } so the vol card degrades
   * Returns null when chain is missing, else the same volm object app.js used. */
  function buildVolMetrics(chain, closes, M, r = RISK_FREE) {
    if (!chain) return null;
    if (!M) return { ok: false, reason: 'metrics.js not loaded' };

    const vix = M.vixStyle(chain.options, r);
    if (!vix.ok) return { ok: false, reason: vix.reason };
    // 30d-minus-7d slope only when the curve genuinely spans both horizons —
    // with a single usable expiry the clamped interpolation would fabricate 0,
    // which convexityRead would misread as backwardation
    const spans = vix.term[0].days <= 12 && vix.term[vix.term.length - 1].days >= 25;
    const iv7 = spans ? M.ivAtHorizon(vix.term, 7) : null;
    const slope = spans ? vix.value - iv7 : null;

    // smile at the usable expiry nearest 30 days (same settlement series only)
    let smile = null;
    const entry = vix.term
      .filter((t) => t.n >= 8)
      .reduce((a, b) => (!a || Math.abs(b.days - 30) < Math.abs(a.days - 30) ? b : a), null);
    if (entry) {
      const ofExp = chain.options.filter((o) => o.expiry === entry.expiry && (o.root || '') === (entry.root || ''));
      const s = M.smileAtExpiry(ofExp, chain.spot, entry.F, entry.T, r);
      if (s.ok) smile = { ...s, days: entry.days };
    }

    const rvRes = M.realizedVol(closes ?? [], 21);
    const rv = rvRes.ok ? rvRes.value : null;
    const vrp = rv == null ? null : vix.value - rv;
    // iv30 normalizes the read so it's fair across vol levels (quant review:
    // the raw SPX-centered variant overstated 'bid' on high-vol single names)
    const read = M.convexityRead({ vrp, slope, fly: smile ? smile.fly : null, iv30: vix.value });

    return {
      ok: true,
      vix30: vix.value, method: vix.method, term: vix.term,
      iv7, slope, smile, rv, vrp,
      read: read.ok ? read : null,
    };
  }

  // ---------------------------------------------------------------- iv smile curve

  /* Full IV-vs-strike smile at the usable expiry nearest targetDays, built from
   * OTM quotes only (puts below spot, calls above — the liquid side of every
   * strike, the standard smile construction). This is the SHAPE the wings
   * summarize: smileAtExpiry gives 25d/10d points, this gives the whole curve
   * for rendering. Pure given `chain`; no metrics.js dependency.
   * Returns { ok:false, reason } or
   *   { ok:true, days, spot, points: [{ k, iv }] } with iv in vol points,
   *   points sorted by strike, downsampled evenly but always keeping both
   *   wing ends (the tails are the point of a smile chart). */
  function smileCurve(chain, { targetDays = 30, rangePct = 0.15, maxPoints = 36, minQuotes = 8 } = {}) {
    if (!chain || !chain.options || !chain.options.length) return { ok: false, reason: 'no chain' };
    const S = chain.spot;
    const lo = S * (1 - rangePct), hi = S * (1 + rangePct);
    // candidate expiries: same expiry+root series (mixing settlement series
    // would kink the curve), OTM side only, usable IV, near-the-money window
    const byExp = new Map();
    for (const o of chain.options) {
      if (!(o.iv > 0.005) || o.strike < lo || o.strike > hi) continue;
      if (o.type === 'P' ? o.strike > S : o.strike < S) continue; // OTM side only
      const key = `${o.expiry}|${o.root || ''}`;
      let arr = byExp.get(key);
      if (!arr) byExp.set(key, arr = []);
      arr.push(o);
    }
    let best = null;
    for (const arr of byExp.values()) {
      if (arr.length < minQuotes) continue;
      const days = arr[0].dte;
      if (!best || Math.abs(days - targetDays) < Math.abs(best.days - targetDays)) best = { days, arr };
    }
    if (!best) return { ok: false, reason: 'no expiry with enough OTM quotes' };
    // one point per strike (average the rare duplicate quote), sorted
    const byK = new Map();
    for (const o of best.arr) {
      const cur = byK.get(o.strike) || { sum: 0, n: 0 };
      cur.sum += o.iv; cur.n++;
      byK.set(o.strike, cur);
    }
    let points = [...byK.entries()]
      .map(([k, v]) => ({ k, iv: 100 * (v.sum / v.n) }))
      .sort((a, b) => a.k - b.k);
    // junk-quote rejection: a single rogue IV (Tradier/ORATS occasionally quotes
    // a deep strike at several HUNDRED vol) would blow the y-scale and flatten
    // the real curve to a line. Points beyond 4x / below 1/4 of the curve's
    // median are feed noise, not smile — a genuinely steep tail (~2x median)
    // survives comfortably.
    if (points.length >= 4) {
      const sortedIv = points.map((p) => p.iv).sort((a, b) => a - b);
      const med = sortedIv[Math.floor(sortedIv.length / 2)];
      if (med > 0) points = points.filter((p) => p.iv <= 4 * med && p.iv >= med / 4);
    }
    if (points.length < minQuotes) return { ok: false, reason: 'too few sane quotes after outlier rejection' };
    // a smile needs BOTH wings: a one-sided curve (calls with dead IV on a
    // beaten-down name, say) would render put-only data with call-wing colors
    // and fabricate a two-sided skew number — refuse it honestly instead
    const below = points.filter((p) => p.k < S).length;
    const above = points.filter((p) => p.k > S).length;
    if (below < 3 || above < 3) return { ok: false, reason: 'one-sided chain — smile needs both wings' };
    if (points.length > maxPoints) {
      const step = (points.length - 1) / (maxPoints - 1);
      const picked = [];
      for (let i = 0; i < maxPoints; i++) picked.push(points[Math.round(i * step)]);
      points = picked; // endpoints survive by construction (i=0 and i=maxPoints-1)
    }
    return { ok: true, days: Math.round(best.days), spot: S, points };
  }

  // ---------------------------------------------------------------- ai-read snapshot

  /* Compact numeric snapshot of everything the dashboard computed — the AI read's
   * entire world, and the scanner's per-ticker payload for /api/analyze. Numbers
   * only (strings are labels), rounded so identical market states serialize
   * identically and hit the server's response cache. Pure: given the same chain,
   * volm, and the two client scalars it produces byte-identical JSON whether the
   * browser or the server builds it (that identity is what makes the cache key match).
   *   chain       - parsed chain
   *   volm        - buildVolMetrics() result (may be null / {ok:false})
   *   vixOfficial - live/delayed VIX level for reference, or null
   *   chg5d       - RAW 5-day percent change (r2 is applied here, once), or null */
  function buildSnapshot(chain, volm, { vixOfficial = null, chg5d = null } = {}) {
    if (!chain) return null;
    const all = computeMetrics(chain, 'all');
    const week = computeMetrics(chain, '7');
    const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
    // per-strike rows carry gex AND vanna/charm — surface all three so the AI
    // read can see WHERE vol-sensitivity and decay flow concentrate, not just
    // the aggregate nets (a read that ignores the vanna/charm curves is blind
    // to half the hedging mechanics)
    const topStrikes = [...all.strikes]
      .sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex))
      .slice(0, 7)
      .map((r) => ({
        strike: r.strike, net_gex_usd: Math.round(r.gex),
        net_vanna_usd: Math.round(r.vanna), net_charm_usd: Math.round(r.charm),
        call_oi: r.callOi, put_oi: r.putOi,
      }));
    // vanna concentration can sit at strikes that aren't gamma-heavy (far OTM
    // hedges) — list the top-|vanna| strikes separately so they're never hidden
    const topVanna = [...all.strikes]
      .sort((a, b) => Math.abs(b.vanna) - Math.abs(a.vanna))
      .slice(0, 5)
      .map((r) => ({ strike: r.strike, net_vanna_usd: Math.round(r.vanna), net_charm_usd: Math.round(r.charm) }));
    // tradeability hints for the AI read: without these the model can only name
    // the handful of top-strike levels, which structurally forces WIDE spreads
    // (quant review: a 5-wide SPX spread fits a small account where the 25-wide
    // between two walls does not). strike_increment = the local listed grid step
    // near spot; listed_dte = real expiries to anchor legs/timeframes to.
    const nearStrikes = all.strikes.map((r) => r.strike)
      .filter((k) => Math.abs(k - chain.spot) / chain.spot <= 0.05)
      .sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < nearStrikes.length; i++) {
      const g = +(nearStrikes[i] - nearStrikes[i - 1]).toFixed(4);
      if (g > 0) gaps.push(g);
    }
    gaps.sort((a, b) => a - b);
    const strikeIncrement = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
    const listedDte = [...new Set(chain.options.map((o) => o.dte))].sort((a, b) => a - b).slice(0, 8);
    return {
      kind: 'gex-dashboard-snapshot',
      symbol: chain.symbol,
      spot: r2(chain.spot),
      asof: chain.timestamp,
      source: chain.source,
      exposures: {
        net_gex_all_usd: Math.round(all.netGex),
        net_gex_1w_usd: Math.round(week.netGex),
        net_vanna_usd_per_volpt: Math.round(all.netVanna),
        net_charm_usd_per_day: Math.round(all.netCharm),
        // near-dated (<=7 DTE) vanna/charm — decay flow concentrates in the
        // front week, so the 1w slice is often the tradeable part of the signal
        net_vanna_1w_usd_per_volpt: Math.round(week.netVanna),
        net_charm_1w_usd_per_day: Math.round(week.netCharm),
        gamma_flip: r2(all.flip),
        vanna_flip: r2(all.vannaFlip),
        charm_flip: r2(all.charmFlip),
        call_wall: all.callWall ? all.callWall.strike : null,
        put_wall: all.putWall ? all.putWall.strike : null,
        top_strikes_by_gex: topStrikes,
        top_strikes_by_vanna: topVanna,
      },
      // tradeability: the listed strike grid step near spot and the real listed
      // expiries (days) — structure legs must land on these, not invented levels
      strike_increment: strikeIncrement,
      listed_dte: listedDte,
      vol: volm && volm.ok ? {
        iv30_vix_style: r2(volm.vix30),
        vix_official: vixOfficial != null ? r2(vixOfficial) : null,
        rv21: r2(volm.rv),
        vrp: r2(volm.vrp),
        term_slope_30_7: r2(volm.slope),
        fly_25d: volm.smile ? r2(volm.smile.fly) : null,
        skew_25d: volm.smile ? r2(volm.smile.rr) : null,
        // the expiry the smile was actually measured at — sparse chains can push
        // it far from 30d, and 30d-calibrated fly/skew thresholds don't transfer
        smile_days: volm.smile ? Math.round(volm.smile.days) : null,
        // the smile SHAPE, not just its summary stats: the wing IVs let the
        // read see where skew steepens (body vs 25d vs 10d tail) instead of
        // inferring shape from one rr number; 10d tails are null on chains too
        // sparse to reach them
        smile_atm_iv: volm.smile ? r2(volm.smile.atm) : null,
        smile_put25_iv: volm.smile ? r2(volm.smile.put25) : null,
        smile_call25_iv: volm.smile ? r2(volm.smile.call25) : null,
        smile_put10_iv: volm.smile && volm.smile.put10 != null ? r2(volm.smile.put10) : null,
        smile_call10_iv: volm.smile && volm.smile.call10 != null ? r2(volm.smile.call10) : null,
        term_structure: volm.term.filter((t) => t.days <= 130)
          .map((t) => ({ days: Math.round(t.days), iv: r2(t.iv) })),
        convexity_verdict: volm.read ? volm.read.verdict : null,
        convexity_score: volm.read ? r2(volm.read.score) : null,
      } : null,
      price_change_5d_pct: r2(chg5d),
    };
  }

  // ---------------------------------------------------------------- scan row

  /* Assemble ONE compact scan row from an already-parsed chain — the single
   * source of truth shared by the server's /api/scan/row endpoint (which parses
   * a fetched chain first) and the browser's offline Demo scan (which builds a
   * synthetic chain). Pure: exposures + vol metrics + the vol-mispricing score +
   * the reusable /api/analyze snapshot. Gamma metrics ride along as display
   * context and never enter the rank (that is the whole product premise).
   *   chain       - parsed chain from parseCboe (or a synthetic one)
   *   closes      - daily closes oldest->newest for realized vol (may be empty)
   *   M           - the GexMetrics object (needs volMispricingScore + vol math)
   *   vixOfficial - reference VIX level or null; source - a label or null */
  function scanRowFromChain(chain, closes, M, { vixOfficial = null, source = null } = {}) {
    closes = (closes || []).filter((c) => isFinite(c) && c > 0);
    const m = computeMetrics(chain, 'all');
    const volm = buildVolMetrics(chain, closes, M);
    const score = volm && volm.ok && M
      ? M.volMispricingScore({
          iv30: volm.vix30, vrp: volm.vrp, slope: volm.slope,
          fly: volm.smile ? volm.smile.fly : null,
          convScore: volm.read ? volm.read.score : null,
        })
      : { ok: false, reason: (volm && volm.reason) || 'no vol data' };

    const spot = chain.spot;
    const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
    const pct = (level) => (level != null && isFinite(level) ? r2(((level - spot) / spot) * 100) : null);
    const chg5d = closes.length >= 6 ? (closes[closes.length - 1] / closes[closes.length - 6] - 1) * 100 : null;

    return {
      symbol: chain.symbol,
      ok: true,
      source: source || chain.source,
      asof: chain.timestamp,
      spot: r2(spot),
      // --- vol-mispricing rank (the ONLY thing that sorts the scan) ---
      score: score.ok ? r2(score.score) : null,
      magnitude: score.ok ? r2(score.magnitude) : null,
      direction: score.ok ? score.direction : null,
      coverage: score.ok ? r2(score.coverage) : null,
      confidence: score.ok ? r2(score.confidence) : null,
      rankable: score.ok ? score.rankable : false,
      topSignal: score.ok ? score.topSignal : null,
      signals: score.ok
        ? score.signals.map((s) => ({ name: s.name, x: r2(s.x), raw: r2(s.raw), contribution: r2(s.contribution), fired: s.fired }))
        : [],
      // --- vol context columns ---
      vol: volm && volm.ok ? {
        iv30: r2(volm.vix30), rv21: r2(volm.rv), vrp: r2(volm.vrp), vix_official: r2(vixOfficial),
        slope: r2(volm.slope), fly: volm.smile ? r2(volm.smile.fly) : null, skew: volm.smile ? r2(volm.smile.rr) : null,
        convexity: volm.read ? volm.read.verdict : null,
      } : null,
      // --- gamma context columns (display only; excluded from the rank) ---
      gamma: {
        net_gex: Math.round(m.netGex),
        regime: m.netGex >= 0 ? 'positive' : 'negative',
        call_wall: m.callWall ? m.callWall.strike : null,
        put_wall: m.putWall ? m.putWall.strike : null,
        flip: r2(m.flip),
        flip_pct: pct(m.flip),
        call_wall_pct: pct(m.callWall ? m.callWall.strike : null),
        put_wall_pct: pct(m.putWall ? m.putWall.strike : null),
      },
      change_5d_pct: r2(chg5d),
      data_flags: {
        no_vol: !(volm && volm.ok),
        no_realized: !(volm && volm.ok && volm.vrp != null),
        low_data: score.ok ? !score.rankable : true,
      },
      snapshot: buildSnapshot(chain, volm, { vixOfficial, chg5d }),
    };
  }

  // ---------------------------------------------------------------- exports

  const GexExposure = {
    RISK_FREE, CONTRACT_SIZE, PROFILE_POINTS, PROFILE_RANGE, MS_YEAR,
    normPdf, bsGreeks, bsGreeks3, parseCboe, optionGreeks, dealerSign, computeMetrics, zeroCrossing,
    buildVolMetrics, buildSnapshot, scanRowFromChain, smileCurve,
    DEFAULT_MESH_BANDS, computeMeshBands, computeBandLandmarks, nyCloseUtc,
  };
  root.GexExposure = GexExposure;
  if (typeof module !== 'undefined' && module.exports) module.exports = GexExposure;

})(typeof globalThis !== 'undefined' ? globalThis : this);
