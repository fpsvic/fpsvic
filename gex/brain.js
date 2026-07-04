'use strict';

/* GEX Brain — a 3D gamma mesh: nested expiry shells (0DTE/Weekly/Monthly/LEAP),
 * each a ring of strikes wrapped around a hemisphere. Gamma sign/magnitude
 * deforms the surface: positive (call-side, dealer-stabilizing) bulges outward
 * as a "gyrus", negative (put-side, destabilizing) folds inward as a "sulcus".
 *
 * Data comes from GET /api/brain?symbol=SYM (server.js, backed by
 * GexExposure.computeMeshBands) on a polling interval — the underlying app has
 * no snapshot playback yet, so "recently changed" nodes get a transient pulse
 * (diffed against the previous poll) as a live-only stand-in for real history.
 *
 * Rendering is plain Canvas 2D with a hand-rolled rotation/perspective
 * projection — no WebGL library. The pipeline is built to sit open all day
 * next to an execution platform without pinning a core:
 *
 *   - RENDER ON DEMAND. Nothing redraws unless something changed: a drag/zoom,
 *     a new snapshot, a greek switch, the focus toggle, or an active pulse
 *     animation. Idle cost is zero — no requestAnimationFrame loop runs.
 *   - SPRITES, NOT SHADOWS. Node/satellite glows are pre-rendered radial-
 *     gradient sprites drawn with drawImage. canvas shadowBlur is ruinously
 *     expensive per call (~2,500 shadowed draws/frame before); it survives
 *     only on the ≤4 landmark beams.
 *   - BATCHED EDGES. Edge strokes are grouped into a handful of color buckets
 *     (one beginPath/stroke per bucket instead of ~2,500 individual strokes).
 *     Bucketing gives up per-segment z-order BETWEEN edges, which is invisible
 *     at their alpha; nodes still draw over edges in proper depth order.
 *   - PROJECTION REUSE. Camera-dependent math (project + depth sort) runs only
 *     when the camera or scene actually changed; edges/satellites reuse the
 *     node projections instead of re-projecting endpoints. */

(function () {
  var canvas = document.getElementById('stage');
  var ctx = canvas.getContext('2d');
  var DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

  function resize() {
    // re-read DPR: the window may have moved to a different-density monitor
    DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.floor(window.innerWidth * DPR);
    canvas.height = Math.floor(window.innerHeight * DPR);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    cameraDirty = true;
    requestRender();
  }
  window.addEventListener('resize', resize);

  var statusEl = document.getElementById('status');
  var bannerEl = document.getElementById('banner');
  var regimeEl = document.getElementById('regime');
  function setStatus(msg, isErr) {
    statusEl.textContent = msg;
    statusEl.className = isErr ? 'err' : '';
  }
  function banner(msg) {
    if (!msg) { bannerEl.className = ''; bannerEl.textContent = ''; return; }
    bannerEl.className = 'show';
    bannerEl.textContent = msg;
  }

  // ---------------------------------------------------------------- geometry
  var THETA_SPAN = 250 * Math.PI / 180; // front-hemisphere arc
  var BAND_META = {
    '0DTE': { radius: 110, phi: -30 * Math.PI / 180, tilt: 0 },
    'Weekly': { radius: 158, phi: -10 * Math.PI / 180, tilt: 6 },
    'Monthly': { radius: 206, phi: 10 * Math.PI / 180, tilt: 12 },
    'LEAP': { radius: 254, phi: 30 * Math.PI / 180, tilt: 18 },
  };
  var BUMP_SCALE = 34; // fraction of shell radius a fully-normalized (|g|=1) node bulges

  // Per-greek presentation: which array on each band to read, the legend/
  // readout copy, and which landmark flip (if any) applies. All four greeks
  // are fetched every poll (server sends all of them), so switching here is
  // just a re-render — no refetch.
  var GREEK_META = {
    gamma: {
      key: 'gex', subLabel: 'gamma', short: 'Gamma', angle: 0, dotColor: [53, 214, 176],
      posWord: 'Gyrus', posDesc: '(bulge out) — call-side gamma, dealer-stabilizing',
      negWord: 'Sulcus', negDesc: '(fold in) — put-side gamma, dealer-destabilizing',
      flipField: 'flip', flipWord: 'Flip beam', flipDesc: '— zero-gamma crossing, all expiries',
      netLabel: 'Net GEX', netField: 'netGex', flipLabel: 'Gamma flip',
    },
    vanna: {
      key: 'vanna', subLabel: 'vanna', short: 'Vanna', angle: 90, dotColor: [90, 160, 255],
      posWord: 'Gyrus', posDesc: '(bulge out) — positive vanna, delta rises as vol rises',
      negWord: 'Sulcus', negDesc: '(fold in) — negative vanna, delta falls as vol rises',
      flipField: 'vannaFlip', flipWord: 'Flip beam', flipDesc: '— zero-vanna crossing, all expiries',
      netLabel: 'Net Vanna', netField: 'netVanna', flipLabel: 'Vanna flip',
    },
    charm: {
      key: 'charm', subLabel: 'charm', short: 'Charm', angle: 180, dotColor: [255, 196, 80],
      posWord: 'Gyrus', posDesc: '(bulge out) — positive charm: book delta builds daily, dealers sell to re-hedge',
      negWord: 'Sulcus', negDesc: '(fold in) — negative charm: book delta bleeds daily, dealers buy to re-hedge',
      flipField: 'charmFlip', flipWord: 'Flip beam', flipDesc: '— zero-charm crossing, all expiries',
      netLabel: 'Net Charm', netField: 'netCharm', flipLabel: 'Charm flip',
    },
    delta: {
      key: 'delta', subLabel: 'delta', short: 'Delta', angle: 270, dotColor: [255, 110, 180],
      posWord: 'Gyrus', posDesc: '(bulge out) — call-side delta OI dominates this strike/expiry',
      negWord: 'Sulcus', negDesc: '(fold in) — put-side delta OI dominates (dealers long via short puts)',
      flipField: null, flipWord: null, flipDesc: null,
      netLabel: 'Net Δ imbalance', netField: 'netDelta', flipLabel: null,
    },
  };
  var GREEK_ORDER = ['gamma', 'vanna', 'charm', 'delta']; // fixed synapse angle slots, stable across primary switches
  var activeGreek = 'gamma';
  var SATELLITE_THRESHOLD = 0.08; // |normalized value| below this doesn't draw a synapse (keeps quiet strikes clean)

  var CALL_RGB = [53, 214, 176], PUT_RGB = [255, 122, 82];

  // ---------------------------------------------------------------- glow sprites
  // A sprite is a small offscreen canvas holding a pre-rendered glow dot (or
  // hollow ring): solid core, radial falloff to transparent at 4x the core
  // radius. Drawing one is a single drawImage — the whole point is never to
  // touch ctx.shadowBlur in the per-node hot path. Alpha is quantized to ten
  // buckets so the cache stays tiny (a few dozen sprites, built lazily).
  var SPRITE = 64, CORE = 8, RING = 20; // sprite px, filled core radius, hollow ring radius
  var spriteCache = new Map();
  function spriteFor(rgb, alpha, hollow) {
    var bucket = Math.max(1, Math.min(10, Math.round(alpha * 10)));
    var key = rgb[0] + ',' + rgb[1] + ',' + rgb[2] + (hollow ? 'h' : 'f') + bucket;
    var s = spriteCache.get(key);
    if (s) return s;
    var a = bucket / 10;
    var c = document.createElement('canvas');
    c.width = SPRITE; c.height = SPRITE;
    var g = c.getContext('2d');
    var mid = SPRITE / 2;
    if (hollow) {
      // soft halo + a crisp ring with a genuinely transparent center
      var halo = g.createRadialGradient(mid, mid, RING * 0.5, mid, mid, mid);
      halo.addColorStop(0, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0)');
      halo.addColorStop(0.45, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (a * 0.28).toFixed(3) + ')');
      halo.addColorStop(1, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0)');
      g.fillStyle = halo;
      g.fillRect(0, 0, SPRITE, SPRITE);
      g.beginPath();
      g.strokeStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a.toFixed(3) + ')';
      g.lineWidth = 12; // thick in sprite space: scaled draws must keep the ring above a device pixel
      g.arc(mid, mid, RING, 0, Math.PI * 2);
      g.stroke();
    } else {
      var grad = g.createRadialGradient(mid, mid, 0, mid, mid, mid);
      grad.addColorStop(0, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a.toFixed(3) + ')');
      grad.addColorStop(CORE / mid, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a.toFixed(3) + ')');
      grad.addColorStop(0.55, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (a * 0.22).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, SPRITE, SPRITE);
    }
    spriteCache.set(key, s = c);
    return s;
  }
  var PULSE_SPRITE = null; // white flash overlay for recently-changed nodes
  function pulseSprite() {
    if (PULSE_SPRITE) return PULSE_SPRITE;
    return (PULSE_SPRITE = spriteFor([244, 247, 250], 1, false));
  }
  // filled sprites: core radius CORE maps to node radius r -> draw width r/CORE*SPRITE
  var FILL_DRAW = SPRITE / CORE;   // 8x the node radius
  var RING_DRAW = SPRITE / RING;   // 3.2x the dot radius

  // ---------------------------------------------------------------- scene
  // Mutable scene state, rebuilt whenever a new snapshot lands OR the active
  // greek changes. applyDerived() re-annotates it (cheap) whenever the
  // near-term-focus toggle flips — emphasis never forces a full rebuild.
  var scene = null;
  var lastPayload = null;
  // greekKey -> Map("band_strike" -> RAW value) — the diff-glow baseline.
  // Raw (not normalized) so a spike at one strike shifting the global max
  // can't fake "changes" mesh-wide; reset whenever the symbol changes so two
  // symbols with overlapping strike grids never diff against each other; and
  // refreshed for ALL four greeks on every poll (refreshBaselines) so a greek
  // switch hours later doesn't diff against an ancient baseline.
  var prevValues = {};

  function buildScene(payload, greekKey) {
    var strikes = payload.strikes;
    var bands = payload.bands;
    if (!strikes.length || !bands.length) return null;

    var arrKey = GREEK_META[greekKey].key; // e.g. 'gamma' -> 'gex', the array field on each band
    var maxAbs = 1e-9;
    bands.forEach(function (b) { b[arrKey].forEach(function (v) { maxAbs = Math.max(maxAbs, Math.abs(v)); }); });

    // secondary (synapse) greeks: the other three, each normalized against ITS
    // OWN global max across the mesh — same idea as the primary, so a quiet
    // greek doesn't look loud just because a busy one shares its scale.
    var secondaryKeys = GREEK_ORDER.filter(function (k) { return k !== greekKey; });
    var secMaxAbs = {};
    secondaryKeys.forEach(function (k) {
      var ak = GREEK_META[k].key;
      var m = 1e-9;
      bands.forEach(function (b) { b[ak].forEach(function (v) { m = Math.max(m, Math.abs(v)); }); });
      secMaxAbs[k] = m;
    });

    var prevForGreek = prevValues[greekKey] || new Map();
    var nodes = [];
    var nodeGrid = {};    // band_INDEX -> node: build-internal (edges), index-stable within one scene
    var nodeByPrice = {}; // band_STRIKE -> node: cross-poll identity (hover/pin), strike prices survive window shifts
    var nextValues = new Map();
    var maxPulse = 0;

    bands.forEach(function (band) {
      var meta = BAND_META[band.name] || { radius: 200, phi: 0, tilt: 0 };
      band[arrKey].forEach(function (raw, si) {
        var g = raw / maxAbs; // normalize to roughly [-1, 1] across the whole mesh, for THIS greek
        var key = band.name + '_' + strikes[si];
        // diff RAW values against the baseline, scaled by the CURRENT max —
        // only this strike's own exposure moving can fire its pulse
        var prior = prevForGreek.has(key) ? prevForGreek.get(key) : raw;
        var diff = Math.abs(raw - prior) / maxAbs;
        var pulseAmt = diff > 0.03 ? Math.min(1, diff * 4) : 0;
        if (pulseAmt > maxPulse) maxPulse = pulseAmt;
        nextValues.set(key, raw);

        var theta = (si / Math.max(1, strikes.length - 1) - 0.5) * THETA_SPAN;
        var bump = g * BUMP_SCALE;
        var r = meta.radius + bump;
        var satellites = secondaryKeys.map(function (k) {
          var gm = GREEK_META[k];
          var norm = band[gm.key][si] / secMaxAbs[k];
          var mag = Math.min(1, Math.abs(norm));
          var ang = gm.angle * Math.PI / 180;
          return {
            key: k, norm: norm, mag: mag,
            show: Math.abs(norm) >= SATELLITE_THRESHOLD,
            cosA: Math.cos(ang), sinA: Math.sin(ang),
            baseOrbit: 4 + mag * 11,
            baseDot: 1.1 + mag * 1.1,
            hollow: norm < 0,
            rgb: gm.dotColor,
            // filled per applyDerived(): sprite, spokeColor
            sprite: null, spokeColor: '',
            sx: 0, sy: 0, // per-frame scratch (spoke pass caches for the dot pass)
          };
        });
        var node = {
          x: r * Math.cos(meta.phi) * Math.sin(theta),
          y: r * Math.sin(meta.phi) - meta.tilt,
          z: r * Math.cos(meta.phi) * Math.cos(theta),
          band: band.name, si: si, strike: strikes[si], g: g, raw: raw,
          gMag: Math.min(1, Math.abs(g)),
          // all four raw dollar exposures, for the inspect tooltip
          raws: { gamma: band.gex[si], vanna: band.vanna[si], charm: band.charm[si], delta: band.delta[si] },
          pulseAmt: pulseAmt,
          satellites: satellites,
          // filled per applyDerived(): emph, drawBase, sprite
          emph: 1, drawBase: 0, sprite: null,
          // per-camera-pass scratch: projected position + perspective factor
          px: 0, py: 0, pz: 0, pk: 1,
        };
        nodes.push(node);
        nodeGrid[band.name + '_' + si] = node;
        nodeByPrice[band.name + '_' + strikes[si]] = node;
      });
    });
    prevValues[greekKey] = nextValues;

    var bandNames = bands.map(function (b) { return b.name; });
    var ringEdges = [];
    bandNames.forEach(function (bn) {
      for (var si = 0; si < strikes.length - 1; si++) {
        var a = nodeGrid[bn + '_' + si], b = nodeGrid[bn + '_' + (si + 1)];
        if (a && b) ringEdges.push([a, b]);
      }
    });
    var radialEdges = [];
    for (var si2 = 0; si2 < strikes.length; si2 += 3) {
      for (var bi = 0; bi < bandNames.length - 1; bi++) {
        var a2 = nodeGrid[bandNames[bi] + '_' + si2], b2 = nodeGrid[bandNames[bi + 1] + '_' + si2];
        if (a2 && b2) radialEdges.push([a2, b2]);
      }
    }

    // Landmark beams. Walls and the flip are ALL-EXPIRY aggregates (computed
    // from the whole book in computeMetrics), so they render like the spot
    // beam — vertical markers cutting through every shell — NOT as node
    // decorations on one ring, which would misread as 0DTE-specific levels.
    // A landmark whose price falls outside the mesh's strike window gets an
    // edge-clamped "(off-mesh)" label and no beam, instead of silently
    // snapping to the nearest in-range strike and drawing the wall somewhere
    // it isn't.
    function fracIdx(price) {
      if (price == null || !isFinite(price)) return null;
      if (price < strikes[0] || price > strikes[strikes.length - 1]) return null;
      if (strikes.length < 2) return 0; // single-strike mesh: range check above already pinned it
      var i = 0;
      while (i < strikes.length - 2 && strikes[i + 1] < price) i++;
      var lo = strikes[i], hi = strikes[i + 1];
      return hi === lo ? i : i + (price - lo) / (hi - lo);
    }
    function beamPoints(idx) {
      var theta = (idx / Math.max(1, strikes.length - 1) - 0.5) * THETA_SPAN;
      var pts = [];
      for (var rr = 60; rr <= 300; rr += 6) {
        pts.push({ x: rr * Math.sin(theta), y: -9, z: rr * Math.cos(theta), px: 0, py: 0 });
      }
      return pts;
    }

    var beams = [];
    function addBeam(label, price, rgb, opts) {
      if (price == null || !isFinite(price)) return;
      var idx = fracIdx(price);
      var offMesh = idx == null || !isFinite(idx); // non-finite index must never build an "on-mesh" beam
      var clamped = offMesh ? (price < strikes[0] ? 0 : strikes.length - 1) : idx;
      beams.push({
        label: label, price: price, rgb: rgb,
        labelText: label + ' ' + fmtPrice(price) + (offMesh ? ' (off-mesh)' : ''),
        labelColor: 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')',
        offMesh: offMesh,
        points: beamPoints(clamped),
        thick: !!(opts && opts.thick),
        labelEnd: (opts && opts.labelEnd) || 'top', // which beam end anchors the price label
      });
    }
    var lmRaw = payload.landmarks;
    var meta = GREEK_META[greekKey];
    var flipPrice = meta.flipField ? lmRaw[meta.flipField] : null;
    addBeam('SPOT', payload.spot, [198, 143, 255], { thick: true, labelEnd: 'top' });
    if (lmRaw.callWall != null && lmRaw.callWall === lmRaw.putWall) {
      addBeam('CALL+PUT WALL', lmRaw.callWall, [53, 214, 176], { labelEnd: 'top' });
    } else {
      addBeam('CALL WALL', lmRaw.callWall, [53, 214, 176], { labelEnd: 'top' });
      addBeam('PUT WALL', lmRaw.putWall, [255, 122, 82], { labelEnd: 'bottom' });
    }
    if (meta.flipLabel) addBeam(meta.flipLabel.toUpperCase(), flipPrice, [230, 236, 242], { labelEnd: 'bottom' });

    // per-band landmark markers: that band's OWN wall/flip drawn on its own
    // ring at the shell's baseline radius — the honest per-expiry levels next
    // to the all-expiry beams. Off-mesh or empty-band values are skipped, not
    // snapped.
    var bandMarkers = [];
    (payload.bandLandmarks || []).forEach(function (bl) {
      var bm = BAND_META[bl.name];
      if (!bm || !bl.n) return;
      [['callWall', bl.callWall], ['putWall', bl.putWall], ['flip', bl.flip]].forEach(function (kv) {
        var idx = fracIdx(kv[1]);
        if (idx == null || !isFinite(idx)) return;
        var theta = (idx / Math.max(1, strikes.length - 1) - 0.5) * THETA_SPAN;
        bandMarkers.push({
          band: bl.name, kind: kv[0], price: kv[1],
          x: bm.radius * Math.cos(bm.phi) * Math.sin(theta),
          y: bm.radius * Math.sin(bm.phi) - bm.tilt,
          z: bm.radius * Math.cos(bm.phi) * Math.cos(theta),
          px: 0, py: 0,
        });
      });
    });

    // strike ticks: ~10 price labels along the inner rim, favoring the
    // roundest strike in each stretch — deformations map to tradable levels
    // at a glance instead of only on hover
    var ticks = [];
    if (strikes.length >= 2) {
      var tickStep = Math.max(1, Math.ceil(strikes.length / 10));
      var roundness = function (p) {
        if (p % 1000 === 0) return 7;
        if (p % 500 === 0) return 6;
        if (p % 100 === 0) return 5;
        if (p % 50 === 0) return 4;
        if (p % 10 === 0) return 3;
        if (p % 5 === 0) return 2;
        if (p % 1 === 0) return 1; // integers beat half-dollar strikes on 0.5-spaced grids
        return 0;
      };
      var rim = BAND_META['0DTE'];
      for (var tk = 0; tk < strikes.length; tk += tickStep) {
        var bestTick = tk, bestScore = -1;
        for (var tj = tk; tj < Math.min(strikes.length, tk + tickStep); tj++) {
          var sc = roundness(strikes[tj]);
          if (sc > bestScore) { bestScore = sc; bestTick = tj; }
        }
        var tTheta = (bestTick / (strikes.length - 1) - 0.5) * THETA_SPAN;
        var tR = rim.radius - 26; // just inside the innermost shell
        ticks.push({
          // fmtPrice rounds — a tick at 22.5 must not claim to be 23
          label: strikes[bestTick] % 1 === 0 ? fmtPrice(strikes[bestTick]) : String(strikes[bestTick]),
          x: tR * Math.cos(rim.phi) * Math.sin(tTheta),
          y: tR * Math.sin(rim.phi) - rim.tilt,
          z: tR * Math.cos(rim.phi) * Math.cos(tTheta),
          px: 0, py: 0,
        });
      }
    }

    var built = {
      nodes: nodes, ringEdges: ringEdges, radialEdges: radialEdges, nodeGrid: nodeGrid, nodeByPrice: nodeByPrice,
      beams: beams, bandMarkers: bandMarkers, ticks: ticks, strikes: strikes, spot: payload.spot,
      sorted: nodes.slice(),      // depth order, re-sorted on camera change
      edgeBuckets: [],            // filled by applyDerived
      maxPulse: maxPulse,
      pulseT0: performance.now(), // pulse decay is absolute-time based: frames may be irregular under render-on-demand
    };
    applyDerived(built);
    return built;
  }

  // ---------------------------------------------------------------- near-term focus
  // Short-term trading cares about 0DTE/Weekly gamma; Monthly/LEAP ride along
  // for context but visually recede by default (dimmer, smaller) rather than
  // competing for attention.
  var NEAR_TERM_EMPHASIS = { '0DTE': 1, 'Weekly': 1, 'Monthly': 0.45, 'LEAP': 0.28 };
  var FULL_EMPHASIS = { '0DTE': 1, 'Weekly': 1, 'Monthly': 1, 'LEAP': 1 };
  var nearTermFocus = true;
  function emphasisFor(bandName) { return (nearTermFocus ? NEAR_TERM_EMPHASIS : FULL_EMPHASIS)[bandName] || 1; }

  /* Annotate the scene with everything that depends on the emphasis mode:
   * node sprites/sizes, satellite sprites/spoke colors, and the batched edge
   * buckets. Runs at build time and again on each focus toggle — a linear pass
   * over the scene, no geometry or network work. */
  function applyDerived(sc) {
    sc.nodes.forEach(function (n) {
      var emph = emphasisFor(n.band);
      n.emph = emph;
      n.drawBase = (1.6 + n.gMag * 2.6) * (0.55 + 0.45 * emph);
      var alpha = 0.9 * emph * (0.35 + 0.65 * n.gMag);
      n.sprite = spriteFor(n.g >= 0 ? CALL_RGB : PUT_RGB, alpha, false);
      n.satellites.forEach(function (sat) {
        if (!sat.show) return;
        sat.sprite = spriteFor(sat.rgb, (0.55 + 0.4 * sat.mag) * emph, sat.hollow);
        sat.spokeColor = 'rgba(' + sat.rgb[0] + ',' + sat.rgb[1] + ',' + sat.rgb[2] + ',' + (0.22 * emph).toFixed(3) + ')';
      });
    });

    // edge color buckets: quantize (hue, alpha) so ~2,500 strokes collapse
    // into a couple dozen batched paths
    var buckets = new Map();
    function bucketAdd(color, width, a, b) {
      var key = color + '|' + width;
      var entry = buckets.get(key);
      if (!entry) buckets.set(key, entry = { color: color, width: width, pairs: [] });
      entry.pairs.push(a, b);
    }
    sc.ringEdges.forEach(function (e) {
      var g = (e[0].g + e[1].g) / 2;
      var emph = emphasisFor(e[0].band);
      var alpha = 0.28 * emph * (0.35 + 0.65 * Math.min(1, Math.abs(g)));
      var rgb = g >= 0 ? CALL_RGB : PUT_RGB;
      var q = (Math.round(alpha * 40) / 40).toFixed(3);
      bucketAdd('rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + q + ')', 0.9, e[0], e[1]);
    });
    sc.radialEdges.forEach(function (e) {
      var emph = (emphasisFor(e[0].band) + emphasisFor(e[1].band)) / 2;
      var q = (Math.round(0.16 * emph * 40) / 40).toFixed(3);
      bucketAdd('rgba(90,110,128,' + q + ')', 0.6, e[0], e[1]);
    });
    sc.edgeBuckets = [];
    buckets.forEach(function (b) { sc.edgeBuckets.push(b); });
  }

  var focusToggle = document.getElementById('focusToggle');
  focusToggle.addEventListener('click', function () {
    nearTermFocus = !nearTermFocus;
    focusToggle.textContent = 'Near-term focus: ' + (nearTermFocus ? 'ON' : 'OFF');
    focusToggle.setAttribute('aria-pressed', String(nearTermFocus));
    if (scene) applyDerived(scene);
    requestRender();
    persistView();
  });

  // ---------------------------------------------------------------- node inspection (hover + pin)
  // Hover any node for its strike, band, and all four raw dollar exposures;
  // click to PIN it — a pinned node keeps its ring + tooltip across polls,
  // re-resolved by band + STRIKE PRICE so the values update live for the SAME
  // strike (the ±10% window slides with spot, so indices don't survive polls),
  // until you click it again, click empty space, or the strike leaves the mesh.
  var tipEl = document.getElementById('tip');
  var pinPanelEl = document.getElementById('pinPanel');
  var pinListEl = document.getElementById('pinList');
  var pinCountEl = document.getElementById('pinCount');
  var hoverKey = null;
  var pins = [];        // pinned keys (band_strike), in pin order — the compare set
  var MAX_PINS = 4;     // cap: keeps the docked panel readable and spark fetches cheap
  var pinRows = {};     // key -> { row, idxEl, valEl, spark, capEl, gen }
  var pinGenSeq = 0;    // monotonic token so a stale sparkline fetch can't overwrite a newer one
  var lastPtrX = -1e9, lastPtrY = -1e9; // last idle pointer position, for hover re-validation after camera/scene changes

  function nodeKey(node) { return node.band + '_' + node.strike; }
  function isPinned(key) { return pins.indexOf(key) !== -1; }
  function hoverNode() { return hoverKey && scene ? (scene.nodeByPrice[hoverKey] || null) : null; }

  function hitNode(clientX, clientY) {
    if (!scene) return null;
    // rAF is suspended while the window is hidden/occluded — a routine state
    // for a tool parked behind an execution platform — so projections may
    // never have run for this scene. Hit-testing must not read stale zeros.
    if (cameraDirty) reproject();
    var x = clientX * DPR, y = clientY * DPR;
    var best = null, bestD2 = Math.pow(11 * DPR, 2);
    var nodes = scene.nodes;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var dx = n.px - x, dy = n.py - y;
      var d2 = dx * dx + dy * dy;
      if (d2 < bestD2 || (d2 === bestD2 && best && n.pz < best.pz)) { best = n; bestD2 = d2; }
    }
    return best;
  }

  // Floating tooltip: HOVER only now — the four raw exposures for whatever node
  // is under the cursor. Pins live in the docked compare panel instead, so the
  // tooltip stays light (no per-hover sparkline request) and never fights the
  // panel for the sparkline. Marks the node PINNED if it also happens to be pinned.
  function updateHoverTip() {
    var node = hoverNode();
    if (!node) {
      tipEl.style.display = 'none';
      requestRender(); // clear a lingering hover ring
      return;
    }
    tipEl.replaceChildren();
    var head = document.createElement('div');
    head.className = 'tip-head';
    head.textContent = fmtPrice(node.strike) + ' · ' + node.band + (isPinned(hoverKey) ? ' · PINNED' : '');
    tipEl.append(head);
    GREEK_ORDER.forEach(function (k) {
      var m = GREEK_META[k];
      var row = document.createElement('div');
      row.className = 'tip-row';
      var dot = document.createElement('span');
      dot.className = 'tip-dot';
      var css = 'rgb(' + m.dotColor.join(',') + ')';
      dot.style.background = css;
      dot.style.color = css;
      var name = document.createElement('span');
      name.className = 'tip-name';
      name.textContent = m.short + (k === activeGreek ? ' (shape)' : '');
      var val = document.createElement('span');
      var v = node.raws[k];
      val.className = 'tip-val mono' + (isFinite(v) ? (v >= 0 ? ' call' : ' put') : '');
      val.textContent = fmtGex(v);
      row.append(dot, name, val);
      tipEl.append(row);
    });
    tipEl.style.display = 'block';
    positionTip(node);
    requestRender(); // draw the hover ring
  }

  function fetchSeries(node, greek) {
    var sym = pb.active ? pb.symbol : currentSymbol;
    var q = 'api/brain/series?symbol=' + encodeURIComponent(sym) +
      '&band=' + encodeURIComponent(node.band) + '&strike=' + node.strike +
      '&greek=' + encodeURIComponent(greek || activeGreek) +
      (pb.active ? '&day=' + encodeURIComponent(pb.day) : '');
    return fetch(q, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (json) {
          if (!res.ok || !json || json.error) throw new Error((json && json.error) || ('HTTP ' + res.status));
          return json;
        });
      });
  }

  // Multi-greek pin sparkline: overlay all four greeks' day trajectories, each
  // in its own greek color and NORMALIZED to its OWN min/max — the greeks differ
  // by orders of magnitude, so this compares SHAPE (is gamma rising while charm
  // falls?), not level; the row header still shows the active greek's real value.
  // The active greek is drawn bold/bright, the others thin/dim.
  function drawMultiSpark(canvas, points, w, h, emphGreek) {
    w = w || 200; h = h || 38;
    canvas.width = w * DPR; canvas.height = h * DPR;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    var g = canvas.getContext('2d');
    g.clearRect(0, 0, canvas.width, canvas.height);
    var pad = 3 * DPR, n = points.length;
    function X(i) { return pad + (i / Math.max(1, n - 1)) * (canvas.width - 2 * pad); }
    // draw the non-active greeks first so the active one sits on top
    GREEK_ORDER.slice().sort(function (a, b) { return (a === emphGreek) - (b === emphGreek); }).forEach(function (gk) {
      var fin = [];
      for (var i = 0; i < n; i++) { var val = points[i][gk]; if (val != null && isFinite(val)) fin.push(val); }
      if (fin.length < 2) return;
      var lo = Math.min.apply(null, fin), hi = Math.max.apply(null, fin);
      if (hi === lo) { lo -= 1; hi += 1; }
      function Y(v) { return pad + (1 - (v - lo) / (hi - lo)) * (canvas.height - 2 * pad); }
      var rgb = GREEK_META[gk].dotColor, active = gk === emphGreek;
      g.strokeStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (active ? 0.95 : 0.45) + ')';
      g.lineWidth = (active ? 1.7 : 1.0) * DPR;
      g.beginPath();
      var open = false;
      for (var k = 0; k < n; k++) {
        var v = points[k][gk];
        if (v == null || !isFinite(v)) { open = false; continue; } // gap: strike outside that snapshot's window
        if (!open) { g.moveTo(X(k), Y(v)); open = true; } else g.lineTo(X(k), Y(v));
      }
      g.stroke();
    });
  }

  function positionTip(node) {
    if (tipEl.style.display === 'none') return;
    var x = node.px / DPR + 16, y = node.py / DPR - 10;
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    if (x + w > window.innerWidth - 8) x = node.px / DPR - w - 16;
    if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
    if (y < 8) y = 8;
    tipEl.style.left = x + 'px';
    tipEl.style.top = y + 'px';
  }

  // ---- pins + docked compare panel ----
  // Click a node to add/remove it from the compare set (up to MAX_PINS). Each
  // pin gets a panel row: index badge (matches a numbered ring on the mesh),
  // strike·band, the live active-greek value, and the day sparkline. Pins are
  // keyed by band+STRIKE PRICE so they track the same strike as the ±10% window
  // slides; a pin whose strike leaves the mesh is dropped on reconcile.
  function togglePin(node) {
    var key = nodeKey(node);
    var i = pins.indexOf(key);
    if (i !== -1) pins.splice(i, 1);
    else {
      if (pins.length >= MAX_PINS) { var gone = pins.shift(); dropPinRow(gone); } // oldest falls off
      pins.push(key);
    }
    refreshPins(true);
    updateHoverTip(); // reflect the PINNED marker if the toggled node is under the cursor
    requestRender();
  }
  function dropPinRow(key) {
    if (pinRows[key]) { pinRows[key].row.remove(); delete pinRows[key]; }
  }
  function clearPins() {
    pins = [];
    Object.keys(pinRows).forEach(dropPinRow);
    refreshPins(false);
    requestRender();
  }

  // Reconcile the panel with `pins` + the live scene. refetchSparks=true pulls
  // every row's day-series again (greek changed → different series); otherwise
  // existing rows keep their sparkline and only their live value refreshes, so a
  // 20s poll doesn't reflash every sparkline.
  function refreshPins(refetchSparks) {
    if (scene) pins = pins.filter(function (key) { return scene.nodeByPrice[key]; }); // drop strikes that left the mesh
    Object.keys(pinRows).forEach(function (key) { if (pins.indexOf(key) === -1) dropPinRow(key); });
    pins.forEach(function (key, i) {
      var node = scene ? scene.nodeByPrice[key] : null;
      if (!node) return;
      var row = pinRows[key];
      if (!row) { row = makePinRow(key); fetchSparkInto(key); }
      else if (refetchSparks) fetchSparkInto(key);
      row.idxEl.textContent = String(i + 1);
      var v = node.raws[activeGreek];
      row.valEl.textContent = fmtGex(v);
      row.valEl.className = 'pin-val' + (isFinite(v) ? (v >= 0 ? ' call' : ' put') : ''); // no tint on a '—' dash
    });
    pinCountEl.textContent = pins.length ? '(' + pins.length + ')' : '';
    pinPanelEl.classList.toggle('on', pins.length > 0);
  }

  function makePinRow(key) {
    var node = scene.nodeByPrice[key];
    var row = document.createElement('div'); row.className = 'pin-row';
    var head = document.createElement('div'); head.className = 'pin-head';
    var idx = document.createElement('span'); idx.className = 'pin-idx';
    var label = document.createElement('span'); label.className = 'pin-label';
    label.textContent = fmtPrice(node.strike) + ' · ' + node.band;
    var val = document.createElement('span'); val.className = 'pin-val';
    var rm = document.createElement('button'); rm.className = 'pin-x'; rm.textContent = '×'; rm.title = 'unpin';
    rm.addEventListener('click', function () {
      var i = pins.indexOf(key);
      if (i !== -1) { pins.splice(i, 1); dropPinRow(key); refreshPins(false); updateHoverTip(); requestRender(); }
    });
    head.append(idx, label, val, rm);
    var spark = document.createElement('canvas'); spark.className = 'pin-spark';
    spark.width = 200 * DPR; spark.height = 38 * DPR; spark.style.width = '200px'; spark.style.height = '38px';
    var cap = document.createElement('div'); cap.className = 'pin-cap'; cap.textContent = 'loading day series…';
    row.append(head, spark, cap);
    pinListEl.append(row);
    return (pinRows[key] = { row: row, idxEl: idx, valEl: val, spark: spark, capEl: cap, gen: 0, points: null });
  }

  function fetchSparkInto(key) {
    var entry = pinRows[key];
    var node = scene ? scene.nodeByPrice[key] : null;
    if (!entry || !node) return;
    var gen = entry.gen = ++pinGenSeq;
    entry.capEl.textContent = 'loading day series…';
    fetchSeries(node, 'all').then(function (series) {
      if (pinRows[key] !== entry || entry.gen !== gen) return; // row removed or superseded by a newer fetch
      var pts = series.points || [];
      var usable = pts.filter(function (p) { return GREEK_ORDER.some(function (g) { return p[g] != null; }); });
      if (usable.length < 2) { entry.points = null; entry.capEl.textContent = 'no history yet — archive still building'; return; }
      entry.points = pts;
      entry.capEl.textContent = 'all greeks · ' + pts.length + ' snapshots';
      drawMultiSpark(entry.spark, pts, 200, 38, activeGreek);
    }).catch(function (err) {
      if (pinRows[key] !== entry || entry.gen !== gen) return;
      entry.capEl.textContent = 'series unavailable: ' + err.message;
    });
  }

  // a greek switch changes only which line is emphasized — redraw from the
  // stored points instead of refetching (the all-greek series is greek-agnostic)
  function redrawPinSparks() {
    pins.forEach(function (key) {
      var entry = pinRows[key];
      if (entry && entry.points) drawMultiSpark(entry.spark, entry.points, 200, 38, activeGreek);
    });
  }

  document.getElementById('pinClear').addEventListener('click', clearPins);

  // after a scene rebuild/poll: drop hover/pins whose strike left the mesh
  // window, refresh the hover tooltip, and re-sync the compare panel (values
  // always; sparklines only when the greek changed — refetchSparks)
  var lastSparkContext = 'live';
  function reconcileInspect(refetchSparks) {
    if (hoverKey && (!scene || !scene.nodeByPrice[hoverKey])) hoverKey = null;
    // pin sparklines are DAY-scoped (fetchSeries appends &day= in playback), so
    // force a refetch whenever the day context changes — entering/leaving
    // playback or switching archive day — else a row plots one day while its
    // value shows another. Plain scrubbing within a day keeps the context.
    var ctx = pb.active ? ('pb:' + pb.day) : 'live';
    if (ctx !== lastSparkContext) { refetchSparks = true; lastSparkContext = ctx; }
    refreshPins(!!refetchSparks);
    updateHoverTip();
  }

  // ---------------------------------------------------------------- camera / interaction
  // Static by default (trading tool, not a screensaver) — a steeper top-down
  // tilt than the original demo angle so the concentric strike rings read
  // clearly at a glance instead of edge-on. Rotation only ever happens from an
  // explicit drag; it never auto-resumes. A press that moves less than a few
  // pixels is a CLICK (pin/unpin a node), not a drag.
  var rotY = 0.32, rotX = -0.72;
  var dragging = false, lastX = 0, lastY = 0, zoom = 1, dragDist = 0;

  canvas.addEventListener('pointerdown', function (e) {
    dragging = true;
    dragDist = 0;
    lastX = e.clientX; lastY = e.clientY;
    canvas.classList.add('dragging');
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events have no active pointer */ }
  });

  // debug probe (used by the live-verification tooling; harmless in production)
  window.__gexInspect = function (x, y) {
    var n = scene ? hitNode(x, y) : null;
    return {
      hoverKey: hoverKey, pins: pins.slice(),
      nodeCount: scene ? scene.nodes.length : 0,
      hit: n ? { band: n.band, strike: n.strike, px: n.px, py: n.py } : null,
      pxRange: scene && scene.nodes.length ? [
        Math.round(Math.min.apply(null, scene.nodes.map(function (q) { return q.px; }))),
        Math.round(Math.max.apply(null, scene.nodes.map(function (q) { return q.px; }))),
        Math.round(Math.min.apply(null, scene.nodes.map(function (q) { return q.py; }))),
        Math.round(Math.max.apply(null, scene.nodes.map(function (q) { return q.py; }))),
      ] : null,
    };
  };
  canvas.addEventListener('pointermove', function (e) {
    lastPtrX = e.clientX; lastPtrY = e.clientY;
    if (dragging) {
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      dragDist += Math.abs(dx) + Math.abs(dy);
      rotY += dx * 0.006;
      rotX = Math.max(-1.1, Math.min(1.1, rotX + dy * 0.006));
      cameraDirty = true;
      requestRender();
      return;
    }
    // idle pointer: hover inspection
    var node = hitNode(e.clientX, e.clientY);
    var key = node ? nodeKey(node) : null;
    canvas.style.cursor = key ? 'pointer' : '';
    if (key !== hoverKey) { hoverKey = key; updateHoverTip(); }
  });
  canvas.addEventListener('pointerup', function (e) {
    if (!dragging) return; // release of a press that never started on the canvas
    var wasDrag = dragDist >= 5;
    dragging = false;
    canvas.classList.remove('dragging');
    if (wasDrag) { persistView(); return; } // the post-drag hover re-validation happens in draw()
    var node = hitNode(e.clientX, e.clientY);
    if (node) togglePin(node); // click on empty space keeps the compare set (row × / clear removes)
  });
  canvas.addEventListener('pointercancel', function () {
    dragging = false;
    canvas.classList.remove('dragging');
  });
  canvas.addEventListener('pointerleave', function () {
    lastPtrX = -1e9; lastPtrY = -1e9;
    if (dragging) return;
    hoverKey = null;
    canvas.style.cursor = '';
    updateHoverTip();
  });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    zoom = Math.max(0.55, Math.min(2.2, zoom * (1 - e.deltaY * 0.001)));
    cameraDirty = true;
    requestRender();
    persistView();
  }, { passive: false });

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // when the window comes back from hidden/occluded, rAF resumes — repaint so
  // the canvas shows the current book, not whatever was on screen at suspend
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { cameraDirty = true; requestRender(); }
  });

  // ---------------------------------------------------------------- view state (URL + localStorage)
  // The tool should remember where you left it — active greek, near-term focus,
  // and camera angle — and produce a shareable URL that reconstructs the exact
  // view. localStorage is the personal default; a ?greek/&focus/&cam query
  // overrides it (so a pasted link always wins). Writes are debounced because a
  // drag fires camera changes continuously; history.replaceState keeps it out
  // of the back-stack. All of it is best-effort: a storage exception (private
  // mode, quota) or a malformed query must never break the render.
  var VIEW_LS_KEY = 'gex.brain.view';
  function readStoredPrefs() {
    try { return JSON.parse(localStorage.getItem(VIEW_LS_KEY)) || {}; } catch (e) { return {}; }
  }
  var persistTimer = null;
  function writeViewState() {
    var state = {
      greek: activeGreek,
      focus: nearTermFocus ? 1 : 0,
      rotX: +rotX.toFixed(3), rotY: +rotY.toFixed(3), zoom: +zoom.toFixed(3),
    };
    try { localStorage.setItem(VIEW_LS_KEY, JSON.stringify(state)); } catch (e) { /* private mode / quota */ }
    // reflect in the URL for shareable links — replaceState, not pushState,
    // so orbiting the mesh doesn't flood the browser back button
    try {
      var qp = new URLSearchParams(location.search);
      qp.set('symbol', currentSymbol);
      qp.set('greek', activeGreek);
      qp.set('focus', String(state.focus));
      qp.set('cam', state.rotY + ',' + state.rotX + ',' + state.zoom);
      history.replaceState(null, '', location.pathname + '?' + qp.toString());
    } catch (e) { /* replaceState can throw on some file:// contexts */ }
  }
  function persistView() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(writeViewState, 300);
  }
  // flush the pending debounced write immediately — the SHARE button needs the
  // URL to reflect the very latest camera/greek before it copies location.href
  function flushViewState() { clearTimeout(persistTimer); writeViewState(); }

  // ---------------------------------------------------------------- ticker recents (datalist)
  // The symbol box suggests recently-viewed tickers plus the scanner/macro
  // watchlist — one keystroke instead of retyping. Recents are brain-local;
  // the watchlist is the shared 'gex.scan.watchlist' key (read-only here). All
  // best-effort: a storage failure just means no suggestions, never a break.
  var RECENTS_LS_KEY = 'gex.brain.recents';
  var symbolListEl = document.getElementById('symbolList');
  function loadRecents() {
    try { var a = JSON.parse(localStorage.getItem(RECENTS_LS_KEY)); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function pushRecent(sym) {
    try {
      var a = loadRecents().filter(function (s) { return s !== sym; });
      a.unshift(sym);
      localStorage.setItem(RECENTS_LS_KEY, JSON.stringify(a.slice(0, 10)));
    } catch (e) { /* private mode / quota */ }
    refreshSymbolList();
  }
  function refreshSymbolList() {
    if (!symbolListEl) return;
    var wl = [];
    try { var a = JSON.parse(localStorage.getItem('gex.scan.watchlist')); if (Array.isArray(a)) wl = a; } catch (e) { /* ignore */ }
    var seen = {}, opts = [];
    loadRecents().concat(wl).forEach(function (s) {
      s = String(s).toUpperCase().replace(/[^A-Z^_.]/g, '');
      if (s && !seen[s]) { seen[s] = 1; opts.push(s); }
    });
    symbolListEl.replaceChildren();
    opts.forEach(function (s) { var o = document.createElement('option'); o.value = s; symbolListEl.append(o); });
  }

  // ---------------------------------------------------------------- per-symbol greek memory
  // Different tickers reward different greeks (an index's gamma, a high-vol name's
  // vanna) — so remember the last greek used per symbol and restore it on an
  // EXPLICIT symbol change (the Load control). Precedence stays honest: a URL
  // ?greek always wins (a shared link is deliberate), then this per-symbol
  // memory, then the global last-greek, then the default. All best-effort.
  var GREEK_BY_SYM_KEY = 'gex.brain.greekBySym';
  function loadGreekMap() {
    try { var o = JSON.parse(localStorage.getItem(GREEK_BY_SYM_KEY)); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; }
  }
  function greekForSymbol(sym) { var g = loadGreekMap()[sym]; return GREEK_META[g] ? g : null; }
  function rememberGreekForSymbol(sym, greek) {
    if (!sym || !GREEK_META[greek]) return;
    try { var m = loadGreekMap(); m[sym] = greek; localStorage.setItem(GREEK_BY_SYM_KEY, JSON.stringify(m)); } catch (e) { /* private mode / quota */ }
  }

  var DEFAULT_ROTY = 0.32, DEFAULT_ROTX = -0.72;
  function resetCamera() {
    rotY = DEFAULT_ROTY; rotX = DEFAULT_ROTX; zoom = 1;
    cameraDirty = true;
    requestRender();
    persistView();
  }

  // Greek-switch fade: the mesh geometry snaps (it's recomputed for the new
  // greek), but easing the canvas opacity up from a quick dip sells it as a
  // transition instead of a hard cut. Pure CSS opacity on the <canvas> element,
  // so it composites independently of the render-on-demand loop — zero extra
  // frames are drawn. The transition:none + forced reflow makes the dip
  // instantaneous; clearing the inline transition restores the stylesheet ease.
  function flashSwitch() {
    if (reduceMotion) return;
    canvas.style.transition = 'none';
    canvas.style.opacity = '0.35';
    void canvas.offsetWidth;
    canvas.style.transition = '';
    canvas.style.opacity = '1';
  }

  // ---------------------------------------------------------------- render loop (on demand)
  var needsRender = false, rafPending = false, cameraDirty = true;
  var animUntil = 0; // absolute time (performance.now ms) until which pulse animation keeps frames flowing

  function requestRender() {
    needsRender = true;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(frame);
    }
  }

  // seed the pulse-decay animation window after a scene rebuild — always
  // resetting first, because the previous scene's window died with it
  function armPulses(sc) {
    animUntil = 0;
    if (reduceMotion || !sc || sc.maxPulse <= 0) return;
    animUntil = sc.pulseT0 + Math.min(2500, (sc.maxPulse / 0.7) * 1000);
  }

  function frame(now) {
    rafPending = false;
    var animating = now < animUntil;
    if (!animating && animUntil !== 0) {
      // the pulse window just closed: repaint once with decay clamped to zero.
      // rAF is suspended for hidden/occluded windows — without this settle
      // frame, a window restored after the deadline would stay frozen showing
      // mid-pulse flashes until the next poll.
      animUntil = 0;
      needsRender = true;
    }
    if (!needsRender && !animating) return; // idle: the loop simply stops
    needsRender = false;
    draw(now);
    if (animating || needsRender) {
      rafPending = true;
      requestAnimationFrame(frame);
    }
  }

  // rotate + perspective-project a scene point into screen coords; writes
  // into (obj.px, obj.py) and returns depth z. Split out so nodes and beam
  // points share it without allocating result objects.
  var camCosY = 1, camSinY = 0, camCosX = 1, camSinX = 0, camCx = 0, camCy = 0, camScale = 1;
  var FOCAL = 620;
  function projectInto(p) {
    var x1 = p.x * camCosY - p.z * camSinY;
    var z1 = p.x * camSinY + p.z * camCosY;
    var y2 = p.y * camCosX - z1 * camSinX;
    var z2 = p.y * camSinX + z1 * camCosX;
    var f = FOCAL / (FOCAL + z2) * camScale;
    p.px = camCx + x1 * f;
    p.py = camCy - y2 * f;
    return { f: f, z: z2 };
  }

  function reproject() {
    camCosY = Math.cos(rotY); camSinY = Math.sin(rotY);
    camCosX = Math.cos(rotX); camSinX = Math.sin(rotX);
    camCx = canvas.width / 2;
    camCy = canvas.height / 2 + 40 * DPR;
    camScale = DPR * 1.55 * zoom;
    scene.nodes.forEach(function (n) {
      var r = projectInto(n);
      n.pz = r.z;
      n.pk = Math.max(0.35, r.f / camScale * 0.9);
    });
    scene.beams.forEach(function (beam) {
      beam.points.forEach(function (p) { projectInto(p); });
    });
    scene.bandMarkers.forEach(function (mk) { projectInto(mk); });
    scene.ticks.forEach(function (t) { projectInto(t); });
    // painter's algorithm: larger z is FARTHER under this projection
    // (f = focal/(focal+z)), so draw order is descending z — far first
    scene.sorted.sort(function (a, b) { return b.pz - a.pz; });
    cameraDirty = false;
  }

  function draw(now) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!scene || !scene.nodes.length) return;
    if (cameraDirty) reproject();

    var pulseElapsed = (now - scene.pulseT0) / 1000;

    // 1) edges, batched by color bucket (z-order between edges is given up —
    // invisible at these alphas; nodes still draw over them in depth order)
    scene.edgeBuckets.forEach(function (bucket) {
      ctx.beginPath();
      var pairs = bucket.pairs;
      for (var i = 0; i < pairs.length; i += 2) {
        ctx.moveTo(pairs[i].px, pairs[i].py);
        ctx.lineTo(pairs[i + 1].px, pairs[i + 1].py);
      }
      ctx.strokeStyle = bucket.color;
      ctx.lineWidth = bucket.width * DPR;
      ctx.stroke();
    });

    // 1.5) strike ticks along the inner rim — faint price grid furniture
    if (scene.ticks.length) {
      ctx.font = (9 * DPR) + 'px ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace';
      ctx.fillStyle = 'rgba(124,138,153,0.55)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (var ti = 0; ti < scene.ticks.length; ti++) {
        var tick = scene.ticks[ti];
        if (isFinite(tick.px)) ctx.fillText(tick.label, tick.px, tick.py);
      }
    }

    // 2) landmark beams — the only place shadowBlur survives (≤4 strokes)
    scene.beams.forEach(function (beam) {
      if (beam.offMesh) return;
      var pts = beam.points;
      if (!isFinite(pts[0].px) || !isFinite(pts[0].py)) return; // never let a bad beam kill the loop
      var rgb = beam.rgb;
      var peak = beam.thick ? 0.55 : 0.4;
      ctx.beginPath();
      for (var i = 0; i < pts.length; i++) {
        if (i === 0) ctx.moveTo(pts[i].px, pts[i].py); else ctx.lineTo(pts[i].px, pts[i].py);
      }
      var grad = ctx.createLinearGradient(pts[0].px, pts[0].py, pts[pts.length - 1].px, pts[pts.length - 1].py);
      grad.addColorStop(0, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.05)');
      grad.addColorStop(0.5, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + peak + ')');
      grad.addColorStop(1, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.05)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = (beam.thick ? 2.4 : 1.3) * DPR;
      ctx.shadowColor = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.8)';
      ctx.shadowBlur = (beam.thick ? 14 : 7) * DPR;
      ctx.stroke();
      ctx.shadowBlur = 0;
    });

    // 3) synapse spokes, batched per color (drawn under all nodes); satellite
    // screen positions are computed here once and cached for the dot pass
    var spokeBuckets = {};
    var sorted = scene.sorted;
    for (var i = 0; i < sorted.length; i++) {
      var n = sorted[i];
      var sats = n.satellites;
      for (var j = 0; j < sats.length; j++) {
        var sat = sats[j];
        if (!sat.show) continue;
        var orbitR = sat.baseOrbit * DPR * n.pk;
        sat.sx = n.px + sat.cosA * orbitR;
        sat.sy = n.py + sat.sinA * orbitR * 0.55; // flatten for a pseudo-3D orbit under this camera tilt
        var segs = spokeBuckets[sat.spokeColor];
        if (!segs) segs = spokeBuckets[sat.spokeColor] = [];
        segs.push(n.px, n.py, sat.sx, sat.sy);
      }
    }
    ctx.lineWidth = 0.6 * DPR;
    for (var color in spokeBuckets) {
      var segs2 = spokeBuckets[color];
      ctx.beginPath();
      for (var k = 0; k < segs2.length; k += 4) {
        ctx.moveTo(segs2[k], segs2[k + 1]);
        ctx.lineTo(segs2[k + 2], segs2[k + 3]);
      }
      ctx.strokeStyle = color;
      ctx.stroke();
    }

    // 4) nodes + satellites, far to near, all sprite blits — synapses orbit
    // each node at a FIXED angle per greek (color = which greek, filled =
    // positive, hollow ring = negative, distance = magnitude)
    for (var m = 0; m < sorted.length; m++) {
      var node = sorted[m];
      var decay = node.pulseAmt > 0 ? Math.max(0, node.pulseAmt - pulseElapsed * 0.7) : 0;
      if (reduceMotion) decay = 0;
      var r = node.drawBase * DPR * node.pk * (1 + decay * 1.8);
      if (r < 0.8) r = 0.8;
      var w = r * FILL_DRAW;
      ctx.drawImage(node.sprite, node.px - w / 2, node.py - w / 2, w, w);
      if (decay > 0.02) {
        ctx.globalAlpha = Math.min(1, decay);
        var pw = w * 1.5;
        ctx.drawImage(pulseSprite(), node.px - pw / 2, node.py - pw / 2, pw, pw);
        ctx.globalAlpha = 1;
      }
      var sats2 = node.satellites;
      for (var s2 = 0; s2 < sats2.length; s2++) {
        var sat2 = sats2[s2];
        if (!sat2.show) continue;
        var dotR = sat2.baseDot * DPR;
        if (dotR < 0.7) dotR = 0.7;
        var dw = dotR * (sat2.hollow ? RING_DRAW : FILL_DRAW);
        // a hollow ring below ~5px renders its stroke sub-pixel and reads as
        // "nothing there" — floor it so negative greeks aren't underweighted
        if (sat2.hollow && dw < 5 * DPR) dw = 5 * DPR;
        ctx.drawImage(sat2.sprite, sat2.sx - dw / 2, sat2.sy - dw / 2, dw, dw);
      }
    }

    // 5) per-band landmark markers on their own shells: ○ = that band's wall
    // (teal call / orange put), ◇ = that band's flip
    for (var bi = 0; bi < scene.bandMarkers.length; bi++) {
      var mk = scene.bandMarkers[bi];
      if (!isFinite(mk.px) || !isFinite(mk.py)) continue;
      var mEmph = emphasisFor(mk.band);
      var mr = 3.4 * DPR;
      ctx.beginPath();
      if (mk.kind === 'flip') {
        ctx.strokeStyle = 'rgba(230,236,242,' + (0.75 * mEmph).toFixed(3) + ')';
        ctx.lineWidth = 1.1 * DPR;
        ctx.moveTo(mk.px, mk.py - mr);
        ctx.lineTo(mk.px + mr, mk.py);
        ctx.lineTo(mk.px, mk.py + mr);
        ctx.lineTo(mk.px - mr, mk.py);
        ctx.closePath();
      } else {
        ctx.strokeStyle = mk.kind === 'callWall'
          ? 'rgba(53,214,176,' + (0.8 * mEmph).toFixed(3) + ')'
          : 'rgba(255,122,82,' + (0.8 * mEmph).toFixed(3) + ')';
        ctx.lineWidth = 1.2 * DPR;
        ctx.arc(mk.px, mk.py, mr, 0, Math.PI * 2);
      }
      ctx.stroke();
    }

    // 6) inspect highlights: a bright numbered ring on each pinned node (the
    // number matches its compare-panel row), a faint ring on the hovered node,
    // and keep the floating hover tooltip glued to its node as the camera moves
    for (var qi = 0; qi < pins.length; qi++) {
      var pnode = scene.nodeByPrice[pins[qi]];
      if (!pnode || !isFinite(pnode.px)) continue;
      var prr = Math.max(6 * DPR, pnode.drawBase * DPR * pnode.pk * 2.2);
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(244,247,250,0.95)';
      ctx.lineWidth = 1.6 * DPR;
      ctx.arc(pnode.px, pnode.py, prr, 0, Math.PI * 2);
      ctx.stroke();
      var bx = pnode.px + prr * 0.72, by = pnode.py - prr * 0.72; // index badge, matches the panel row number
      ctx.beginPath();
      ctx.fillStyle = 'rgba(8,11,16,0.85)';
      ctx.arc(bx, by, 6.5 * DPR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(244,247,250,0.95)';
      ctx.font = (8.5 * DPR) + 'px ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(qi + 1), bx, by + 0.5 * DPR);
    }
    var hovNode = hoverNode();
    if (hovNode) {
      if (!isPinned(hoverKey) && isFinite(hovNode.px)) {
        var hrr = Math.max(6 * DPR, hovNode.drawBase * DPR * hovNode.pk * 2.2);
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(244,247,250,0.55)';
        ctx.lineWidth = 1.1 * DPR;
        ctx.arc(hovNode.px, hovNode.py, hrr, 0, Math.PI * 2);
        ctx.stroke();
      }
      positionTip(hovNode);
    }

    // 7) on-mesh price labels, one per beam, anchored at the beam's chosen
    // end, with anti-overlap: any label whose anchor lands within ~22px of an
    // already-placed label gets pushed along its own direction until it clears
    var placed = [];
    scene.beams.forEach(function (beam) {
      var pts = beam.points;
      var top = beam.labelEnd === 'top';
      var anchor = top ? pts[pts.length - 1] : pts[0];
      if (!isFinite(anchor.px) || !isFinite(anchor.py)) return;
      var y = anchor.py + (top ? -12 : 14) * DPR;
      var dir = top ? -1 : 1;
      var guard = 0;
      while (placed.some(function (p) { return Math.abs(p.x - anchor.px) < 90 * DPR && Math.abs(p.y - y) < 22 * DPR; }) && guard < 6) {
        y += dir * 18 * DPR;
        guard++;
      }
      placed.push({ x: anchor.px, y: y });
      drawLabel(beam.labelText, anchor.px, y, beam.labelColor);
    });

    // self-healing hover: zoom, drag-end, and scene swaps all move nodes
    // under a stationary cursor without firing pointermove — re-run the
    // hit-test against the fresh projections so the ring/tooltip never
    // linger on a node that is no longer under the pointer
    if (!dragging && lastPtrX > -1e8) {
      var hn = hitNode(lastPtrX, lastPtrY);
      var hk = hn ? nodeKey(hn) : null;
      if (hk !== hoverKey) {
        hoverKey = hk;
        canvas.style.cursor = hk ? 'pointer' : '';
        updateHoverTip();
      }
    }

    window.__gexBrainFrames = (window.__gexBrainFrames || 0) + 1; // perf probe: sample twice to measure real frame activity
  }

  // On-mesh price labels for the key levels (spot/walls/flip) — a short-term
  // trader needs these levels at a glance on the visual itself, not just in
  // the side readout. Small dark backing rect keeps text legible over the mesh.
  function drawLabel(text, x, y, color) {
    ctx.font = (11 * DPR) + 'px ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace';
    var w = ctx.measureText(text).width;
    var pad = 5 * DPR;
    ctx.fillStyle = 'rgba(8,11,16,0.78)';
    ctx.fillRect(x - w / 2 - pad, y - 9 * DPR, w + pad * 2, 15 * DPR);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y - 1.5 * DPR);
  }

  // ---------------------------------------------------------------- data loop
  var POLL_MS = 20000;
  var pollTimer = null;
  var currentSymbol = 'SPX';
  var lastBuiltSymbol = ''; // last symbol whose data actually reached the screen
  var loadSeq = 0;
  var urlGreekSymbol = null; // the symbol an explicit ?greek was meant for; consumed when THAT symbol first builds

  // first-paint skeleton: remove it once the first snapshot builds OR the first
  // attempt errors (past that, the last mesh stays visible across polls and the
  // banner carries any failure — the skeleton is a cold-start affordance only)
  var loadingEl = document.getElementById('loading');
  var firstPaintDone = false;
  function hideLoading() {
    if (firstPaintDone) return;
    firstPaintDone = true;
    if (loadingEl) loadingEl.classList.add('hidden');
  }

  // After every successful poll, re-baseline the diff-glow for ALL four greeks
  // (not just the one on screen) so clicking a greek chip later diffs against
  // this poll, not against whenever that tab was last viewed.
  function refreshBaselines(payload) {
    GREEK_ORDER.forEach(function (k) {
      var ak = GREEK_META[k].key;
      var map = new Map();
      payload.bands.forEach(function (band) {
        band[ak].forEach(function (raw, si) { map.set(band.name + '_' + payload.strikes[si], raw); });
      });
      prevValues[k] = map;
    });
  }

  function fmtPrice(v) { return v == null || !isFinite(v) ? '—' : Math.round(v).toLocaleString(); }

  /* The "As of" row must tell the truth about age: which feed, whether it's
   * delayed, and how stale THIS payload is — refreshed every few seconds so a
   * quiet failure can't masquerade as fresh data. Runs off lastPayload, so in
   * playback it honestly reports the archived snapshot's age. */
  function refreshAsof() {
    var el = document.getElementById('r-asof');
    if (!lastPayload) { el.textContent = '—'; return; }
    var src = /tradier/i.test(lastPayload.source || '') ? 'Tradier'
      : /cboe/i.test(lastPayload.source || '') ? 'CBOE delayed'
      : (lastPayload.source || '—');
    var stamp = Date.parse(lastPayload.computedAt || lastPayload.asof || '');
    var age = '';
    if (isFinite(stamp)) {
      var s = Math.max(0, Math.round((Date.now() - stamp) / 1000));
      age = s < 90 ? s + 's' : s < 5400 ? Math.round(s / 60) + 'm' : (s / 3600).toFixed(1) + 'h';
      el.title = new Date(stamp).toISOString();
    }
    el.textContent = src + (age ? ' · ' + age + ' old' : '');
  }
  setInterval(function () { if (!document.hidden) refreshAsof(); }, 5000);
  function fmtGex(v) {
    if (v == null || !isFinite(v)) return '—';
    var sign = v >= 0 ? '+' : '';
    var abs = Math.abs(v);
    var scaled = abs >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : abs >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v.toFixed(0);
    return sign + scaled;
  }

  function updateReadout(payload, greekKey) {
    var meta = GREEK_META[greekKey];
    document.getElementById('r-spot').textContent = fmtPrice(payload.spot);
    document.getElementById('r-cwall').textContent = fmtPrice(payload.landmarks.callWall);
    document.getElementById('r-pwall').textContent = fmtPrice(payload.landmarks.putWall);

    var flipRow = document.getElementById('r-flip-row');
    if (meta.flipField) {
      flipRow.style.display = '';
      document.getElementById('r-flip-label').textContent = meta.flipLabel;
      document.getElementById('r-flip').textContent = fmtPrice(payload.landmarks[meta.flipField]);
    } else {
      flipRow.style.display = 'none';
    }

    document.getElementById('r-net-label').textContent = meta.netLabel;
    var gexEl = document.getElementById('r-gex');
    var netVal = payload.landmarks[meta.netField];
    gexEl.textContent = fmtGex(netVal);
    gexEl.className = 'v mono ' + (netVal >= 0 ? 'call' : 'put');
    refreshAsof();

    // secondary (synapse) greeks: compact net-value readout for the other three
    var secondary = GREEK_ORDER.filter(function (k) { return k !== greekKey; });
    var satEl = document.getElementById('satStats');
    satEl.replaceChildren();
    secondary.forEach(function (k) {
      var m = GREEK_META[k];
      var v = payload.landmarks[m.netField];
      var row = document.createElement('div');
      row.className = 'stat';
      var kEl = document.createElement('span');
      kEl.className = 'k';
      kEl.textContent = m.netLabel;
      var vEl = document.createElement('span');
      vEl.className = 'v mono ' + (v >= 0 ? 'call' : 'put');
      vEl.textContent = fmtGex(v);
      row.append(kEl, vEl);
      satEl.append(row);
    });
  }

  function updateLegend(greekKey) {
    var meta = GREEK_META[greekKey];
    document.getElementById('legendPosWord').textContent = meta.posWord;
    document.getElementById('legendPosDesc').textContent = meta.posDesc;
    document.getElementById('legendNegWord').textContent = meta.negWord;
    document.getElementById('legendNegDesc').textContent = meta.negDesc;
    document.getElementById('greekSub').textContent = meta.subLabel;
    var flipRow = document.getElementById('legendFlipRow');
    if (meta.flipField) {
      flipRow.style.display = '';
      document.getElementById('legendFlipWord').textContent = meta.flipWord;
      document.getElementById('legendFlipDesc').textContent = meta.flipDesc;
    } else {
      flipRow.style.display = 'none';
    }

    var secondary = GREEK_ORDER.filter(function (k) { return k !== greekKey; });
    var satLegend = document.getElementById('satLegendRow');
    satLegend.replaceChildren();
    secondary.forEach(function (k) {
      var m = GREEK_META[k];
      var rgb = m.dotColor;
      var css = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
      var item = document.createElement('div');
      item.className = 'sat-item';
      var dot = document.createElement('span');
      dot.className = 'dot3';
      dot.style.background = css;
      dot.style.color = css;
      var label = document.createElement('span');
      label.className = 'label';
      label.innerHTML = '<b>' + m.short + '</b> synapse';
      item.append(dot, label);
      satLegend.append(item);
    });
  }

  // per-band net GEX in the top-left band key — the regime split across
  // expiries at a glance (0DTE can be short-gamma while the LEAPs are long)
  function updateBandTags(payload) {
    (payload.bandLandmarks || []).forEach(function (bl) {
      var el = document.getElementById('bnet-' + bl.name);
      if (!el) return;
      if (!bl.n) { el.textContent = '·'; el.className = 'bnet mono'; return; }
      el.textContent = fmtGex(bl.netGex);
      el.className = 'bnet mono ' + (bl.netGex >= 0 ? 'call' : 'put');
    });
  }

  // Regime headline: one plain-language line synthesizing the dealer read from
  // the all-expiry landmarks. The LEAD is always the gamma structure (net GEX
  // sign) — that's the market-structure fact walls/flip beams encode, and it's
  // stable regardless of which greek is on screen — followed by spot-vs-flip
  // and the wall range. When a non-gamma greek is the active shape, its net is
  // appended so switching greeks changes the sentence. All values are formatted
  // numbers (no user text), built with DOM nodes rather than innerHTML.
  function updateRegime(payload, greekKey) {
    var el = regimeEl;
    if (!el) return;
    if (!payload || !payload.landmarks) { el.classList.remove('show'); return; }
    var lm = payload.landmarks;
    var net = lm.netGex, spot = payload.spot, flip = lm.flip, cw = lm.callWall, pw = lm.putWall;
    var num = function (v) { return v != null && isFinite(v); };
    el.replaceChildren();
    var span = function (cls, txt) {
      var s = document.createElement('span');
      if (cls) s.className = cls;
      if (txt != null) s.textContent = txt;
      return s;
    };
    var addSep = function () { el.append(span('reg-sep', '·')); };
    // a reg-part whose last word is emphasized: leading plain text + a <b>
    var addPart = function (plain, boldTxt, boldColor) {
      var p = span('reg-part');
      if (plain) p.append(document.createTextNode(plain));
      if (boldTxt != null) {
        var b = document.createElement('b');
        b.textContent = boldTxt;
        if (boldColor) b.style.color = boldColor;
        p.append(b);
      }
      el.append(p);
    };

    var known = num(net);
    var lead = span('reg-lead' + (known ? (net >= 0 ? ' call' : ' put') : ''),
      known ? (net >= 0 ? 'Dealers long gamma' : 'Dealers short gamma') : 'Gamma regime forming');
    el.append(lead);

    if (known) { addSep(); addPart(net >= 0 ? 'dips bought, rips sold — ' : 'moves amplified — ', net >= 0 ? 'pinning' : 'trending'); }

    if (num(flip) && num(spot)) { addSep(); addPart(spot >= flip ? 'spot above flip ' : 'spot below flip ', fmtPrice(flip)); }

    if (num(cw) && num(pw)) {
      addSep();
      // a single strike can be both walls (thin/holiday book) — don't render "7,500–7,500"
      if (Math.round(cw) === Math.round(pw)) addPart('wall ', fmtPrice(cw));
      else addPart('walls ', fmtPrice(pw) + '–' + fmtPrice(cw));
    }
    else if (num(cw)) { addSep(); addPart('call wall ', fmtPrice(cw)); }
    else if (num(pw)) { addSep(); addPart('put wall ', fmtPrice(pw)); }

    if (greekKey !== 'gamma') {
      var m = GREEK_META[greekKey];
      var v = lm[m.netField];
      if (num(v)) { addSep(); addPart(m.netLabel + ' ', fmtGex(v), v >= 0 ? 'var(--call)' : 'var(--put)'); }
    }

    el.classList.add('show');
  }

  function renderActiveGreek() {
    if (!lastPayload) return;
    var built = buildScene(lastPayload, activeGreek);
    if (built) {
      scene = built;
      cameraDirty = true;
      armPulses(scene);
    }
    updateReadout(lastPayload, activeGreek);
    updateRegime(lastPayload, activeGreek);
    updateLegend(activeGreek);
    reconcileInspect(false); // greek changed: pin values update; the all-greek series is greek-agnostic
    redrawPinSparks();       // …so just re-emphasize the newly-active greek's line, no refetch
    requestRender();
  }

  // switch the primary greek (the shape). Shared by the chips and the 1-4/GVCD
  // keyboard shortcuts — both route through here so chip state, render, and
  // persistence stay in one place.
  function switchGreek(key) {
    if (!GREEK_META[key] || key === activeGreek) return;
    activeGreek = key;
    syncControlsToState();
    renderActiveGreek();
    flashSwitch();
    persistView();
    // remember against the symbol actually ON SCREEN — lastBuiltSymbol, not
    // currentSymbol: load() sets currentSymbol optimistically before its fetch
    // resolves, so during an in-flight symbol change the mesh (and lastPayload)
    // still belongs to lastBuiltSymbol. In playback the frozen pb.symbol is shown.
    rememberGreekForSymbol(pb.active ? pb.symbol : lastBuiltSymbol, key);
  }

  // reflect activeGreek / nearTermFocus in the controls — used at init (when
  // state comes from the URL or localStorage) and on every keyboard-driven change
  function syncControlsToState() {
    document.querySelectorAll('#greeks .chip').forEach(function (c) {
      c.classList.toggle('active', c.getAttribute('data-greek') === activeGreek);
    });
    focusToggle.textContent = 'Near-term focus: ' + (nearTermFocus ? 'ON' : 'OFF');
    focusToggle.setAttribute('aria-pressed', String(nearTermFocus));
  }

  document.querySelectorAll('#greeks .chip').forEach(function (chip) {
    chip.addEventListener('click', function () { switchGreek(chip.getAttribute('data-greek')); });
  });

  var pollFails = 0; // consecutive live-load failures, drives the retry backoff
  function nextPollDelay() { return Math.min(120000, POLL_MS * (1 + pollFails)); }

  async function load(sym) {
    if (pb.active) return; // no live load may touch the scene while playback owns it
    var seq = ++loadSeq;
    // currentSymbol updates optimistically so the poll loop retries the
    // REQUESTED symbol; the title/backLink update only on success, so the
    // header can never name a symbol whose data isn't actually on screen.
    currentSymbol = sym;
    setStatus('loading ' + sym + '…');
    try {
      // a hung upstream (cold rebuild against a flaky feed) must never stall
      // the poll chain forever — timeout, count it, back off, retry
      var res = await fetch('api/brain?symbol=' + encodeURIComponent(sym),
        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
      var json = await res.json().catch(function () { return null; });
      if (seq !== loadSeq) return; // superseded by a newer load
      if (!res.ok || !json || json.error) {
        throw new Error((json && json.error) || ('HTTP ' + res.status));
      }
      if (sym !== lastBuiltSymbol) {
        prevValues = {};  // never diff one symbol's strikes against another's
        pins = []; Object.keys(pinRows).forEach(dropPinRow); // pins name one symbol's strikes — clear on symbol switch
        hoverKey = null;
        lastBuiltSymbol = sym;
        // restore this symbol's remembered greek on an actual symbol change —
        // but honor an explicit ?greek for the symbol it NAMED. The pin is
        // symbol-scoped so a failed first load (which never reaches here) can't
        // let the URL greek leak onto whatever symbol renders first instead.
        // Runs after the fetch succeeded and right before buildScene, so chip +
        // mesh stay in sync (a failed load never reaches here → no mismatch).
        if (urlGreekSymbol === sym) {
          urlGreekSymbol = null; // consumed: the named symbol has now rendered with its URL greek
        } else {
          var remembered = greekForSymbol(sym);
          if (remembered && remembered !== activeGreek) { activeGreek = remembered; syncControlsToState(); }
        }
      }
      var built = buildScene(json, activeGreek);
      if (!built) throw new Error('mesh had no strikes in range');
      scene = built;
      cameraDirty = true;
      armPulses(scene);
      hideLoading();
      lastPayload = json;
      refreshBaselines(json);
      document.getElementById('titleTicker').textContent = sym;
      document.getElementById('backLink').href = 'index.html?symbol=' + encodeURIComponent(sym);
      updateReadout(json, activeGreek);
      updateRegime(json, activeGreek);
      updateLegend(activeGreek);
      updateBandTags(json);
      reconcileInspect(false); // live poll: refresh pin values, keep sparklines
      banner('');
      pollFails = 0;
      setStatus('live · ' + sym + ' · next refresh in ' + (POLL_MS / 1000) + 's', false);
      requestRender();
      persistView();     // normalize the URL to the current symbol/greek/focus/camera
      pushRecent(sym);   // remember successfully-loaded tickers for the symbol-box suggestions
    } catch (err) {
      if (seq !== loadSeq) return;
      hideLoading();     // first attempt is done — let the banner carry the error, drop the skeleton
      pollFails++;
      setStatus('error · ' + sym + ' · retry in ' + Math.round(nextPollDelay() / 1000) + 's', true);
      banner('Could not build the brain mesh for ' + sym + ': ' + err.message + '. Is "node gex/server.js" running?');
    }
  }

  function scheduleNext() {
    // the single choke point for re-arming the poll: an orphaned
    // load(...).then(scheduleNext) from a superseded live load must never
    // resurrect polling while playback owns the view
    if (pb.active) return;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () { load(currentSymbol).then(scheduleNext); }, nextPollDelay());
  }

  document.getElementById('load').addEventListener('click', function () {
    var sym = document.getElementById('symbol').value.trim().toUpperCase().replace(/[^A-Z^_.]/g, '');
    if (!sym) return;
    if (pb.active) exitPlayback(false); // a symbol switch always lands on the live view
    clearTimeout(pollTimer);
    load(sym).then(scheduleNext);
  });
  document.getElementById('symbol').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('load').click();
  });

  // ---------------------------------------------------------------- playback (archived snapshots)
  // Scrub the day's archived /api/brain snapshots — the "is the wall building
  // or pulling?" view. Entering playback pauses live polling and stashes the
  // diff-glow baselines; stepping seeds them from the previously SHOWN
  // snapshot, so the pulse layer becomes a genuine "what changed between these
  // two moments" signal while scrubbing. Exiting restores the live baselines
  // and resumes polling. Archived bodies are immutable, so fetched snapshots
  // cache for the session.
  var pb = {
    active: false, entering: false, symbol: '', day: '', days: [], list: [], idx: -1,
    cache: new Map(), playing: false, timer: null, savedPrev: null,
  };
  var pbShowSeq = 0;
  var histToggle = document.getElementById('histToggle');
  var pbBarEl = document.getElementById('pbBar');
  var pbSlider = document.getElementById('pbSlider');
  var pbTimeEl = document.getElementById('pbTime');
  var pbDaySel = document.getElementById('pbDay');
  var pbPlayBtn = document.getElementById('pbPlay');
  var PB_STEP_MS = 700;

  // crisp SVG play/pause glyphs — the raw ⏵/⏸ unicode renders inconsistently
  // across fonts/OSes. Static markup (no interpolation), so innerHTML is safe.
  var PLAY_SVG = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 1.5 L10.5 6 L2.5 10.5 Z" fill="currentColor"/></svg>';
  var PAUSE_SVG = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="2.6" y="1.5" width="2.4" height="9" rx="0.4" fill="currentColor"/><rect x="7" y="1.5" width="2.4" height="9" rx="0.4" fill="currentColor"/></svg>';
  function setPlayIcon(playing) {
    pbPlayBtn.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
    pbPlayBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function pbLabel(fileName) {
    var m = /^(\d{2})(\d{2})(\d{2})Z-([a-z]+)\.json$/.exec(fileName || '');
    return m ? m[1] + ':' + m[2] + ':' + m[3] + 'Z · ' + m[4] : fileName || '—';
  }

  async function fetchHistoryList(sym, day) {
    var q = 'api/brain/history?symbol=' + encodeURIComponent(sym) + (day ? '&day=' + encodeURIComponent(day) : '');
    // a hung list fetch would latch pb.entering and silently kill the HISTORY toggle
    var res = await fetch(q, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    var json = await res.json().catch(function () { return null; });
    if (!res.ok || !json || json.error) throw new Error((json && json.error) || ('HTTP ' + res.status));
    return json;
  }

  async function enterPlayback() {
    if (pb.active || pb.entering) return;
    pb.entering = true;
    var sym = currentSymbol; // pin: a symbol switch mid-fetch must not produce a mixed-symbol playback
    setStatus('loading archive…');
    try {
      var hist = await fetchHistoryList(sym);
      if (pb.active || sym !== currentSymbol) return; // superseded while the list loaded
      if (!hist.snapshots.length) {
        banner('No archived snapshots for ' + sym + ' yet — the archive builds while the server runs.');
        setStatus('live · ' + sym, false);
        return;
      }
      pb.active = true;
      pb.symbol = sym;
      pb.day = hist.day;
      pb.days = hist.days;
      pb.list = hist.snapshots;
      pb.idx = -1;
      ++loadSeq;               // invalidate any in-flight live poll
      clearTimeout(pollTimer); // pause live polling
      pb.savedPrev = prevValues;
      prevValues = {};
      histToggle.setAttribute('aria-pressed', 'true');
      pbBarEl.classList.add('on');
      pbDaySel.replaceChildren();
      pb.days.forEach(function (d) {
        var opt = document.createElement('option');
        opt.value = d; opt.textContent = d; opt.selected = d === pb.day;
        pbDaySel.append(opt);
      });
      pbSlider.max = pb.list.length - 1;
      showSnapshot(pb.list.length - 1); // land on the newest, scrub back from there
    } catch (err) {
      banner('History unavailable: ' + err.message);
      setStatus('live · ' + currentSymbol, false);
    } finally {
      pb.entering = false;
    }
  }

  function exitPlayback(returnToLive) {
    if (!pb.active) return;
    pb.active = false;
    stopPlay();
    pbBarEl.classList.remove('on');
    histToggle.setAttribute('aria-pressed', 'false');
    prevValues = pb.savedPrev || {};
    pb.savedPrev = null;
    if (returnToLive !== false) {
      clearTimeout(pollTimer);
      load(currentSymbol).then(scheduleNext);
    }
  }

  function pbFetch(i) {
    // key includes the SYMBOL: archive filenames are only HHMMSSZ-tag, and the
    // macro sweep archives the whole watchlist in the same second — a day/file
    // key alone would serve one symbol's book labeled as another's
    var key = pb.symbol + '/' + pb.day + '/' + pb.list[i];
    var hit = pb.cache.get(key);
    if (hit) return hit; // resolved payload or in-flight promise — concurrent callers share it
    if (pb.cache.size > 800) pb.cache.clear(); // ~25 MB worst case; immutable bodies re-fetch cheaply
    var symbol = pb.symbol;
    var promise = (async function () {
      var res = await fetch('api/brain/snapshot?symbol=' + encodeURIComponent(symbol) + '&day=' + pb.day + '&file=' + pb.list[i],
        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      var json = await res.json().catch(function () { return null; });
      if (!res.ok || !json || json.error) throw new Error((json && json.error) || ('HTTP ' + res.status));
      if (json.symbol && json.symbol !== symbol) throw new Error('archive returned ' + json.symbol + ' for ' + symbol);
      return json;
    })();
    pb.cache.set(key, promise);
    promise.catch(function () { pb.cache.delete(key); }); // a failed fetch must not poison the cache
    return promise;
  }

  async function showSnapshot(i) {
    if (!pb.active || !pb.list.length) return;
    i = Math.max(0, Math.min(pb.list.length - 1, i));
    var seq = ++pbShowSeq;
    try {
      var payload = await pbFetch(i);
      if (!pb.active || seq !== pbShowSeq) return; // superseded or exited mid-fetch
      pb.idx = i;
      pbSlider.value = i;
      var built = buildScene(payload, activeGreek);
      if (!built) return;
      scene = built;
      cameraDirty = true;
      armPulses(scene);
      hideLoading(); // entering playback during cold start counts as first paint — don't strand the skeleton
      lastPayload = payload; // greek chips + tooltips work on the frozen snapshot
      refreshBaselines(payload);
      updateReadout(payload, activeGreek);
      updateRegime(payload, activeGreek);
      updateLegend(activeGreek);
      updateBandTags(payload);
      reconcileInspect(false); // playback step: refresh pin values against the frozen snapshot
      pbTimeEl.textContent = pbLabel(pb.list[i]);
      setStatus('PLAYBACK · ' + pb.symbol + ' · ' + pb.day + ' · ' + (i + 1) + '/' + pb.list.length);
      requestRender();
    } catch (err) {
      if (!pb.active || seq !== pbShowSeq) return;
      if (pb.playing) stopPlay(); // a failing snapshot must not be retried at the play cadence forever
      setStatus('playback error', true);
      banner('Could not load snapshot: ' + err.message);
    }
  }

  function stopPlay() {
    pb.playing = false;
    clearInterval(pb.timer);
    setPlayIcon(false);
  }

  pbPlayBtn.addEventListener('click', function () {
    if (!pb.active) return;
    if (pb.playing) { stopPlay(); return; }
    // replay from the start: reset the index SYNCHRONOUSLY so the interval's
    // first tick can't see the old at-the-end index and stop immediately
    if (pb.idx >= pb.list.length - 1) pb.idx = -1;
    pb.playing = true;
    setPlayIcon(true);
    pb.timer = setInterval(function () {
      if (!pb.active || pb.idx >= pb.list.length - 1) { stopPlay(); return; }
      showSnapshot(pb.idx + 1);
    }, PB_STEP_MS);
  });

  pbSlider.addEventListener('input', function () {
    stopPlay(); // manual scrubbing takes the wheel
    showSnapshot(+pbSlider.value);
  });

  var pbDaySeq = 0;
  pbDaySel.addEventListener('change', async function () {
    stopPlay();
    var seq = ++pbDaySeq; // last SELECTION wins, not last response
    try {
      var hist = await fetchHistoryList(pb.symbol, pbDaySel.value);
      if (!pb.active || seq !== pbDaySeq) return;
      if (!hist.snapshots.length) {
        banner('No snapshots archived on ' + pbDaySel.value);
        pbDaySel.value = pb.day; // the select must reflect the day actually shown
        return;
      }
      pb.day = hist.day;
      pb.list = hist.snapshots;
      pbSlider.max = pb.list.length - 1;
      showSnapshot(0); // a past day plays from its open
    } catch (err) {
      if (seq !== pbDaySeq) return;
      banner('History unavailable: ' + err.message);
      pbDaySel.value = pb.day;
    }
  });

  document.getElementById('pbLive').addEventListener('click', function () { exitPlayback(true); });
  histToggle.addEventListener('click', function () {
    if (pb.active) exitPlayback(true); else enterPlayback();
  });

  document.addEventListener('keydown', function (e) {
    if (!pb.active) return;
    if (helpVisible()) return; // the help modal owns the keyboard — don't scrub/play behind it
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON') return;
    if (e.key === 'ArrowLeft') { stopPlay(); showSnapshot(pb.idx - 1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { stopPlay(); showSnapshot(pb.idx + 1); e.preventDefault(); }
    else if (e.key === ' ') { pbPlayBtn.click(); e.preventDefault(); }
  });

  // ---------------------------------------------------------------- keyboard shortcuts + help overlay
  // Everything reachable without leaving the mesh: greek switching, focus,
  // history, camera reset. The '?' panel documents them and auto-opens once on
  // a first visit (localStorage flag) for discoverability. Shortcuts never fire
  // while typing in the symbol box, while a modifier is held (don't clobber
  // browser chords), or while the help panel itself is open.
  var helpEl = document.getElementById('help');
  var HELP_SEEN_KEY = 'gex.brain.helpSeen';
  function helpVisible() { return helpEl.classList.contains('show'); }
  function openHelp() { helpEl.classList.add('show'); }
  function closeHelp() {
    helpEl.classList.remove('show');
    try { localStorage.setItem(HELP_SEEN_KEY, '1'); } catch (e) { /* private mode */ }
  }
  helpEl.addEventListener('click', function (e) { if (e.target === helpEl) closeHelp(); }); // backdrop click only

  var GREEK_KEYS = { '1': 'gamma', '2': 'vanna', '3': 'charm', '4': 'delta', g: 'gamma', v: 'vanna', c: 'charm', d: 'delta' };
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === '?') { helpVisible() ? closeHelp() : openHelp(); e.preventDefault(); return; }
    if (e.key === 'Escape') { if (helpVisible()) { closeHelp(); e.preventDefault(); } return; }
    if (helpVisible()) return; // panel open: swallow the rest until it's dismissed
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (GREEK_KEYS[k]) { switchGreek(GREEK_KEYS[k]); e.preventDefault(); }
    else if (k === 'f') { focusToggle.click(); e.preventDefault(); }
    else if (k === 'h') { histToggle.click(); e.preventDefault(); }
    else if (k === 'r') { resetCamera(); e.preventDefault(); }
  });

  // ---------------------------------------------------------------- legend collapse + share link
  var legendEl = document.getElementById('legend');
  var legendToggle = document.getElementById('legendToggle');
  var LEGEND_LS_KEY = 'gex.brain.legendCollapsed';
  function setLegendCollapsed(collapsed) {
    legendEl.classList.toggle('collapsed', collapsed);
    legendToggle.setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem(LEGEND_LS_KEY, collapsed ? '1' : '0'); } catch (e) { /* private mode */ }
  }
  legendToggle.addEventListener('click', function () {
    setLegendCollapsed(!legendEl.classList.contains('collapsed'));
  });

  // SHARE: copy a link to the exact current view. The URL is already the source
  // of truth (writeViewState keeps it current); flush any pending debounce first
  // so a just-moved camera is captured. Clipboard write is user-initiated and
  // local — best-effort with visible success/failure feedback on the button.
  var shareBtn = document.getElementById('shareBtn');
  var shareResetTimer = null;
  function shareFeedback(label, ok) {
    shareBtn.textContent = label;
    shareBtn.classList.toggle('copied', ok);
    clearTimeout(shareResetTimer);
    shareResetTimer = setTimeout(function () { shareBtn.textContent = 'SHARE'; shareBtn.classList.remove('copied'); }, 1400);
  }
  shareBtn.addEventListener('click', function () {
    flushViewState();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(location.href).then(
        function () { shareFeedback('COPIED', true); },
        function () { shareFeedback('COPY FAILED', false); }
      );
    } else {
      shareFeedback('COPY FAILED', false);
    }
  });

  // ---------------------------------------------------------------- init
  // Hydrate the view state before the first render: a ?greek/&focus/&cam query
  // (a shared link) wins over the personal localStorage default, which wins over
  // the hardcoded defaults. Camera values are clamped to the same bounds the
  // interactive handlers enforce, so a hand-edited or stale URL can't wedge the
  // view off-screen.
  var params = new URLSearchParams(location.search);
  var stored = readStoredPrefs();
  var finiteNum = function (v) { return typeof v === 'number' && isFinite(v); };
  var initial = (params.get('symbol') || 'SPX').toUpperCase().replace(/[^A-Z^_.]/g, '') || 'SPX';

  // greek precedence: URL ?greek (a shared link) > this symbol's remembered greek
  // > the global last-used greek > default. When ?greek is present it "pins" the
  // greek through the very first load so the per-symbol restore can't override it.
  var gp = String(params.get('greek') || greekForSymbol(initial) || stored.greek || 'gamma').toLowerCase();
  if (GREEK_META[gp]) activeGreek = gp;
  urlGreekSymbol = params.get('greek') ? initial : null;

  var fp = params.get('focus');
  if (fp == null) fp = stored.focus;
  if (fp === 0 || fp === '0' || fp === false || fp === 'false') nearTermFocus = false;
  else if (fp === 1 || fp === '1' || fp === true || fp === 'true') nearTermFocus = true;
  // otherwise keep the default (ON)

  var camStr = params.get('cam'), cam = null;
  if (camStr) {
    var parts = camStr.split(',').map(Number);
    if (parts.length === 3 && parts.every(function (n) { return isFinite(n); })) cam = parts;
  }
  // a MALFORMED ?cam= (present but unparseable) must still fall through to the
  // saved personal camera rather than clobber it with the hardcoded default —
  // separate `if`, not `else if`, so the localStorage tier is reachable
  if (!cam && finiteNum(stored.rotY) && finiteNum(stored.rotX) && finiteNum(stored.zoom)) {
    cam = [stored.rotY, stored.rotX, stored.zoom];
  }
  if (cam) {
    rotY = cam[0];
    rotX = Math.max(-1.1, Math.min(1.1, cam[1]));
    zoom = Math.max(0.55, Math.min(2.2, cam[2]));
  }

  syncControlsToState();
  refreshSymbolList();
  try { if (localStorage.getItem(LEGEND_LS_KEY) === '1') setLegendCollapsed(true); } catch (e) { /* private mode */ }
  resize();
  document.getElementById('symbol').value = initial;
  try { if (!localStorage.getItem(HELP_SEEN_KEY)) openHelp(); } catch (e) { /* private mode: just skip the intro */ }
  load(initial).then(scheduleNext);
})();
