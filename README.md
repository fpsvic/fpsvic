# Blade Drop Arena

A browser-based 3D melee battle arena built with Vite, TypeScript, and Three.js. Features procedural rolling terrain, humanoid fighters with walk cycles, and performance-focused rendering (instancing, pooled effects, selective shadows).

## Features

- Third-person click-to-move controls with camera rotation
- Melee-only combat with knives, swords, axes, and spears
- Enemy bots that chase and attack the player
- Weapon pickups with different damage, range, cooldown, and knockback
- Shrinking storm ring, health, score, alive count, and win/lose screens

## Controls

- Right click (on ground): Walk to that point
- Left mouse drag: Rotate camera
- `F`: Attack (release before 2s = normal hit; hold 2s+ then release = charged hit)
- `Space`: Dash toward move target
- `E`: Pick up nearby weapon
- `R`: Restart after a match

## Development

```bash
npm install
npm run dev
```

Create a production build with:

```bash
npm run build
```
