'use strict';

/* Archive backend: writes/reads the brain-snapshot and AI-read history that
 * backtest-reads.js grades against. Two backends share one interface so
 * local dev and Vercel production can never drift in behavior:
 *
 *   - fs (default): the original on-disk layout under gex/data/{brain,reads}/
 *     — used whenever BLOB_READ_WRITE_TOKEN is unset, i.e. always for
 *     `node gex/server.js` locally.
 *   - Vercel Blob: used when BLOB_READ_WRITE_TOKEN is set (Vercel injects it
 *     automatically once a Blob store is connected to the project) — the
 *     serverless functions in gex/api/ have no persistent local filesystem,
 *     so this is what keeps /api/reads and /api/reads/latest working there.
 *
 * Pathnames are identical between backends (`{SYMBOL}/{YYYY-MM-DD}/{file}`,
 * prefixed `brain/` or `reads/`), so existing local archives need no
 * migration to move to Blob later.
 *
 * GEX_NO_ARCHIVE=1 disables both backends everywhere. */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from './env.js';

export const ARCHIVE_OFF = !!process.env.GEX_NO_ARCHIVE;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';
const BACKEND = BLOB_TOKEN ? 'blob' : 'fs';

const ARCHIVE_DIR = path.resolve(process.env.GEX_ARCHIVE_DIR || path.join(ROOT, 'data', 'brain'));
const READS_DIR = path.resolve(process.env.GEX_READS_DIR || path.join(ROOT, 'data', 'reads'));
export const READ_FILE_RE = /^\d{9}Z-read\.json$/; // HHMMSSmmmZ-read.json

// lazily imported: @vercel/blob is only a dependency of the deployed
// function bundle, and must never be required by local `node gex/server.js`
let blobApi = null;
async function blob() {
  if (!blobApi) blobApi = await import('@vercel/blob');
  return blobApi;
}

function sanitizeSymbol(symbol) {
  return String(symbol || '').toUpperCase().replace(/[^A-Z0-9^_.]/g, '');
}

// ---------------------------------------------------------------- writes

export function archiveBrainSnapshot(symbol, body, now, sourceLabel) {
  if (ARCHIVE_OFF) return;
  const iso = new Date(now).toISOString();
  const day = iso.slice(0, 10);
  const stamp = iso.slice(11, 19).replace(/:/g, '') + 'Z';
  const tag = /tradier/i.test(sourceLabel || '') ? 'tradier' : /cboe/i.test(sourceLabel || '') ? 'cboe' : 'src';
  const sym = symbol.replace(/[^A-Z0-9^_.]/gi, '');
  const rel = path.posix.join(sym, day, `${stamp}-${tag}.json`);
  if (BACKEND === 'blob') {
    blob().then(({ put }) => put(`brain/${rel}`, body, {
      access: 'public', addRandomSuffix: false, contentType: 'application/json', token: BLOB_TOKEN,
    })).catch((err) => console.error(`[gex] blob archive ${symbol} failed: ${err.message}`));
    return;
  }
  const dir = path.join(ARCHIVE_DIR, sym, day);
  const file = path.join(dir, `${stamp}-${tag}.json`);
  fs.promises.mkdir(dir, { recursive: true })
    .then(() => fs.promises.writeFile(file + '.tmp', body))
    .then(() => fs.promises.rename(file + '.tmp', file))
    .catch((err) => console.error(`[gex] archive ${symbol} failed: ${err.message}`));
}

export function archiveRead(symbol, record) {
  if (ARCHIVE_OFF) return;
  const sym = sanitizeSymbol(symbol);
  if (!sym) return;
  if (/demo/i.test(String(record.snapshot?.source || '')) || /demo/i.test(String(symbol || ''))) return;
  const iso = record.asof;
  const day = iso.slice(0, 10);
  const stamp = iso.slice(11, 23).replace(/[:.]/g, '') + 'Z-read.json';
  const rel = path.posix.join(sym, day, stamp);
  const body = JSON.stringify(record);
  if (BACKEND === 'blob') {
    blob().then(({ put }) => put(`reads/${rel}`, body, {
      access: 'public', addRandomSuffix: false, contentType: 'application/json', token: BLOB_TOKEN,
    })).catch((err) => console.error(`[gex] blob read archive ${sym} failed: ${err.message}`));
    return;
  }
  const dir = path.join(READS_DIR, sym, day);
  const file = path.join(dir, stamp);
  fs.promises.mkdir(dir, { recursive: true })
    .then(() => fs.promises.writeFile(file + '.tmp', body))
    .then(() => fs.promises.rename(file + '.tmp', file))
    .catch((err) => console.error(`[gex] read archive ${sym} failed: ${err.message}`));
}

// ---------------------------------------------------------------- read-journal lookups
// (only the AI-read journal is read back by a live route; brain snapshots
// are archived for offline backtest-reads.js and never served)

async function listReadDaysFs(sym) {
  const symDir = path.normalize(path.join(READS_DIR, sym));
  if (!symDir.startsWith(READS_DIR + path.sep)) return [];
  try { return (await fs.promises.readdir(symDir)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(); }
  catch { return []; }
}
async function listReadFilesFs(sym, day) {
  try {
    return (await fs.promises.readdir(path.join(READS_DIR, sym, day))).filter((f) => READ_FILE_RE.test(f)).sort();
  } catch { return []; }
}
async function getReadFileFs(sym, day, file) {
  return fs.promises.readFile(path.join(READS_DIR, sym, day, file), 'utf8');
}

async function listReadDaysBlob(sym) {
  const { list } = await blob();
  const days = new Set();
  let cursor;
  do {
    const page = await list({ prefix: `reads/${sym}/`, cursor, token: BLOB_TOKEN });
    for (const b of page.blobs) {
      const m = /^reads\/[^/]+\/(\d{4}-\d{2}-\d{2})\//.exec(b.pathname);
      if (m) days.add(m[1]);
    }
    cursor = page.cursor;
  } while (cursor);
  return [...days].sort();
}
async function listReadFilesBlob(sym, day) {
  const { list } = await blob();
  const files = [];
  let cursor;
  const prefix = `reads/${sym}/${day}/`;
  do {
    const page = await list({ prefix, cursor, token: BLOB_TOKEN });
    for (const b of page.blobs) {
      const name = b.pathname.slice(prefix.length);
      if (READ_FILE_RE.test(name)) files.push(name);
    }
    cursor = page.cursor;
  } while (cursor);
  return files.sort();
}
async function getReadFileBlob(sym, day, file) {
  const { head } = await blob();
  const meta = await head(`reads/${sym}/${day}/${file}`, { token: BLOB_TOKEN });
  const res = await fetch(meta.url);
  if (!res.ok) throw new Error(`blob fetch HTTP ${res.status}`);
  return res.text();
}

export function listReadDays(symbol) {
  const sym = sanitizeSymbol(symbol);
  return BACKEND === 'blob' ? listReadDaysBlob(sym) : listReadDaysFs(sym);
}
export function listReadFiles(symbol, day) {
  const sym = sanitizeSymbol(symbol);
  return BACKEND === 'blob' ? listReadFilesBlob(sym, day) : listReadFilesFs(sym, day);
}
export function getReadFile(symbol, day, file) {
  const sym = sanitizeSymbol(symbol);
  return BACKEND === 'blob' ? getReadFileBlob(sym, day, file) : getReadFileFs(sym, day, file);
}

// latest saved read for each symbol, newest day/file first
export async function latestReadFor(symbol) {
  const sym = sanitizeSymbol(symbol);
  const days = await listReadDays(sym);
  for (let i = days.length - 1; i >= 0; i--) {
    const files = await listReadFiles(sym, days[i]);
    if (files.length) return JSON.parse(await getReadFile(sym, days[i], files[files.length - 1]));
  }
  return null;
}

// ---------------------------------------------------------------- fs-only maintenance
// Startup compaction/pruning is a local-dev / long-running-process concept;
// a stateless serverless invocation has no business doing it, and Blob
// storage retention is managed separately (see gex/README.md).

const COMPACT_OFF = !!process.env.GEX_NO_COMPACT;
const SNAP_FILE_RE = /^\d{6}Z-[a-z]{1,12}\.json$/;
const ARCHIVE_KEEP_DAYS = Number(process.env.GEX_ARCHIVE_KEEP_DAYS || 0);
const gzipAsync = (buf) => new Promise((resolve, reject) => zlib.gzip(buf, (e, out) => (e ? reject(e) : resolve(out))));

async function compactDay(dayDir) {
  let n = 0, saved = 0;
  let files = [];
  try { files = await fs.promises.readdir(dayDir); } catch { return [0, 0]; }
  for (const f of files) {
    if (!SNAP_FILE_RE.test(f)) continue;
    const raw = path.join(dayDir, f), gz = raw + '.gz';
    try {
      const buf = await fs.promises.readFile(raw);
      const out = await gzipAsync(buf);
      await fs.promises.writeFile(gz + '.tmp', out);
      await fs.promises.rename(gz + '.tmp', gz);
      await fs.promises.unlink(raw);
      n++; saved += buf.length - out.length;
    } catch { /* raced a read/write/prune — leave this file for the next pass */ }
  }
  return [n, saved];
}

export async function archiveMaintenance() {
  if (ARCHIVE_OFF || BACKEND === 'blob') return;
  let fileCount = 0, byteCount = 0, pruned = 0, compacted = 0, savedBytes = 0;
  const dayNames = new Set();
  const today = new Date(Date.now()).toISOString().slice(0, 10);
  const cutoff = ARCHIVE_KEEP_DAYS > 0
    ? new Date(Date.now() - ARCHIVE_KEEP_DAYS * 86400e3).toISOString().slice(0, 10)
    : null;
  try {
    const symbols = await fs.promises.readdir(ARCHIVE_DIR);
    for (const sym of symbols) {
      const symDir = path.join(ARCHIVE_DIR, sym);
      let days = [];
      try { days = (await fs.promises.readdir(symDir)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)); } catch { continue; }
      for (const day of days) {
        const dayDir = path.join(symDir, day);
        if (cutoff && day < cutoff) {
          await fs.promises.rm(dayDir, { recursive: true, force: true });
          pruned++;
          continue;
        }
        if (!COMPACT_OFF && day < today) {
          const [n, saved] = await compactDay(dayDir);
          compacted += n; savedBytes += saved;
        }
        dayNames.add(day);
        try {
          const files = await fs.promises.readdir(dayDir);
          fileCount += files.length;
          for (const f of files) {
            try { byteCount += (await fs.promises.stat(path.join(dayDir, f))).size; } catch { /* raced a write */ }
          }
        } catch { /* raced a prune */ }
      }
    }
    console.log('[gex] brain archive: %d snapshots, %s MB, %d day(s)%s%s%s',
      fileCount, (byteCount / 1e6).toFixed(1), dayNames.size,
      compacted ? ` · compacted ${compacted} file(s), saved ${(savedBytes / 1e6).toFixed(1)} MB` : '',
      pruned ? ` · pruned ${pruned} day-dir(s) older than ${ARCHIVE_KEEP_DAYS}d` : '',
      pruned || ARCHIVE_KEEP_DAYS ? '' : ' · retention: keep forever (GEX_ARCHIVE_KEEP_DAYS to prune)');
  } catch { /* no archive yet */ }
}

export const ARCHIVE_BACKEND = BACKEND;
export { ARCHIVE_DIR, READS_DIR };
