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
      // expiries settle end of day; approximate 4pm ET as 20:00 UTC
      const expiry = Date.UTC(2000 + +m[2], +m[3] - 1, +m[4], 20, 0, 0);
      if (expiry < now - 12 * 3600e3) continue;
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
    if (o.iv > 0.005) return bsGreeks(S, o.strike, o.T, o.iv);
    // no usable IV: fall back to the quoted gamma, skip vanna/charm
    const g = isFinite(o.gammaQuoted) ? o.gammaQuoted : 0;
    return { gamma: g, vanna: 0, charm: 0 };
  }

  function dealerSign(type) { return type === 'C' ? 1 : -1; } // long calls, short puts

  function computeMetrics(ch, maxDte) {
    const S = ch.spot;
    // exposure math wants open interest; zero-OI quoted options exist only for the vol calcs
    const opts = ch.options.filter((o) => o.oi > 0 && (maxDte === 'all' || o.dte <= +maxDte));

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
    const read = M.convexityRead({ vrp, slope, fly: smile ? smile.fly : null });

    return {
      ok: true,
      vix30: vix.value, method: vix.method, term: vix.term,
      iv7, slope, smile, rv, vrp,
      read: read.ok ? read : null,
    };
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
    const topStrikes = [...all.strikes]
      .sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex))
      .slice(0, 7)
      .map((r) => ({ strike: r.strike, net_gex_usd: Math.round(r.gex), call_oi: r.callOi, put_oi: r.putOi }));
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
        gamma_flip: r2(all.flip),
        vanna_flip: r2(all.vannaFlip),
        call_wall: all.callWall ? all.callWall.strike : null,
        put_wall: all.putWall ? all.putWall.strike : null,
        top_strikes_by_gex: topStrikes,
      },
      vol: volm && volm.ok ? {
        iv30_vix_style: r2(volm.vix30),
        vix_official: vixOfficial != null ? r2(vixOfficial) : null,
        rv21: r2(volm.rv),
        vrp: r2(volm.vrp),
        term_slope_30_7: r2(volm.slope),
        fly_25d: volm.smile ? r2(volm.smile.fly) : null,
        skew_25d: volm.smile ? r2(volm.smile.rr) : null,
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
    normPdf, bsGreeks, parseCboe, optionGreeks, dealerSign, computeMetrics, zeroCrossing,
    buildVolMetrics, buildSnapshot, scanRowFromChain,
  };
  root.GexExposure = GexExposure;
  if (typeof module !== 'undefined' && module.exports) module.exports = GexExposure;

})(typeof globalThis !== 'undefined' ? globalThis : this);
