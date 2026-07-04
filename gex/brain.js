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
    var nodeGrid = {};
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
          pulseAmt: pulseAmt,
          satellites: satellites,
          // filled per applyDerived(): emph, drawBase, sprite
          emph: 1, drawBase: 0, sprite: null,
          // per-camera-pass scratch: projected position + perspective factor
          px: 0, py: 0, pz: 0, pk: 1,
        };
        nodes.push(node);
        nodeGrid[band.name + '_' + si] = node;
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

    var built = {
      nodes: nodes, ringEdges: ringEdges, radialEdges: radialEdges, nodeGrid: nodeGrid,
      beams: beams, strikes: strikes, spot: payload.spot,
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
  });

  // ---------------------------------------------------------------- camera / interaction
  // Static by default (trading tool, not a screensaver) — a steeper top-down
  // tilt than the original demo angle so the concentric strike rings read
  // clearly at a glance instead of edge-on. Rotation only ever happens from an
  // explicit drag; it never auto-resumes.
  var rotY = 0.32, rotX = -0.72;
  var dragging = false, lastX = 0, lastY = 0, zoom = 1;

  canvas.addEventListener('pointerdown', function (e) {
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    canvas.classList.add('dragging');
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    rotY += dx * 0.006;
    rotX = Math.max(-1.1, Math.min(1.1, rotX + dy * 0.006));
    cameraDirty = true;
    requestRender();
  });
  function endDrag() { dragging = false; canvas.classList.remove('dragging'); }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    zoom = Math.max(0.55, Math.min(2.2, zoom * (1 - e.deltaY * 0.001)));
    cameraDirty = true;
    requestRender();
  }, { passive: false });

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

    // 5) on-mesh price labels, one per beam, anchored at the beam's chosen
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
    document.getElementById('r-asof').textContent = payload.source ? payload.source.replace(/\s*\(.*\)/, '') : (payload.asof || '—');

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

  function renderActiveGreek() {
    if (!lastPayload) return;
    var built = buildScene(lastPayload, activeGreek);
    if (built) {
      scene = built;
      cameraDirty = true;
      armPulses(scene);
    }
    updateReadout(lastPayload, activeGreek);
    updateLegend(activeGreek);
    requestRender();
  }

  document.querySelectorAll('#greeks .chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var key = chip.getAttribute('data-greek');
      if (key === activeGreek) return;
      activeGreek = key;
      document.querySelectorAll('#greeks .chip').forEach(function (c) { c.classList.toggle('active', c === chip); });
      renderActiveGreek();
    });
  });

  async function load(sym) {
    var seq = ++loadSeq;
    // currentSymbol updates optimistically so the poll loop retries the
    // REQUESTED symbol; the title/backLink update only on success, so the
    // header can never name a symbol whose data isn't actually on screen.
    currentSymbol = sym;
    setStatus('loading ' + sym + '…');
    try {
      var res = await fetch('api/brain?symbol=' + encodeURIComponent(sym), { headers: { accept: 'application/json' } });
      var json = await res.json().catch(function () { return null; });
      if (seq !== loadSeq) return; // superseded by a newer load
      if (!res.ok || !json || json.error) {
        throw new Error((json && json.error) || ('HTTP ' + res.status));
      }
      if (sym !== lastBuiltSymbol) {
        prevValues = {}; // never diff one symbol's strikes against another's
        lastBuiltSymbol = sym;
      }
      var built = buildScene(json, activeGreek);
      if (!built) throw new Error('mesh had no strikes in range');
      scene = built;
      cameraDirty = true;
      armPulses(scene);
      lastPayload = json;
      refreshBaselines(json);
      document.getElementById('titleTicker').textContent = sym;
      document.getElementById('backLink').href = 'index.html?symbol=' + encodeURIComponent(sym);
      updateReadout(json, activeGreek);
      updateLegend(activeGreek);
      banner('');
      setStatus('live · ' + sym + ' · next refresh in ' + (POLL_MS / 1000) + 's', false);
      requestRender();
    } catch (err) {
      if (seq !== loadSeq) return;
      setStatus('error · ' + sym, true);
      banner('Could not build the brain mesh for ' + sym + ': ' + err.message + '. Is "node gex/server.js" running?');
    }
  }

  function scheduleNext() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () { load(currentSymbol).then(scheduleNext); }, POLL_MS);
  }

  document.getElementById('load').addEventListener('click', function () {
    var sym = document.getElementById('symbol').value.trim().toUpperCase().replace(/[^A-Z^_.]/g, '');
    if (!sym) return;
    clearTimeout(pollTimer);
    load(sym).then(scheduleNext);
  });
  document.getElementById('symbol').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('load').click();
  });

  // initial canvas setup + seed from ?symbol=
  resize();
  var params = new URLSearchParams(location.search);
  var initial = (params.get('symbol') || 'SPX').toUpperCase().replace(/[^A-Z^_.]/g, '') || 'SPX';
  document.getElementById('symbol').value = initial;
  load(initial).then(scheduleNext);
})();
