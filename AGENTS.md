# AGENTS.md

## Cursor Cloud specific instructions

### Product

**Blade Arena** — browser 3D melee battle royale (Vite + TypeScript + Three.js). No backend.

### Services

| Service | Command | Notes |
|---------|---------|-------|
| Dev server | `npm run dev` | **http://localhost:5173/** — `0.0.0.0` for Desktop preview |
| Production preview | `npm run build` && `npm run preview` | Port **4173** |

### Desktop preview

1. Run `npm run dev` and open **http://localhost:5173/** in the Desktop pane.
2. You should see the **Blade Arena** title card over the arena (not a empty mountain vista).
3. Click **Enter the Arena** to start. Mountains/forests only appear during a match.
4. If pointer lock fails in the iframe, **right-click** to move and **drag LMB** to rotate the camera.

### Gotchas

- Distant mountains are hidden on the title screen; if you only see mountains, hard-refresh the preview URL.
- HMR can restore a `playing` session without enemies — reload the page or press `R` after a match ends.
