# AGENTS.md

## Cursor Cloud specific instructions

### Product

Single browser app: **Blade Drop Arena** (`fpsvic`) — Vite + TypeScript + Three.js. No backend, database, or Docker services.

### Services

| Service | Command | Notes |
|---------|---------|-------|
| Dev server (required) | `npm run dev` | Vite on port **5173** by default; use `-- --host 0.0.0.0` when accessing from outside the VM |
| Production preview (optional) | `npm run build` then `npm run preview` | Serves `dist/` |

### Lint / test / build

- **Lint:** not configured (no ESLint or `lint` script).
- **Tests:** not configured (no test runner or `test` script).
- **Typecheck + build:** `npm run build` runs `tsc` then `vite build`.
- **Typecheck only:** `npx tsc --noEmit`.

### Development workflow

1. `npm install` (also runs on VM startup via the update script).
2. `npm run dev` — open http://localhost:5173/, click **Start match**, then use WASD / mouse / click per `README.md`.

### Gotchas

- The game starts on a **start panel**; click **Start match** (or press `R` after a match ends) before movement and combat work.
- Pointer lock for mouse aim requires clicking the WebGL canvas during play; automated browser tests can still verify HUD and match start without pointer lock.
- `npm run build` may warn about chunk size (>500 kB); that is expected for the bundled Three.js app.
