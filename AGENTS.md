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

### If the Desktop tab says “Could not connect to Desktop”

This message is a **Cursor Cloud streaming issue** between your IDE and the agent VM—not a game bug. Retry often loops when the client cannot reach the remote desktop session.

**Workaround (play the game without Desktop):**

1. Keep this cloud agent run active and ensure `npm run dev` is running (port **5173**).
2. In the **agent panel**, open the **port forwarding** menu (plug icon, top-right).
3. Forward port **5173** and open **`http://localhost:5173`** in Cursor’s built-in browser (or your local browser if forwarded).
4. Click **Enter the Arena** on the title screen.

**On your machine:**

- Check [status.cursor.com](https://status.cursor.com/) for Cloud Agents / IDE incidents.
- **Cursor Settings → Network → Run Diagnostics**; disable VPN/proxy or enable **HTTP Compatibility Mode (HTTP/1.1)** on corporate networks.
- Start a **new agent run** if the run is stuck on environment setup or shows environment warnings.
- For live Desktop, use a model/run that supports **computer use** (forum reports Composer-only runs may not expose Desktop).

**In the VM (agent can verify):** `pgrep -af vite`, `curl -sI http://127.0.0.1:5173/`, and that noVNC is listening (internal ports are not user-forwarded).
