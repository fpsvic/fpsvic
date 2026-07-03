'use strict';

/* GEX Brain — a 3D gamma mesh: nested expiry shells (0DTE/Weekly/Monthly/LEAP),
 * each a ring of strikes wrapped around a hemisphere. Gamma sign/magnitude
 * deforms the surface: positive (call-side, dealer-stabilizing) bulges outward
 * as a "gyrus", negative (put-side, destabilizing) folds inward as a "sulcus".
 *
 * Data comes from GET /api/brain?symbol=SYM (server.js, backed by
 * GexExposure.computeMeshBands) on a polling interval — the underlying app has
 * no snapshot history yet, so "recently changed" nodes get a transient pulse
 * (diffed against the previous poll) as a live-only stand-in for real history.
 *
 * Rendering is plain Canvas 2D with a hand-rolled rotation/perspective
 * projection — no WebGL library needed for a few hundred nodes. */

(function () {
  var canvas = document.getElementById('stage');
  var ctx = canvas.getContext('2d');
  var DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

  function resize() {
    canvas.width = Math.floor(window.innerWidth * DPR);
    canvas.height = Math.floor(window.innerHeight * DPR);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

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
      flipField: 'flip', flipWord: 'Flip ring', flipDesc: '— nearest zero-gamma crossing',
      netLabel: 'Net GEX', netField: 'netGex', flipLabel: 'Gamma flip',
    },
    vanna: {
      key: 'vanna', subLabel: 'vanna', short: 'Vanna', angle: 90, dotColor: [90, 160, 255],
      posWord: 'Gyrus', posDesc: '(bulge out) — positive vanna, delta rises as vol rises',
      negWord: 'Sulcus', negDesc: '(fold in) — negative vanna, delta falls as vol rises',
      flipField: 'vannaFlip', flipWord: 'Flip ring', flipDesc: '— nearest zero-vanna crossing',
      netLabel: 'Net Vanna', netField: 'netVanna', flipLabel: 'Vanna flip',
    },
    charm: {
      key: 'charm', subLabel: 'charm', short: 'Charm', angle: 180, dotColor: [255, 196, 80],
      posWord: 'Gyrus', posDesc: '(bulge out) — positive charm, delta hedge builds long as time passes',
      negWord: 'Sulcus', negDesc: '(fold in) — negative charm, delta hedge decays short as time passes',
      flipField: 'charmFlip', flipWord: 'Flip ring', flipDesc: '— nearest zero-charm crossing',
      netLabel: 'Net Charm', netField: 'netCharm', flipLabel: 'Charm flip',
    },
    delta: {
      key: 'delta', subLabel: 'delta', short: 'Delta', angle: 270, dotColor: [255, 110, 180],
      posWord: 'Gyrus', posDesc: '(bulge out) — dealer net long delta at this strike/expiry',
      negWord: 'Sulcus', negDesc: '(fold in) — dealer net short delta at this strike/expiry',
      flipField: null, flipWord: null, flipDesc: null,
      netLabel: 'Net Delta (in range)', netField: 'netDelta', flipLabel: null,
    },
  };
  var GREEK_ORDER = ['gamma', 'vanna', 'charm', 'delta']; // fixed synapse angle slots, stable across primary switches
  var activeGreek = 'gamma';
  var SATELLITE_THRESHOLD = 0.08; // |normalized value| below this doesn't draw a synapse (keeps quiet strikes clean)

  function noise(i, seed) {
    var v = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
    return v - Math.floor(v);
  }

  // Mutable scene state, rebuilt whenever a new snapshot lands OR the active greek changes.
  var scene = { nodes: [], ringEdges: [], radialEdges: [], nodeGrid: {}, spotBeam: [], landmarks: null, strikes: [] };
  var lastPayload = null;
  var prevValues = {}; // greekKey -> Map("band_strike" -> normalized value), for the diff-glow, kept per-greek so switching tabs never fakes a pulse

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
    var changed = new Map(); // "band_strike" -> |delta| normalized, for pulse seeding
    var nextValues = new Map();

    bands.forEach(function (band) {
      var meta = BAND_META[band.name] || { radius: 200, phi: 0, tilt: 0 };
      band[arrKey].forEach(function (raw, si) {
        var g = raw / maxAbs; // normalize to roughly [-1, 1] across the whole mesh, for THIS greek
        var key = band.name + '_' + strikes[si];
        var prior = prevForGreek.has(key) ? prevForGreek.get(key) : g;
        var delta = Math.abs(g - prior);
        if (delta > 0.03) changed.set(key, Math.min(1, delta * 4));
        nextValues.set(key, g);

        var theta = (si / Math.max(1, strikes.length - 1) - 0.5) * THETA_SPAN;
        var bump = g * BUMP_SCALE;
        var r = meta.radius + bump;
        var x = r * Math.cos(meta.phi) * Math.sin(theta);
        var y = r * Math.sin(meta.phi) - meta.tilt;
        var z = r * Math.cos(meta.phi) * Math.cos(theta);
        var satellites = secondaryKeys.map(function (k) {
          return { key: k, norm: band[GREEK_META[k].key][si] / secMaxAbs[k], angle: GREEK_META[k].angle * Math.PI / 180 };
        });
        var node = {
          x: x, y: y, z: z, band: band.name, si: si, strike: strikes[si], g: g, raw: raw,
          phase: noise(si, band.name.length * 3 + 1) * Math.PI * 2,
          pulse: changed.has(key) ? changed.get(key) : 0,
          pulseT: 0,
          satellites: satellites,
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

    // spot beam: nearest strike index to spot
    var spotIdx = 0, bestDist = Infinity;
    strikes.forEach(function (s, i) { var d = Math.abs(s - payload.spot); if (d < bestDist) { bestDist = d; spotIdx = i; } });
    var spotTheta = (spotIdx / Math.max(1, strikes.length - 1) - 0.5) * THETA_SPAN;
    var spotBeam = [];
    for (var rr = 60; rr <= 300; rr += 6) {
      spotBeam.push({ x: rr * Math.sin(spotTheta), y: -9, z: rr * Math.cos(spotTheta) });
    }

    function nearestIdx(price) {
      if (price == null) return -1;
      var idx = -1, best = Infinity;
      strikes.forEach(function (s, i) { var d = Math.abs(s - price); if (d < best) { best = d; idx = i; } });
      return idx;
    }
    var meta = GREEK_META[greekKey];
    var flipPrice = meta.flipField ? payload.landmarks[meta.flipField] : null;
    var landmarks = {
      callWallIdx: nearestIdx(payload.landmarks.callWall),
      putWallIdx: nearestIdx(payload.landmarks.putWall),
      flipIdx: nearestIdx(flipPrice),
      raw: payload.landmarks,
    };

    return { nodes: nodes, ringEdges: ringEdges, radialEdges: radialEdges, nodeGrid: nodeGrid, spotBeam: spotBeam, landmarks: landmarks, strikes: strikes, spot: payload.spot };
  }

  // ---------------------------------------------------------------- camera / interaction
  // Static by default (trading tool, not a screensaver) — a steeper top-down
  // tilt than the original demo angle so the concentric strike rings read
  // clearly at a glance instead of edge-on. Rotation only ever happens from an
  // explicit drag; it never auto-resumes.
  var rotY = 0.32, rotX = -0.72;
  var autoRotate = false;
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
  });
  function endDrag() { dragging = false; canvas.classList.remove('dragging'); }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    zoom = Math.max(0.55, Math.min(2.2, zoom * (1 - e.deltaY * 0.001)));
  }, { passive: false });

  // ---------------------------------------------------------------- near-term focus
  // Short-term trading cares about 0DTE/Weekly gamma; Monthly/LEAP ride along
  // for context but visually recede by default (dimmer, smaller) rather than
  // competing for attention. Applied at render time (not baked into the scene)
  // so the toggle below is instant with no rebuild.
  var NEAR_TERM_EMPHASIS = { '0DTE': 1, 'Weekly': 1, 'Monthly': 0.45, 'LEAP': 0.28 };
  var FULL_EMPHASIS = { '0DTE': 1, 'Weekly': 1, 'Monthly': 1, 'LEAP': 1 };
  var nearTermFocus = true;
  function emphasisFor(bandName) { return (nearTermFocus ? NEAR_TERM_EMPHASIS : FULL_EMPHASIS)[bandName] || 1; }

  var focusToggle = document.getElementById('focusToggle');
  focusToggle.addEventListener('click', function () {
    nearTermFocus = !nearTermFocus;
    focusToggle.textContent = 'Near-term focus: ' + (nearTermFocus ? 'ON' : 'OFF');
    focusToggle.setAttribute('aria-pressed', String(nearTermFocus));
  });

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function project(p, cx, cy, scale) {
    var cosY = Math.cos(rotY), sinY = Math.sin(rotY);
    var x1 = p.x * cosY - p.z * sinY;
    var z1 = p.x * sinY + p.z * cosY;
    var cosX = Math.cos(rotX), sinX = Math.sin(rotX);
    var y2 = p.y * cosX - z1 * sinX;
    var z2 = p.y * sinX + z1 * cosX;
    var focal = 620;
    var f = focal / (focal + z2) * scale;
    return { x: cx + x1 * f, y: cy - y2 * f, f: f, z: z2 };
  }

  function colorFor(g, alpha) {
    var t = Math.max(-1, Math.min(1, g));
    var call = [53, 214, 176], put = [255, 122, 82];
    var c = t >= 0 ? call : put;
    var mag = Math.min(1, Math.abs(t));
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (alpha * (0.35 + 0.65 * mag)).toFixed(3) + ')';
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

  var t0 = performance.now();
  function frame(now) {
    var dt = (now - t0) / 1000; t0 = now;
    if (autoRotate && !reduceMotion) rotY += dt * 0.06;

    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    var cx = w / 2, cy = h / 2 + 40 * DPR;
    var scale = DPR * 1.55 * zoom;
    var time = now / 1000;

    var nodes = scene.nodes;
    if (nodes.length) {
      var proj = nodes.map(function (n) {
        n.pulseT += dt;
        var decay = Math.max(0, n.pulse - n.pulseT * 0.7);
        var breathe = reduceMotion ? 1 : (0.85 + 0.15 * Math.sin(time * 1.6 + n.phase));
        var pulseBoost = 1 + decay * 1.8;
        var p = project(n, cx, cy, scale);
        return { n: n, p: p, mag: breathe * pulseBoost, glow: decay };
      });
      var byZ = proj.slice().sort(function (a, b) { return a.p.z - b.p.z; });

      var edgeSegs = scene.ringEdges.map(function (e) {
        var a = project(e[0], cx, cy, scale), b = project(e[1], cx, cy, scale);
        return { a: a, b: b, z: (a.z + b.z) / 2, g: (e[0].g + e[1].g) / 2, emph: emphasisFor(e[0].band) };
      }).concat(scene.radialEdges.map(function (e) {
        var a = project(e[0], cx, cy, scale), b = project(e[1], cx, cy, scale);
        var emph = (emphasisFor(e[0].band) + emphasisFor(e[1].band)) / 2;
        return { a: a, b: b, z: (a.z + b.z) / 2, g: (e[0].g + e[1].g) / 2, radial: true, emph: emph };
      }));
      edgeSegs.sort(function (a, b) { return a.z - b.z; });
      edgeSegs.forEach(function (e) {
        ctx.beginPath();
        ctx.moveTo(e.a.x, e.a.y);
        ctx.lineTo(e.b.x, e.b.y);
        ctx.strokeStyle = e.radial ? 'rgba(90,110,128,' + (0.16 * e.emph).toFixed(3) + ')' : colorFor(e.g, 0.28 * e.emph);
        ctx.lineWidth = (e.radial ? 0.6 : 0.9) * DPR;
        ctx.stroke();
      });

      if (scene.spotBeam.length) {
        var beamProj = scene.spotBeam.map(function (p) { return project(p, cx, cy, scale); });
        ctx.beginPath();
        beamProj.forEach(function (p, idx) { if (idx === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        var grad = ctx.createLinearGradient(beamProj[0].x, beamProj[0].y, beamProj[beamProj.length - 1].x, beamProj[beamProj.length - 1].y);
        grad.addColorStop(0, 'rgba(198,143,255,0.05)');
        grad.addColorStop(0.5, 'rgba(198,143,255,0.55)');
        grad.addColorStop(1, 'rgba(198,143,255,0.05)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.4 * DPR;
        ctx.shadowColor = 'rgba(198,143,255,0.8)';
        ctx.shadowBlur = 14 * DPR;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      byZ.forEach(function (item) {
        var n = item.n, p = item.p;
        var emph = emphasisFor(n.band);
        var baseR = (1.6 + Math.abs(n.g) * 2.6) * item.mag;
        var r = baseR * Math.max(0.35, p.f / scale * 0.9) * DPR * (0.55 + 0.45 * emph);
        var lm = scene.landmarks;
        var special = lm && ((lm.callWallIdx >= 0 && n.band === '0DTE' && n.si === lm.callWallIdx) ||
                              (lm.putWallIdx >= 0 && n.band === '0DTE' && n.si === lm.putWallIdx));
        var col = colorFor(n.g, 0.9 * emph);
        ctx.beginPath();
        ctx.fillStyle = col;
        ctx.shadowColor = item.glow > 0.02 ? 'rgba(244,247,250,' + Math.min(1, item.glow).toFixed(2) + ')' : col;
        ctx.shadowBlur = (special ? 22 : item.glow > 0.02 ? 16 : 9) * DPR * emph;
        ctx.arc(p.x, p.y, Math.max(0.8, r), 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        if (special) {
          var isCall = lm.callWallIdx >= 0 && n.si === lm.callWallIdx;
          ctx.beginPath();
          ctx.strokeStyle = isCall ? 'rgba(53,214,176,0.9)' : 'rgba(255,122,82,0.9)';
          ctx.lineWidth = 1.4 * DPR;
          ctx.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2);
          ctx.stroke();
        }

        // synapses: the three non-primary greeks, orbiting this node at a
        // FIXED angle per greek (no spin — a rotating position can't serve as
        // an identifier). Color identifies WHICH greek (own hue per greek,
        // stable across which one is primary); filled vs hollow-ring is sign
        // (+/-); distance from the node is magnitude. A faint spoke connects
        // the node to the dot so small orbits stay traceable.
        (n.satellites || []).forEach(function (sat) {
          if (Math.abs(sat.norm) < SATELLITE_THRESHOLD) return;
          var ang = sat.angle;
          var orbitR = (4 + Math.min(1, Math.abs(sat.norm)) * 11) * DPR * Math.max(0.35, p.f / scale * 0.9);
          var sx = p.x + Math.cos(ang) * orbitR;
          var sy = p.y + Math.sin(ang) * orbitR * 0.55; // flatten for a pseudo-3D orbit under this camera tilt
          var rgb = GREEK_META[sat.key].dotColor;
          var mag = Math.min(1, Math.abs(sat.norm));
          var alpha = (0.55 + 0.4 * mag) * emph;
          var scol = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha.toFixed(3) + ')';
          var dotR = Math.max(0.7, (1.1 + mag * 1.1) * DPR);

          ctx.beginPath();
          ctx.strokeStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (0.22 * emph).toFixed(3) + ')';
          ctx.lineWidth = 0.6 * DPR;
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(sx, sy);
          ctx.stroke();

          ctx.beginPath();
          ctx.shadowColor = scol;
          ctx.shadowBlur = 5 * DPR * emph;
          ctx.arc(sx, sy, dotR, 0, Math.PI * 2);
          if (sat.norm >= 0) {
            ctx.fillStyle = scol;
            ctx.fill();
          } else {
            ctx.strokeStyle = scol;
            ctx.lineWidth = 1.1 * DPR;
            ctx.stroke();
          }
          ctx.shadowBlur = 0;
        });
      });

      var lm2 = scene.landmarks;
      var flipNode = lm2 && lm2.flipIdx >= 0 ? scene.nodeGrid['0DTE_' + lm2.flipIdx] : null;
      if (flipNode) {
        var fp = project(flipNode, cx, cy, scale);
        var pulse2 = reduceMotion ? 1 : (0.7 + 0.3 * Math.sin(time * 2.2));
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(230,236,242,' + (0.55 * pulse2).toFixed(2) + ')';
        ctx.lineWidth = 1.6 * DPR;
        ctx.arc(fp.x, fp.y, 9 * DPR * pulse2 + 4 * DPR, 0, Math.PI * 2);
        ctx.stroke();
      }

      // on-mesh price labels: spot, call/put wall, and the active greek's
      // flip. Collected first (not drawn immediately) so overlapping labels —
      // common when a wall and the flip sit at neighboring strikes — can be
      // pushed apart instead of rendering as unreadable stacked text.
      if (lm2 && lm2.raw) {
        var raw = lm2.raw;
        var pending = [];
        if (scene.spotBeam.length) {
          var spotTop = project(scene.spotBeam[scene.spotBeam.length - 1], cx, cy, scale);
          pending.push({ text: 'SPOT ' + fmtPrice(scene.spot), x: spotTop.x, y: spotTop.y - 10 * DPR, color: '#e6ecf2', dir: -1 });
        }
        var sameWallStrike = lm2.callWallIdx >= 0 && lm2.callWallIdx === lm2.putWallIdx;
        var cwNode = lm2.callWallIdx >= 0 ? scene.nodeGrid['0DTE_' + lm2.callWallIdx] : null;
        if (cwNode) {
          var cwp = project(cwNode, cx, cy, scale);
          var wallText = sameWallStrike ? 'CALL+PUT WALL ' + fmtPrice(raw.callWall) : 'CALL WALL ' + fmtPrice(raw.callWall);
          pending.push({ text: wallText, x: cwp.x, y: cwp.y - 13 * DPR, color: '#35d6b0', dir: -1 });
        }
        if (!sameWallStrike) {
          var pwNode = lm2.putWallIdx >= 0 ? scene.nodeGrid['0DTE_' + lm2.putWallIdx] : null;
          if (pwNode) {
            var pwp = project(pwNode, cx, cy, scale);
            pending.push({ text: 'PUT WALL ' + fmtPrice(raw.putWall), x: pwp.x, y: pwp.y + 15 * DPR, color: '#ff7a52', dir: 1 });
          }
        }
        if (flipNode) {
          var flipMeta = GREEK_META[activeGreek];
          var flipVal = flipMeta.flipField ? raw[flipMeta.flipField] : null;
          if (flipVal != null) pending.push({ text: flipMeta.flipLabel.toUpperCase() + ' ' + fmtPrice(flipVal), x: fp.x, y: fp.y + 16 * DPR, color: '#e6ecf2', dir: 1 });
        }

        // anti-overlap: any label whose anchor lands within ~22px of an
        // already-placed label gets pushed further along its own direction
        // (above labels push further up, below labels push further down)
        // until it clears — cheap, but enough for the handful of labels here.
        var placed = [];
        pending.forEach(function (lbl) {
          var y = lbl.y;
          var guard = 0;
          while (placed.some(function (p) { return Math.abs(p.x - lbl.x) < 90 * DPR && Math.abs(p.y - y) < 22 * DPR; }) && guard < 6) {
            y += lbl.dir * 18 * DPR;
            guard++;
          }
          placed.push({ x: lbl.x, y: y });
          drawLabel(lbl.text, lbl.x, y, lbl.color);
        });
      }
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---------------------------------------------------------------- data loop
  var POLL_MS = 20000;
  var pollTimer = null;
  var currentSymbol = 'SPX';
  var loadSeq = 0;

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
    if (built) scene = built;
    updateReadout(lastPayload, activeGreek);
    updateLegend(activeGreek);
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
    currentSymbol = sym;
    document.getElementById('titleTicker').textContent = sym;
    document.getElementById('backLink').href = 'index.html?symbol=' + encodeURIComponent(sym);
    setStatus('loading ' + sym + '…');
    try {
      var res = await fetch('api/brain?symbol=' + encodeURIComponent(sym), { headers: { accept: 'application/json' } });
      var json = await res.json().catch(function () { return null; });
      if (seq !== loadSeq) return; // superseded by a newer load
      if (!res.ok || !json || json.error) {
        throw new Error((json && json.error) || ('HTTP ' + res.status));
      }
      var built = buildScene(json, activeGreek);
      if (!built) throw new Error('mesh had no strikes in range');
      scene = built;
      lastPayload = json;
      updateReadout(json, activeGreek);
      updateLegend(activeGreek);
      banner('');
      setStatus('live · ' + sym + ' · next refresh in ' + (POLL_MS / 1000) + 's', false);
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

  // seed from ?symbol=
  var params = new URLSearchParams(location.search);
  var initial = (params.get('symbol') || 'SPX').toUpperCase().replace(/[^A-Z^_.]/g, '') || 'SPX';
  document.getElementById('symbol').value = initial;
  load(initial).then(scheduleNext);
})();
