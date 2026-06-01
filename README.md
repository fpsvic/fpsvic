# Blade Drop Arena

A browser-based 3D melee battle arena prototype built with Vite, TypeScript, and Three.js.

## Features

- Third-person 3D movement with mouse aiming
- Melee-only combat with knives, swords, axes, and spears
- Enemy bots that chase and attack the player
- Weapon pickups with different damage, range, cooldown, and knockback
- Shrinking storm ring, health, score, alive count, and win/lose screens

## Controls

- `WASD`: Move
- Mouse: Aim camera
- Left click: Slash
- `Space`: Dash
- `E`: Pick up nearby weapon
- `R`: Restart after a match

## Development

```bash
npm install
npm run dev
```

The dev and preview scripts bind to `0.0.0.0` on port `3000`, and Vite is configured to allow hosted preview domains.

If the terminal is already showing `VITE ready`, leave that process running and open the preview for port `3000`. To run another command in the same terminal, stop Vite first with `Ctrl+C`.

Create a production build with:

```bash
npm run build
```
