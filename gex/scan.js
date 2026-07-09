'use strict';

/* Personal GEX Scanner — rank a watchlist by vol mispricing.
 *
 * The server does the heavy lifting (one compact row per ticker from
 * /api/scan/row, computed with the SAME exposure/vol/score code the dashboard
 * uses); this file drives a small concurrency pool, ranks the rows by |score|,
 * and click-throughs each into the single-ticker dashboard. The offline Demo
 * scan builds synthetic rows client-side via GexExposure.scanRowFromChain — the
 * exact assembler the server uses — so it can never drift from the live path. */

// ---------------------------------------------------------------- config

const DEFAULT_WATCHLIST = ['SPX', 'SPY', 'QQQ', 'IWM', 'NDX', 'RUT', 'AAPL', 'NVDA', 'TSLA', 'AMZN', 'META', 'MSFT', 'GOOGL', 'AMD'];
const LS_KEY = 'gex.scan.watchlist';
const POOL = 4;                 // concurrent /api/scan/row fetches
const ROW_TIMEOUT = 30_000;     // per-row abort (a cold 13 MB index chain can take a few seconds)
const MAX_WATCH = 40;
const AI_TOP = 10;              // how many top picks to read
const AI_MIN_CONFIDENCE = 0.6;  // don't spend Claude on thin reads
const AI_POOL = 3;              // concurrent /api/analyze calls (10 reads at pool 2 would crawl)

const REGIME_LABELS = {
  pinned_range: 'Pinned range', drift_grind: 'Drift / grind', squeeze_risk: 'Squeeze risk',
  stress_expansion: 'Stress expansion', transition: 'Transition',
};
const CONF_RANK = { high: 0, medium: 1, low: 2 };

// plain-language chip text per signal, keyed by lean (x sign)
const WHY_TEXT = {
  vrp: (rich) => (rich ? 'vol rich' : 'vol cheap'),
  slope: (rich) => (rich ? 'backwardation' : 'steep contango'),
  fly: (rich) => (rich ? 'wings bid' : 'wings soft'),
  conv: (rich) => (rich ? 'convexity bid' : 'convexity offered'),
};

// ---------------------------------------------------------------- dom helpers (app.js idiom)

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (k in node && k !== 'style') node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

function fmtDollars(v) {
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  const trim = (x, d) => x.toFixed(d).replace(/\.?0+$/, '');
  if (a >= 1e12) return `${sign}$${trim(a / 1e12, 2)}T`;
  if (a >= 1e9) return `${sign}$${trim(a / 1e9, 2)}B`;
  if (a >= 1e6) return `${sign}$${trim(a / 1e6, 1)}M`;
  if (a >= 1e3) return `${sign}$${trim(a / 1e3, 0)}K`;
  return `${sign}$${a.toFixed(0)}`;
}
function fmtStrike(v) {
  if (v == null || !isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: v < 100 ? 2 : 0 });
}
function sgn(v, d = 1) { return v == null || !isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}`; }

// ---------------------------------------------------------------- state

let watchlist = loadWatchlist();
let results = new Map();   // symbol -> { symbol, status:'queued'|'loading'|'done'|'error', row }
let order = [];            // current display order (symbols)
let ranks = new Map();     // symbol -> 1-based rank, for rankable rows only
let ranksDemo = false;     // is the current result set a demo scan
let scanSeq = 0;           // newest scan wins; stale responses dropped
let dirFilter = 'all';     // 'all' | 'rich' | 'cheap'
let aiBusy = false;
let aiState = new Map();    // symbol -> { status, read?, error? }

// ---------------------------------------------------------------- watchlist

function sanitizeSym(s) { return String(s || '').toUpperCase().replace(/[^A-Z^_.]/g, '').slice(0, 8); }
function sanitizeList(a) {
  const seen = new Set(), out = [];
  for (const s of a) { const c = sanitizeSym(s); if (c && !seen.has(c)) { seen.add(c); out.push(c); } }
  return out.slice(0, MAX_WATCH);
}
function loadWatchlist() {
  try { const a = JSON.parse(localStorage.getItem(LS_KEY)); if (Array.isArray(a) && a.length) return sanitizeList(a); }
  catch { /* corrupt or absent -> defaults */ }
  return [...DEFAULT_WATCHLIST];
}
function saveWatchlist() { try { localStorage.setItem(LS_KEY, JSON.stringify(watchlist)); } catch { /* private mode */ } }

function addSym(raw) {
  const c = sanitizeSym(raw);
  if (!c) return;
  if (watchlist.includes(c)) { banner(`${c} is already in the watchlist.`); return; }
  if (watchlist.length >= MAX_WATCH) { banner(`Watchlist is capped at ${MAX_WATCH} tickers.`); return; }
  banner('');
  watchlist.push(c); saveWatchlist(); renderWatchlist();
}
function removeSym(sym) { watchlist = watchlist.filter((s) => s !== sym); saveWatchlist(); renderWatchlist(); }
function resetWatchlist() { watchlist = [...DEFAULT_WATCHLIST]; saveWatchlist(); renderWatchlist(); banner(''); }

function renderWatchlist() {
  const wrap = $('#watchlist');
  wrap.replaceChildren();
  if (!watchlist.length) { wrap.append(el('span', { className: 'desc', text: 'Watchlist empty — add a ticker or Reset to defaults.' })); return; }
  for (const sym of watchlist) {
    const chip = el('span', { className: 'wchip' }, [el('span', { text: sym })]);
    const x = el('span', { className: 'x', title: `Remove ${sym}`, text: '×', role: 'button', tabindex: '0', 'aria-label': `Remove ${sym}` });
    x.addEventListener('click', () => removeSym(sym));
    x.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); removeSym(sym); } });
    chip.append(x);
    wrap.append(chip);
  }
}

function banner(msg) {
  const b = $('#banner');
  if (!msg) { b.className = ''; b.replaceChildren(); return; }
  b.className = 'show'; b.textContent = msg;
}

// ---------------------------------------------------------------- scan

function progress(done, total) {
  const bar = $('#progress');
  if (done >= total) { bar.className = ''; return; }
  bar.className = 'show';
  bar.querySelector('.fill').style.width = `${total ? (done / total) * 100 : 0}%`;
}

async function fetchRow(symbol) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ROW_TIMEOUT);
  try {
    const res = await fetch(`api/scan/row?symbol=${encodeURIComponent(symbol)}`, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    return await res.json(); // the endpoint always 200s with an ok or error row
  } catch (err) {
    return { symbol, ok: false, error: err.name === 'AbortError' ? 'timed out' : err.message };
  } finally {
    clearTimeout(t);
  }
}

async function runScan() {
  if (!watchlist.length) { banner('Add at least one ticker before scanning.'); return; }
  const seq = ++scanSeq;
  banner(''); dirFilter = 'all'; syncDirChips();
  ranksDemo = false; aiBusy = false; // a fresh scan supersedes any in-flight AI read (its seq guard drops it)
  aiState = new Map(); renderPicks(); $('#aibtn').disabled = true;
  // snapshot the symbol list: editing the watchlist mid-scan must not disturb the
  // in-flight run (a worker indexing a live-mutated array would hit an unseeded
  // symbol and throw, killing the pool and freezing the grid)
  const syms = [...watchlist];
  results = new Map(); order = [...syms]; ranks = new Map();
  for (const s of syms) results.set(s, { symbol: s, status: 'queued', row: null });
  renderTable(); renderSummary();
  document.querySelector('.grid').classList.add('loading');
  progress(0, syms.length);
  $('#stamp').textContent = `Scanning ${syms.length} ticker${syms.length > 1 ? 's' : ''}…`;

  let idx = 0, done = 0;
  const worker = async () => {
    while (idx < syms.length) {
      const s = syms[idx++];
      const entry = results.get(s);
      entry.status = 'loading';
      const row = await fetchRow(s);
      if (seq !== scanSeq) return; // superseded
      entry.status = row.ok === false ? 'error' : 'done';
      entry.row = row;
      progress(++done, syms.length);
      renderTable(); // reflect the arrival, still in watchlist order until the scan settles
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, syms.length) }, worker));
  if (seq !== scanSeq) return;
  progress(syms.length, syms.length);
  finishScan(seq, false);
}

function finishScan(seq, demo) {
  if (seq !== scanSeq) return;
  ranksDemo = demo;
  computeRanked();
  renderTable();
  renderSummary();
  document.querySelector('.grid').classList.remove('loading');
  const scanned = [...results.values()].filter((e) => e.row && e.row.ok !== false).length;
  const errs = [...results.values()].filter((e) => e.status === 'error' || (e.row && e.row.ok === false)).length;
  const src = demo ? 'synthetic demo scan' : sourceLabel();
  $('#stamp').textContent = `${scanned} of ${results.size} ranked · ${errs ? `${errs} error${errs > 1 ? 's' : ''} · ` : ''}${src} · as of ${new Date().toLocaleTimeString()}`;
  const anyRankable = [...results.values()].some((e) => e.row && e.row.rankable);
  $('#aibtn').disabled = aiBusy || !anyRankable;
  // runScan/demoScan reset aiState, wiping the saved-read cards — restore them
  // (rehydrateReads only fills symbols with no live entry, so it can never
  // overwrite a read the user just generated)
  rehydrateReads();
}

function sourceLabel() {
  const srcs = new Set([...results.values()].map((e) => e.row && e.row.source).filter(Boolean));
  return srcs.size === 1 ? [...srcs][0] : 'mixed sources';
}

// partition rankable / low-data / error; rank the rankable by |score|
function computeRanked() {
  const bucket = (e) => (!e.row || e.row.ok === false ? 2 : e.row.rankable ? 0 : 1);
  const arr = [...results.values()].sort((a, b) => {
    const ba = bucket(a), bb = bucket(b);
    if (ba !== bb) return ba - bb;
    if (ba === 0) {
      const dm = (b.row.magnitude ?? 0) - (a.row.magnitude ?? 0);
      if (dm) return dm;
      const dc = (b.row.confidence ?? 0) - (a.row.confidence ?? 0);
      if (dc) return dc;
    }
    return a.symbol.localeCompare(b.symbol);
  });
  order = arr.map((e) => e.symbol);
  ranks = new Map();
  let n = 0;
  for (const e of arr) if (bucket(e) === 0) ranks.set(e.symbol, ++n);
}

// ---------------------------------------------------------------- table render

function renderTable() {
  const tb = $('#scanbody');
  tb.replaceChildren();
  let shown = 0;
  for (const sym of order) {
    const e = results.get(sym);
    if (!e) continue;
    if (dirFilter !== 'all') { // filter only applies to finished rankable rows
      const dir = e.row && e.row.rankable ? e.row.direction : null;
      if (dir !== dirFilter) continue;
    }
    tb.append(rowTr(e));
    shown++;
  }
  if (!shown) {
    tb.append(el('tr', {}, [el('td', { className: 'l muted', colSpan: 17, text: order.length ? 'No rows match this filter.' : 'Nothing scanned yet — press Scan or Demo scan.' })]));
  }
}

function shortSource(source) {
  if (!source) return '';
  if (/tradier/i.test(source)) return 'tradier';
  if (/cboe/i.test(source)) return 'cboe · ~15m';
  return source;
}

function tdSym(sym, source) {
  const cell = el('td', { className: 'l' }, [el('span', { className: 'sym', text: sym })]);
  const s = shortSource(source);
  if (s) cell.append(el('div', { className: 'subsym', text: s }));
  return cell;
}

function rowTr(e) {
  const sym = e.symbol, row = e.row;
  const tr = el('tr', {});

  if (e.status === 'queued' || e.status === 'loading') {
    tr.className = 'unranked';
    tr.append(el('td', { className: 'l', text: '' }), tdSym(sym, null),
      el('td', { className: 'l muted', colSpan: 15, text: e.status === 'loading' ? 'scanning…' : 'queued' }));
    return tr;
  }
  if (!row || row.ok === false) {
    tr.className = 'errorrow';
    tr.append(el('td', { className: 'l', text: '' }), tdSym(sym, null),
      el('td', { className: 'l muted', colSpan: 15, text: `could not scan${row && row.error ? `: ${row.error}` : ''}` }));
    return tr;
  }

  const rank = ranks.get(sym);
  tr.className = rank === 1 ? 'rank1' : row.rankable ? '' : 'unranked';
  tr.append(el('td', { className: 'l' }, [el('span', { className: 'rankbadge', text: rank ? `#${rank}` : '·' })]));
  tr.append(tdSym(sym, row.source));
  tr.append(el('td', { text: fmtStrike(row.spot) }));
  tr.append(el('td', {}, [scoreCell(row)]));
  tr.append(el('td', { className: 'l' }, [whyChips(row)]));

  const v = row.vol || {};
  tr.append(el('td', { text: v.iv30 != null ? v.iv30.toFixed(1) : '—' }));
  tr.append(el('td', { text: v.rv21 != null ? v.rv21.toFixed(1) : '—' }));
  tr.append(el('td', { text: sgn(v.vrp, 1) }));
  tr.append(el('td', { text: sgn(v.slope, 1) }));
  tr.append(el('td', { text: v.fly != null ? sgn(v.fly, 2) : '—' }));
  tr.append(el('td', { text: v.skew != null ? sgn(v.skew, 1) : '—' }));
  tr.append(el('td', { className: 'l' }, [convexityChip(v.convexity)]));

  const g = row.gamma || {};
  const dot = el('span', { className: 'regimedot', style: `background:${g.regime === 'positive' ? 'var(--pos)' : 'var(--neg)'}` });
  tr.append(el('td', { className: 'groupstart l muted' }, [dot, document.createTextNode(g.regime === 'positive' ? 'long γ' : 'short γ')]));
  tr.append(el('td', { className: 'muted', text: g.net_gex != null ? fmtDollars(g.net_gex) : '—' }));
  tr.append(wallCell(g.call_wall, g.call_wall_pct));
  tr.append(wallCell(g.put_wall, g.put_wall_pct));
  tr.append(wallCell(g.flip, g.flip_pct));

  // whole-row click-through to the detail dashboard (not for synthetic demo names)
  if (row.source !== 'demo') {
    tr.addEventListener('click', () => { location.href = `index.html?symbol=${encodeURIComponent(sym)}`; });
  }
  return tr;
}

function wallCell(level, pct) {
  const cell = el('td', { className: 'muted' });
  if (level == null) { cell.textContent = '—'; return cell; }
  cell.append(document.createTextNode(fmtStrike(level)));
  if (pct != null) cell.append(el('span', { className: 'subsym', text: ` ${sgn(pct, 1)}%` }));
  return cell;
}

function convexityChip(verdict) {
  if (!verdict) return el('span', { className: 'muted', text: '—' });
  const cls = verdict === 'bid' ? 'rich' : verdict === 'offered' ? 'cheap' : 'fairtxt';
  return el('span', { className: cls, text: verdict });
}

// diverging score cell: numeric + RICH/CHEAP/FAIR word + a mini diverging bar
// (never color-alone — the number and the word carry it too)
function scoreCell(row) {
  const cell = el('div', { className: 'score' });
  if (row.score == null) {
    cell.append(el('span', { className: 'num fairtxt', text: '—' }));
    cell.append(makeBar(0, 'fair'));
    cell.append(el('span', { className: 'dir fairtxt', text: row.data_flags && row.data_flags.no_vol ? 'NO VOL' : 'LOW DATA' }));
    return cell;
  }
  const dirClass = row.direction === 'rich' ? 'rich' : row.direction === 'cheap' ? 'cheap' : 'fairtxt';
  cell.append(el('span', { className: `num ${dirClass}`, text: `${row.score >= 0 ? '+' : ''}${row.score.toFixed(2)}` }));
  cell.append(makeBar(row.score, row.direction));
  cell.append(el('span', { className: `dir ${dirClass}`, text: (row.direction || 'fair').toUpperCase() }));

  // tooltip: the signal breakdown behind the score
  cell.addEventListener('pointermove', (ev) => showTip(ev.clientX, ev.clientY, `${row.symbol} · score ${row.score.toFixed(2)}`,
    (row.signals || []).map((s) => ({ label: `${WHY_TEXT[s.name] ? WHY_TEXT[s.name](s.x >= 0) : s.name}`, value: `${s.contribution >= 0 ? '+' : ''}${s.contribution.toFixed(2)}` }))
      .concat([{ label: 'coverage', value: `${Math.round((row.coverage ?? 0) * 100)}%` }])));
  cell.addEventListener('pointerleave', hideTip);
  return cell;
}

function makeBar(score, direction) {
  const bar = el('div', { className: 'bar' }, [el('div', { className: 'maxis' })]);
  const mag = Math.min(1, Math.abs(score || 0));
  if (mag > 0.001 && direction !== 'fair') {
    const half = 41; // px; half the 84px track
    const f = el('div', { className: 'f' });
    if (score >= 0) { f.style.left = '50%'; f.style.width = `${mag * half}px`; f.style.background = 'var(--neg)'; }
    else { f.style.right = '50%'; f.style.width = `${mag * half}px`; f.style.background = 'var(--pos)'; }
    bar.append(f);
  }
  return bar;
}

function whyChips(row) {
  const wrap = el('div', { className: 'whys' });
  const signals = row.signals || [];
  if (!signals.length) { wrap.append(el('span', { className: 'muted', text: '—' })); return wrap; }
  const top = signals.find((s) => s.name === row.topSignal);
  const ordered = [];
  if (top) ordered.push(top);
  for (const s of signals.filter((s) => s.fired).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))) {
    if (s.name !== row.topSignal) ordered.push(s);
  }
  let n = 0;
  for (const s of ordered) {
    if (n >= 3) break;
    if (s.name === 'conv' && s.name !== row.topSignal) continue; // suppress the redundant corroborator unless it's the headline
    const rich = s.x >= 0;
    wrap.append(el('span', { className: `why ${rich ? 'rich' : 'cheap'}`, text: WHY_TEXT[s.name] ? WHY_TEXT[s.name](rich) : s.name }));
    n++;
  }
  if (!n) wrap.append(el('span', { className: 'muted', text: 'no strong signal' }));
  return wrap;
}

// ---------------------------------------------------------------- summary tiles

function renderSummary() {
  const tiles = $('#summary');
  tiles.replaceChildren();
  const entries = [...results.values()];
  if (!entries.length) return;
  const okRows = entries.filter((e) => e.row && e.row.ok !== false);
  const errs = entries.filter((e) => e.status === 'error' || (e.row && e.row.ok === false));
  const rankable = okRows.filter((e) => e.row.rankable);
  const byMag = (dir) => rankable.filter((e) => e.row.direction === dir).sort((a, b) => b.row.magnitude - a.row.magnitude)[0];
  const rich = byMag('rich'), cheap = byMag('cheap');
  const vrps = okRows.map((e) => e.row.vol && e.row.vol.vrp).filter((x) => x != null && isFinite(x)).sort((a, b) => a - b);
  const med = vrps.length ? (vrps.length % 2 ? vrps[(vrps.length - 1) / 2] : (vrps[vrps.length / 2 - 1] + vrps[vrps.length / 2]) / 2) : null;

  const defs = [
    { label: 'Universe', value: String(entries.length), hint: ranksDemo ? 'demo tickers' : 'in watchlist' },
    { label: 'Scanned', value: String(okRows.length), hint: errs.length ? `${errs.length} could not load` : 'all loaded' },
    { label: 'Most rich', value: rich ? rich.symbol : '—', hint: rich ? `score +${rich.row.score.toFixed(2)}` : 'none rich', dot: rich ? 'var(--neg)' : null },
    { label: 'Most cheap', value: cheap ? cheap.symbol : '—', hint: cheap ? `score ${cheap.row.score.toFixed(2)}` : 'none cheap', dot: cheap ? 'var(--pos)' : null },
    { label: 'Median VRP', value: med == null ? '—' : `${med >= 0 ? '+' : ''}${med.toFixed(1)}`, hint: 'iv30 − realized, pts' },
  ];
  for (const d of defs) {
    const value = el('div', { className: 'value' });
    if (d.dot) value.append(el('span', { className: 'dot', style: `background:${d.dot}` }));
    value.append(document.createTextNode(d.value));
    tiles.append(el('div', { className: 'tile' }, [
      el('div', { className: 'label', text: d.label }), value, el('div', { className: 'hint', text: d.hint }),
    ]));
  }
}

// ---------------------------------------------------------------- AI top picks (reuses /api/analyze)

async function readTopPicks() {
  if (aiBusy) return;
  const picks = [...results.values()]
    // demo rows are excluded like rowTr's click-through: a synthetic ticker's
    // read would spend real credits and archive a fake-market journal record
    .filter((e) => e.row && e.row.rankable && e.row.source !== 'demo' && (e.row.confidence ?? 0) >= AI_MIN_CONFIDENCE && e.row.snapshot)
    .sort((a, b) => b.row.magnitude - a.row.magnitude)
    .slice(0, AI_TOP);
  const out = $('#aipicks');
  if (!picks.length) { out.replaceChildren(el('p', { className: 'desc', text: 'No high-confidence ranked names yet — run a scan first.' })); return; }

  const seq = scanSeq;
  aiBusy = true; $('#aibtn').disabled = true;
  // fresh picks lead the panel; saved reads for names outside this run keep
  // their card (still labeled with their timestamp) instead of vanishing
  const kept = [...aiState.entries()].filter(([sym, st]) => st.saved && !picks.some((p) => p.symbol === sym));
  aiState = new Map([...picks.map((p) => [p.symbol, { status: 'loading' }]), ...kept]);
  renderPicks();

  let idx = 0;
  const worker = async () => {
    while (idx < picks.length) {
      const p = picks[idx++];
      const res = await fetchRead(p.row.snapshot);
      if (seq !== scanSeq) return;
      aiState.set(p.symbol, res.error ? { status: 'error', error: res.error } : { status: 'done', read: res.read, asof: res.asof });
      renderPicks();
    }
  };
  await Promise.all(Array.from({ length: Math.min(AI_POOL, picks.length) }, worker));
  aiBusy = false;
  if (seq === scanSeq) $('#aibtn').disabled = false;
}

async function fetchRead(snapshot) {
  try {
    const res = await fetch('api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot) });
    const j = await res.json();
    if (!res.ok) return { error: j.error || `HTTP ${res.status}` };
    return { read: j.read, asof: j.asof };
  } catch (err) {
    return { error: err.message };
  }
}

// Saved reads survive navigation: every fresh read is archived server-side, so
// on page load (and after a scan) the panel rehydrates each watchlist name's
// most recent saved read — timestamped — instead of demanding a re-run. Never
// overwrites an entry already in aiState (a fresh/loading read always wins).
async function rehydrateReads() {
  if (!watchlist.length) return;
  try {
    const res = await fetch('api/reads/latest?symbols=' + encodeURIComponent(watchlist.join(',')));
    if (!res.ok) return;
    const { reads } = await res.json();
    let added = false;
    for (const sym of watchlist) {
      const rec = reads && reads[sym];
      if (!rec || !rec.read || aiState.has(sym)) continue;
      aiState.set(sym, { status: 'done', read: rec.read, asof: rec.asof, saved: true });
      added = true;
    }
    if (added) renderPicks();
  } catch { /* server down or no reads yet — the panel just stays empty */ }
}

function fmtAsof(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (!isFinite(d)) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function renderPicks() {
  const out = $('#aipicks');
  if (!aiState.size) { out.replaceChildren(); return; }
  out.replaceChildren(...[...aiState.entries()].map(([sym, st]) => pickCard(sym, st)));
}

function pickCard(sym, st) {
  const card = el('div', { className: 'aipick' });
  const head = el('div', { className: 'head' }, [el('span', { className: 'sym', text: sym })]);
  if (st.status === 'done' && st.read) {
    head.append(el('span', { className: 'aichip', text: REGIME_LABELS[st.read.regime.label] || st.read.regime.label }));
    // every read is timestamped; a rehydrated one says so — age is part of the signal
    const when = fmtAsof(st.asof);
    if (when) head.append(el('span', { className: 'aiwhen', text: st.saved ? `saved · ${when}` : when }));
  }
  card.append(head);
  if (st.status === 'loading') { card.append(el('p', { className: 'desc', text: 'reading the book…' })); return card; }
  if (st.status === 'error') { card.append(el('p', { className: 'desc', text: `AI read unavailable: ${st.error}` })); return card; }

  const read = st.read;
  card.append(el('p', { className: 'lead', text: read.one_liner }));
  const t = (read.trade_structures || []).slice().sort((a, b) => (CONF_RANK[a.confidence] ?? 3) - (CONF_RANK[b.confidence] ?? 3))[0];
  if (t) {
    const p = el('p', { className: 'struct' });
    p.append(el('b', { text: `${t.name}: ` }));
    p.append(document.createTextNode(t.structure));
    // rubric v2 sizes every structure to the account — surface the cost + conviction
    const bits = [];
    if (isFinite(t.est_max_risk_usd)) bits.push(`~$${Math.round(t.est_max_risk_usd)} max risk`);
    if (t.confidence) bits.push(`${t.confidence} confidence`);
    if (bits.length) p.append(el('span', { className: 'risk', text: ` · ${bits.join(' · ')}` }));
    card.append(p);
  }
  card.append(el('a', { className: 'more', href: `index.html?symbol=${encodeURIComponent(sym)}`, text: 'full read →' }));
  return card;
}

// ---------------------------------------------------------------- tooltip (app.js idiom)

const tip = $('#tip');
function showTip(clientX, clientY, headText, rows) {
  tip.replaceChildren(el('div', { className: 't-head', text: headText }));
  for (const r of rows) tip.append(el('div', { className: 't-row' }, [el('span', { text: r.label }), el('b', { text: r.value })]));
  tip.style.display = 'block';
  const rect = tip.getBoundingClientRect();
  let x = clientX + 14, y = clientY + 14;
  if (x + rect.width > window.innerWidth - 8) x = clientX - rect.width - 14;
  if (y + rect.height > window.innerHeight - 8) y = clientY - rect.height - 14;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
function hideTip() { tip.style.display = 'none'; }

// ---------------------------------------------------------------- demo scan (offline)

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

// a spread of synthetic names: base implied vol (pts), realized target (pts),
// term slope (pts, negative = backwardation), put-over-call skew (pts). sparse
// kills the quotes so the row lands in the low-data bucket (shows that path).
const DEMO = [
  { sym: 'RICHY', spot: 420, ivBase: 34, rv: 20, termSlope: -4, skew: 6 },
  { sym: 'TAILS', spot: 135, ivBase: 30, rv: 22, termSlope: -2, skew: 12 },
  { sym: 'SQUEEZ', spot: 52, ivBase: 72, rv: 46, termSlope: -8, skew: 9 },
  { sym: 'FAIRO', spot: 6100, ivBase: 14, rv: 12, termSlope: 2, skew: 4 },
  { sym: 'GRIND', spot: 245, ivBase: 18, rv: 19, termSlope: 4, skew: 3 },
  { sym: 'CALM', spot: 410, ivBase: 12, rv: 13, termSlope: 5, skew: 3 },
  { sym: 'CHEAPO', spot: 88, ivBase: 24, rv: 40, termSlope: 6, skew: 2 },
  { sym: 'THIN', spot: 60, ivBase: 28, rv: 20, termSlope: 0, skew: 5, sparse: true },
];

function demoChain(d) {
  const rnd = mulberry32(hashSeed(d.sym));
  const now = Date.now();
  const options = [];
  const dtes = [2, 7, 16, 30, 45, 70];
  const step = d.spot > 1000 ? 25 : d.spot > 200 ? 5 : 1;
  const lo = Math.round((d.spot * 0.82) / step) * step, hi = Math.round((d.spot * 1.18) / step) * step;
  for (const dte of dtes) {
    const expiry = now + Math.max(dte * 86400e3, 4 * 3600e3);
    const T = Math.max((expiry - now) / GexExposure.MS_YEAR, 1 / (365 * 96));
    const termAdj = d.termSlope * (Math.sqrt(dte / 30) - 1); // vol pts vs the 30d anchor
    for (let K = lo; K <= hi; K += step) {
      const money = (K - d.spot) / d.spot;
      const iv = Math.max(0.05, (d.ivBase + termAdj) / 100 + (-d.skew * money + 30 * money * money) / 100);
      const decay = Math.exp(-dte / 30);
      const callOi = Math.round(4000 * decay * Math.exp(-Math.pow((money - 0.02) / 0.05, 2)) * (0.5 + rnd()));
      const putOi = Math.round(5200 * decay * Math.exp(-Math.pow((money + 0.03) / 0.06, 2)) * (0.5 + rnd()));
      const quote = (type) => {
        if (d.sparse) return { bid: 0, ask: 0.05 }; // no live market -> vol calc can't price it
        const mid = GexMetrics.bsPrice(d.spot, K, T, iv, GexExposure.RISK_FREE, type);
        if (!isFinite(mid) || mid < 0.05) return { bid: 0, ask: 0.05 };
        return { bid: mid * 0.98, ask: mid * 1.02 };
      };
      const base = { root: d.sym, strike: K, expiry, dte, T, iv, volume: 0, gammaQuoted: NaN };
      options.push({ ...base, type: 'C', oi: callOi, ...quote('C') });
      options.push({ ...base, type: 'P', oi: putOi, ...quote('P') });
    }
  }
  return { symbol: d.sym, spot: d.spot, timestamp: new Date(now).toISOString(), source: 'demo', options };
}

function demoCloses(rv, seed) {
  const rnd = mulberry32(seed);
  const n = 40, dv = (rv / 100) / Math.sqrt(252);
  const c = [100];
  for (let i = 1; i < n; i++) {
    const g = (rnd() + rnd() + rnd() + rnd() + rnd() + rnd() - 3) / Math.sqrt(0.5); // ~N(0,1)
    c.push(c[i - 1] * Math.exp(g * dv));
  }
  return c;
}

function demoScan() {
  const seq = ++scanSeq;
  banner(''); dirFilter = 'all'; syncDirChips();
  ranksDemo = false; aiBusy = false;
  aiState = new Map(); renderPicks(); $('#aibtn').disabled = true;
  results = new Map();
  progress(0, DEMO.length);
  for (const d of DEMO) {
    const chain = demoChain(d);
    const closes = demoCloses(d.rv, hashSeed(`${d.sym}|rv`));
    const row = GexExposure.scanRowFromChain(chain, closes, GexMetrics, { vixOfficial: 16.5, source: 'demo' });
    results.set(d.sym, { symbol: d.sym, status: row.ok === false ? 'error' : 'done', row });
  }
  progress(DEMO.length, DEMO.length);
  finishScan(seq, true);
}

// ---------------------------------------------------------------- wiring

function syncDirChips() {
  for (const c of document.querySelectorAll('#dirfilter .chip')) c.setAttribute('aria-pressed', String(c.dataset.dir === dirFilter));
}

$('#scan').addEventListener('click', runScan);
$('#demo').addEventListener('click', demoScan);
$('#reset').addEventListener('click', resetWatchlist);
$('#add').addEventListener('click', () => { addSym($('#addsym').value); $('#addsym').value = ''; $('#addsym').focus(); });
$('#addsym').addEventListener('keydown', (e) => { if (e.key === 'Enter') { addSym($('#addsym').value); $('#addsym').value = ''; } });
$('#aibtn').addEventListener('click', readTopPicks);
$('#dirfilter').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-dir]');
  if (!chip) return;
  dirFilter = chip.dataset.dir; syncDirChips(); renderTable();
});

if (typeof GexExposure === 'undefined' || typeof GexMetrics === 'undefined') {
  banner('Scanner failed to load its math modules (metrics.js / exposure.js). Reload the page.');
}
renderWatchlist();
rehydrateReads(); // surface each watchlist name's last saved read without spending a credit
