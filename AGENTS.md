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

The **Desktop** tab is a full Linux desktop (wallpaper + taskbar), **not** an embedded game view. The mountain wallpaper is the VM background — the game runs **inside Chrome**.

1. Ensure the dev server is running: `npm run dev` (or use repo `.cursor/environment.json` terminals, which start it automatically).
2. Open **Google Chrome** on the Desktop taskbar (bottom of the pane).
3. Go to **http://localhost:5173/** (or **http://127.0.0.1:5173/**).
4. You should see **Loading…** then the **Blade Arena** title over the arena → **Enter the Arena**.
5. If the cursor does not lock, **drag on the canvas** to aim; **right-click** to move.

After environment setup, a terminal may auto-launch Chrome to that URL once Vite is ready.

### Gotchas

- Embedded Desktop iframes used to report `document.hidden` and freeze the game loop — fixed; hard-refresh if the preview looks stuck.
- Distant mountains are hidden on the title screen; menu camera frames the play area.
- HMR can restore a bad session — full page reload fixes it; embedded preview always resets to the title screen.
- If the preview iframe has not laid out yet, `ResizeObserver` on `#app` resizes the canvas once dimensions are known.
- Uncaught startup errors show a **Blade Arena could not start** panel instead of a blank view.
- Do not use `#app canvas` in CSS — it also matches the minimap and stretches the 2D map fullscreen (looks like a circle arena and triangle player). Use `#app > canvas.game-canvas` only.
- **FPS overlay (T)** shows honest **redraw FPS** (how often WebGL draws), not monitor refresh. The Desktop VM pane often caps redraw near **15 FPS**; open **http://localhost:5173/** in normal Chrome for smoother play.
