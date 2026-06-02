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

1. Run `npm run dev` and open **http://localhost:5173/** in the Desktop pane (not an old port).
2. You should see **Loading…** then the **Blade Arena** title over the arena.
3. Click **Enter the Arena**. Mountains/forests only show during a match.
4. If the cursor does not lock, **drag on the canvas** to aim; **right-click** to move.

### Gotchas

- Embedded Desktop iframes used to report `document.hidden` and freeze the game loop — fixed; hard-refresh if the preview looks stuck.
- Distant mountains are hidden on the title screen; menu camera frames the play area.
- HMR can restore a bad session — full page reload fixes it; embedded preview always resets to the title screen.
- If the preview iframe has not laid out yet, `ResizeObserver` on `#app` resizes the canvas once dimensions are known.
- Uncaught startup errors show a **Blade Arena could not start** panel instead of a blank view.
