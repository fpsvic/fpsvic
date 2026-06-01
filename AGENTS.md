# AGENTS.md

## Cursor Cloud specific instructions

### Product

**Blade Drop Arena** — a client-only browser game (Vite + TypeScript + Three.js). There is no backend, database, or Docker stack. End-to-end testing means serving the app and exercising it in a browser with WebGL.

### Services

| Service | Port | Command |
|---------|------|---------|
| Vite dev server (primary) | 5173 (default) | `npm run dev` |
| Vite preview (production build) | 4173 (default) | `npm run build` then `npm run preview` |

Only one HTTP server is required. Use `--host 127.0.0.1` when binding from tmux/background sessions if you need a predictable URL.

### Standard commands

See `README.md` and `package.json` scripts:

- **Install deps:** `npm install`
- **Dev server:** `npm run dev`
- **Typecheck + production build:** `npm run build` (runs `tsc` then `vite build`)
- **Preview build:** `npm run preview`

There is no dedicated `lint` or `test` script in this repo; `npm run build` is the main automated quality gate (TypeScript compile + Vite bundle).

### Gotchas

- The game requires **pointer lock** for mouse aim: click the canvas before expecting camera/movement controls.
- Controls: WASD move, mouse aim, left-click slash, Space dash, E pickup, R restart after a match.
- No `.env` files or external API keys are needed for local development.
