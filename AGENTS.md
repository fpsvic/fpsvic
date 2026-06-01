# AGENTS.md

## Cursor Cloud specific instructions

### Product

Single browser app: **Blade Drop Arena** (`fpsvic`) — Vite + TypeScript + Three.js. No backend, database, or Docker services.

### Services

| Service | Command | Notes |
|---------|---------|-------|
| Dev server (required) | `npm run dev` | Vite on **http://0.0.0.0:5173** (required for Cursor Desktop preview) |
| Production preview (optional) | `npm run build` then `npm run preview` | Serves `dist/` on port **4173** |

### Lint / test / build

- **Lint:** not configured (no ESLint or `lint` script).
- **Tests:** not configured (no test runner or `test` script).
- **Typecheck + build:** `npm run build` runs `tsc` then `vite build`.
- **Typecheck only:** `npx tsc --noEmit`.

### Development workflow

1. `npm install` (also runs on VM startup via the update script).
2. `npm run dev` — open **http://localhost:5173/** in Desktop preview (or port-forwarded URL), click **Start match**, then use WASD / mouse / click.

### Gotchas

- The game starts on a **start panel**; click **Start match** (or press `R` after a match ends) before movement and combat work.
- **Desktop preview / iframe:** pointer lock is often blocked. The game falls back to **drag on the canvas to aim**; WASD and click-to-attack still work.
- If Desktop shows a blank page, confirm `npm run dev` is running and the preview URL uses port **5173** (not a stale port).
- `npm run build` may warn about chunk size (>500 kB); that is expected for the bundled Three.js app.
