# fpsvic projects

## Personal GEX

A free, self-hosted options gamma-exposure dashboard (net GEX by strike, gamma flip,
call/put walls, vanna & charm) using CBOE's free delayed data. No dependencies:

```bash
node gex/server.js   # then open http://localhost:8787
```

See [gex/README.md](gex/README.md).

# Merge Guys

A browser-based 2D merge defense and fantasy arena prototype built with Vite, TypeScript, and Canvas.

## Features

- Toxic green menu flow with username validation, tutorial, and 24-hour local leaderboard
- Normal mode base defense with buy buttons, zombie waves, draggable guys, and box merging
- Fantasy mode shop with persistent bank balance and 30 purchasable fighter levels
- Fantasy arena with WASD movement, mouse/Z shooting, bots, food pickups, shelter, dragon lair, minimap, and win/lose screens

## Controls

- Normal mode: drag a guy onto another guy, or drag a box around multiple guys, to merge them
- Fantasy mode: `WASD` or arrow keys to move
- Fantasy mode: mouse click or `Z` to shoot
- Menu buttons: choose mode, open tutorial, view leaderboard, buy fighters, and return home

## Development

```bash
npm install
npm run dev
```

Create a production build with:

```bash
npm run build
```

# Dodge Blitz (mobile)

A native mobile arcade game — drag to dodge falling obstacles, survive as
long as possible — implemented separately in Swift (iOS/SpriteKit) and
Kotlin (Android). See [mobile/README.md](mobile/README.md) for build
instructions.
