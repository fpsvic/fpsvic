'use strict';

/* Side-effect module: loads gex/.env (if present) into process.env, then
 * exports ROOT (the gex/ directory, one level up from lib/) that every other
 * lib module and the Vercel functions resolve static assets against.
 *
 * On Vercel there is no gex/.env file (secrets come from the project's env
 * vars instead), so the readFileSync below just throws into the empty catch
 * and this module becomes a no-op beyond exporting ROOT. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  const ENV_FILE_WINS = new Set(['TRADIER_TOKEN', 'ANTHROPIC_API_KEY']);
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = m[2].replace(/^(["'])(.*)\1$/, '$2');
    if (!value) continue;
    if (!(key in process.env)) {
      process.env[key] = value;
    } else if (ENV_FILE_WINS.has(key) && process.env[key] !== value) {
      console.warn(`[gex] ${key}: shell environment holds a different value than gex/.env — using gex/.env`);
      process.env[key] = value;
    }
  }
} catch { /* no .env file — fine (always the case on Vercel) */ }
