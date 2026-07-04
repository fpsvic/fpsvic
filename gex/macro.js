'use strict';

/* GEX Macro — the triage view: one mini-brain per watchlist ticker, so the
 * whole tape's dealer-gamma picture reads at a glance before drilling into a
 * single symbol. Each card is a simplified brain (static camera, gamma only,
 * near-term emphasis baked in, no satellites/labels/interaction) that renders
 * EXACTLY ONCE per data arrival — there is no animation loop on this page at
 * all. Cards click through to the full brain view.
 *
 * Data: GET /api/brain?symbol=X&prefer=cboe per ticker through a small
 * concurrency pool. CBOE-first deliberately (one request per ticker) — a
 * Tradier-first fan-out would fire ~20 sequential per-expiry calls per name,
 * exactly the overload the scanner's preferCboe exists to avoid. Sweeps run
 * every 60s to match the server's cache TTL: polling faster only re-reads the
 * same memoized body.
 *
 * The watchlist is SHARED with the scanner (same localStorage key) — edits
 * happen there, this page just reads. */

(function () {
  // keep key + defaults in sync with scan.js
  var LS_KEY = 'gex.scan.watchlist';
  var DEFAULT_WATCHLIST = ['SPX', 'SPY', 'QQQ', 'IWM', 'NDX', 'RUT', 'AAPL', 'NVDA', 'TSLA', 'AMZN', 'META', 'MSFT', 'GOOGL', 'AMD'];
  var SWEEP_MS = 60000;
  var POOL = 3; // concurrent /api/brain fetches per sweep

  function loadWatchlist() {
    try {
      var a = JSON.parse(localStorage.getItem(LS_KEY));
      // a stored EMPTY list is a deliberate user state (they cleared it in the
      // scanner) and must show the empty state here — only a missing/corrupt
      // entry falls back to the defaults
      if (Array.isArray(a)) {
        return a.map(function (s) { return String(s).toUpperCase().replace(/[^A-Z^_.]/g, ''); }).filter(Boolean);
      }
    } catch { /* private mode / corrupt entry */ }
    return DEFAULT_WATCHLIST.slice();
  }

  var statusEl = document.getElementById('status');
  function setStatus(msg, isErr) {
    statusEl.textContent = msg;
    statusEl.className = isErr ? 'err' : '';
  }

  function fmtPrice(v) { return v == null || !isFinite(v) ? '—' : Math.round(v).toLocaleString(); }
  function fmtGex(v) {
    if (v == null || !isFinite(v)) return '—';
    var sign = v >= 0 ? '+' : '';
    var abs = Math.abs(v);
    var scaled = abs >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : abs >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v.toFixed(0);
    return sign + scaled;
  }

  // ---------------------------------------------------------------- mini renderer
  // Same dome geometry and camera as the full brain view, scaled to a card.
  var THETA_SPAN = 250 * Math.PI / 180;
  var BAND_META = {
    '0DTE': { radius: 110, phi: -30 * Math.PI / 180, tilt: 0, emph: 1 },
    'Weekly': { radius: 158, phi: -10 * Math.PI / 180, tilt: 6, emph: 1 },
    'Monthly': { radius: 206, phi: 10 * Math.PI / 180, tilt: 12, emph: 0.45 },
    'LEAP': { radius: 254, phi: 30 * Math.PI / 180, tilt: 18, emph: 0.28 },
  };
  var BUMP_SCALE = 34;
  var ROT_Y = 0.32, ROT_X = -0.72, FOCAL = 620;
  var COS_Y = Math.cos(ROT_Y), SIN_Y = Math.sin(ROT_Y);
  var COS_X = Math.cos(ROT_X), SIN_X = Math.sin(ROT_X);

  function drawMini(canvas, payload) {
    var dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    var cssW = canvas.clientWidth || 280, cssH = canvas.clientHeight || 150;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    var g = canvas.getContext('2d');
    g.clearRect(0, 0, canvas.width, canvas.height);

    var strikes = payload.strikes;
    if (!strikes.length) return;
    var maxAbs = 1e-9;
    payload.bands.forEach(function (b) { b.gex.forEach(function (v) { maxAbs = Math.max(maxAbs, Math.abs(v)); }); });

    var cx = canvas.width / 2, cy = canvas.height * 0.54;
    // fit the ~600-world-unit dome into the card width with a little margin
    var scale = (canvas.width / 640) * 0.92;

    function project(x, y, z) {
      var x1 = x * COS_Y - z * SIN_Y;
      var z1 = x * SIN_Y + z * COS_Y;
      var y2 = y * COS_X - z1 * SIN_X;
      var z2 = y * SIN_X + z1 * COS_X;
      var f = FOCAL / (FOCAL + z2) * scale;
      return { x: cx + x1 * f, y: cy - y2 * f, k: f / scale };
    }

    var n = strikes.length;
    payload.bands.forEach(function (band) {
      var meta = BAND_META[band.name] || { radius: 200, phi: 0, tilt: 0, emph: 1 };
      var ringPts = [];
      var nodes = [];
      band.gex.forEach(function (raw, si) {
        var gg = raw / maxAbs;
        var theta = (si / Math.max(1, n - 1) - 0.5) * THETA_SPAN;
        var r = meta.radius + gg * BUMP_SCALE;
        var p = project(
          r * Math.cos(meta.phi) * Math.sin(theta),
          r * Math.sin(meta.phi) - meta.tilt,
          r * Math.cos(meta.phi) * Math.cos(theta)
        );
        ringPts.push(p);
        var mag = Math.min(1, Math.abs(gg));
        if (mag > 0.02) nodes.push({ p: p, gg: gg, mag: mag });
      });

      // shell outline: one faint polyline through every strike position
      g.beginPath();
      ringPts.forEach(function (p, i) { if (i === 0) g.moveTo(p.x, p.y); else g.lineTo(p.x, p.y); });
      g.strokeStyle = 'rgba(90,110,128,' + (0.22 * meta.emph).toFixed(3) + ')';
      g.lineWidth = 0.7 * dpr;
      g.stroke();

      // nodes: plain fills, no shadows/sprites — this draws once a minute
      nodes.forEach(function (node) {
        var c = node.gg >= 0 ? '53,214,176' : '255,122,82';
        var alpha = (0.35 + 0.65 * node.mag) * 0.9 * meta.emph;
        var rad = (0.7 + node.mag * 1.9) * dpr * Math.max(0.5, node.p.k);
        g.beginPath();
        g.fillStyle = 'rgba(' + c + ',' + alpha.toFixed(3) + ')';
        g.arc(node.p.x, node.p.y, rad, 0, Math.PI * 2);
        g.fill();
      });
    });

    // spot beam: violet vertical through the shells at the spot price
    var spot = payload.spot;
    if (spot >= strikes[0] && spot <= strikes[n - 1] && n > 1) {
      var i = 0;
      while (i < n - 2 && strikes[i + 1] < spot) i++;
      var frac = i + (spot - strikes[i]) / (strikes[i + 1] - strikes[i] || 1);
      var th = (frac / (n - 1) - 0.5) * THETA_SPAN;
      var a = project(60 * Math.sin(th), -9, 60 * Math.cos(th));
      var b = project(300 * Math.sin(th), -9, 300 * Math.cos(th));
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.strokeStyle = 'rgba(198,143,255,0.5)';
      g.lineWidth = 1.4 * dpr;
      g.stroke();
    }
  }

  // ---------------------------------------------------------------- cards
  var grid = document.getElementById('grid');
  var cards = {};        // symbol -> { root, canvas, els }
  var prevNet = {};      // symbol -> netGex from the previous sweep, for mover badges
  var sweepSeq = 0;

  function makeCard(sym) {
    var root = document.createElement('div');
    root.className = 'card';
    root.addEventListener('click', function () {
      if (root.classList.contains('error')) return;
      location.href = 'brain.html?symbol=' + encodeURIComponent(sym);
    });

    var head = document.createElement('div');
    head.className = 'head';
    var symEl = document.createElement('span');
    symEl.className = 'sym';
    symEl.textContent = sym;
    var regime = document.createElement('span');
    regime.className = 'regime';
    regime.textContent = '…';
    head.append(symEl, regime);

    var spotEl = document.createElement('div');
    spotEl.className = 'spot';
    spotEl.innerHTML = 'spot <b>—</b>';

    var canvas = document.createElement('canvas');

    var stats = document.createElement('div');
    stats.className = 'stats';

    var mover = document.createElement('div');
    mover.className = 'mover';
    mover.textContent = '';

    root.append(head, spotEl, canvas, stats, mover);
    grid.append(root);
    return { root: root, canvas: canvas, regime: regime, spot: spotEl, stats: stats, mover: mover };
  }

  function renderCard(sym, payload) {
    var card = cards[sym] || (cards[sym] = makeCard(sym));
    card.lastPayload = payload; // kept so a resize/zoom can redraw without refetching
    var lm = payload.landmarks;
    var pos = lm.netGex >= 0;
    card.root.classList.remove('error');
    var staleErr = card.root.querySelector('.errmsg');
    if (staleErr) staleErr.remove(); // a recovered card must not keep last sweep's error text
    card.root.classList.toggle('pos', pos);
    card.root.classList.toggle('neg', !pos);
    card.regime.textContent = pos ? 'DEALERS LONG γ' : 'DEALERS SHORT γ';
    card.spot.innerHTML = 'spot <b class="mono">' + fmtPrice(payload.spot) + '</b>';

    card.stats.replaceChildren();
    [
      ['Net GEX', fmtGex(lm.netGex), pos ? 'gpos' : 'gneg'],
      ['Flip', fmtPrice(lm.flip), ''],
      ['C wall', fmtPrice(lm.callWall), ''],
      ['P wall', fmtPrice(lm.putWall), ''],
    ].forEach(function (row) {
      var span = document.createElement('span');
      span.innerHTML = row[0] + ' <b class="mono ' + row[2] + '">' + row[1] + '</b>';
      card.stats.append(span);
    });

    drawMini(card.canvas, payload);
    return lm.netGex;
  }

  function renderError(sym, msg) {
    var card = cards[sym] || (cards[sym] = makeCard(sym));
    card.root.classList.add('error');
    card.regime.textContent = 'NO DATA';
    // last sweep's mover badge no longer describes anything current
    card.mover.className = 'mover';
    card.mover.textContent = '';
    var err = card.root.querySelector('.errmsg');
    if (!err) {
      err = document.createElement('div');
      err.className = 'errmsg';
      card.root.append(err);
    }
    err.textContent = msg;
  }

  /* Mover badges: |ΔnetGex| vs the previous sweep, top movers called out.
   * Order stays fixed to the watchlist — a triage grid that reshuffles while
   * you're looking at it is worse than one that makes you scan. */
  function applyMoverBadges(results) {
    var movers = results
      .filter(function (r) { return r.ok && prevNet[r.sym] != null; })
      .map(function (r) { return { sym: r.sym, delta: r.net - prevNet[r.sym] }; })
      .filter(function (m) { return Math.abs(m.delta) > 0; })
      .sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });
    var topSet = new Set(movers.slice(0, 3).map(function (m) { return m.sym; }));

    results.forEach(function (r) {
      if (!r.ok || !cards[r.sym]) return;
      var el = cards[r.sym].mover;
      if (prevNet[r.sym] == null) { el.textContent = ''; return; }
      var d = r.net - prevNet[r.sym];
      if (d === 0) {
        el.className = 'mover';
        el.textContent = 'unchanged since last sweep';
        return;
      }
      el.className = 'mover ' + (d > 0 ? 'up' : 'down') + (topSet.has(r.sym) ? ' top' : '');
      el.textContent = (d > 0 ? '▲ ' : '▼ ') + fmtGex(d) + ' net γ since last sweep' + (topSet.has(r.sym) ? ' · TOP MOVER' : '');
    });
    results.forEach(function (r) { if (r.ok) prevNet[r.sym] = r.net; });
  }

  // ---------------------------------------------------------------- sweep loop
  async function fetchBrain(sym) {
    // one hung ticker must not wedge its pool worker for the rest of the sweep
    var res = await fetch('api/brain?symbol=' + encodeURIComponent(sym) + '&prefer=cboe',
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    var json = await res.json().catch(function () { return null; });
    if (!res.ok || !json || json.error) throw new Error((json && json.error) || ('HTTP ' + res.status));
    return json;
  }

  async function sweep() {
    var seq = ++sweepSeq;
    var syms = loadWatchlist();

    // reconcile cards with the list BEFORE the empty-state early-return, so
    // clearing the watchlist actually clears the grid
    Object.keys(cards).forEach(function (sym) {
      if (syms.indexOf(sym) === -1) {
        cards[sym].root.remove();
        delete cards[sym];
        delete prevNet[sym];
      }
    });
    document.getElementById('empty').style.display = syms.length ? 'none' : '';
    if (!syms.length) { setStatus('watchlist empty'); return; }

    // grid order is WATCHLIST order, not network-completion order: create
    // every card up front (placeholder state) and re-append in list order —
    // append moves an existing element, so mid-list additions land mid-grid
    // and the layout is identical on every reload (spatial memory matters in
    // a triage view)
    syms.forEach(function (sym) {
      if (!cards[sym]) cards[sym] = makeCard(sym);
      grid.append(cards[sym].root);
    });

    setStatus('sweeping ' + syms.length + ' tickers…');
    var queue = syms.slice();
    var results = [];
    var done = 0;

    async function worker() {
      while (queue.length) {
        if (seq !== sweepSeq) return; // superseded by a newer sweep
        var sym = queue.shift();
        try {
          var payload = await fetchBrain(sym);
          if (seq !== sweepSeq) return;
          var net = renderCard(sym, payload);
          results.push({ sym: sym, ok: true, net: net });
        } catch (err) {
          if (seq !== sweepSeq) return;
          renderError(sym, err.message);
          results.push({ sym: sym, ok: false });
        }
        done++;
        setStatus('sweeping… ' + done + '/' + syms.length);
      }
    }
    var workers = [];
    for (var i = 0; i < Math.min(POOL, syms.length); i++) workers.push(worker());
    await Promise.all(workers);
    if (seq !== sweepSeq) return;

    applyMoverBadges(results);
    var failed = results.filter(function (r) { return !r.ok; }).length;
    setStatus(
      'live · ' + (results.length - failed) + '/' + syms.length + ' tickers · next sweep in ' + (SWEEP_MS / 1000) + 's',
      failed > 0 && failed === results.length
    );
  }

  function loop() {
    sweep().finally(function () { setTimeout(loop, SWEEP_MS); });
  }
  loop();

  // resize / browser zoom (fires resize, changes devicePixelRatio) / a
  // background tab becoming visible all change the canvas CSS box out from
  // under the last raster — re-rasterize the minis from each card's cached
  // payload. A redraw on explicit user/window action, not an animation loop.
  function redrawAll() {
    Object.keys(cards).forEach(function (sym) {
      var card = cards[sym];
      if (card.lastPayload) drawMini(card.canvas, card.lastPayload);
    });
  }
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawAll, 150);
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) redrawAll();
  });
})();
