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

The dev and preview scripts bind to `0.0.0.0`, and Vite is configured to allow hosted preview domains.

Create a production build with:

```bash
npm run build
```
