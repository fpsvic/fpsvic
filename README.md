# Blade Arena

A browser-based 3D melee battle arena built with Vite, TypeScript, and Three.js. Features PBR-style lighting, procedural terrain with normal maps, humanoid fighters, and performance-focused rendering.

## Features

- Third-person click-to-move controls with camera rotation
- Melee-only combat with knives, swords, axes, and spears
- Enemy bots that chase and attack the player
- Weapon pickups with different damage, range, cooldown, and knockback
- Shrinking storm ring, health, score, alive count, and win/lose screens

## Controls

- Right click (on ground): Walk to that point
- Left mouse drag: Rotate camera
- `A`: Slash in front of you (release before 2s = normal; hold 2s+ then release = charged)
- `Space`: Dash toward move target
- `E`: Pick up nearby weapon
- `R`: Restart after a match

## Development

```bash
npm install
npm run dev
```

Open **http://localhost:5173/** in your browser.

### Cursor Cloud Desktop tab

The **Desktop** pane shows the VM’s Linux desktop (wallpaper and taskbar), not the game inline. Click **Chrome** on the taskbar and open **http://localhost:5173/**. With `.cursor/environment.json`, the dev server and browser launch are started automatically in agent VMs.

Create a production build with:

```bash
npm run build
```
