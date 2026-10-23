# Chess Realms

A stylised isometric 3D real-time war game in the browser. Two kingdoms, Sun and Moon, fight over a living battlefield. A chessboard, the War Table, commands the same war.

This repository is at **milestone 2**: the 3D battlefield from milestone 1, plus animated soldiers you can select and command. They march in formation over a pathfinding grid that respects rivers, crossings, roads and forest, and a Moon patrol walks its route. Combat, the economy and the War Table are not built yet.

Reports: [milestone 1](docs/MILESTONE-1.md) and [milestone 2](docs/MILESTONE-2.md). Each says exactly what works and what does not.

## Run it

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm test         # unit tests (Vitest)
pnpm build        # production build in apps/web/dist
npx playwright test   # browser tests (builds and serves the app first)
```

You need Node 20 or later and pnpm 10.

## Layout

```
apps/web/            React + Vite client
  src/world/         3D scene: merged terrain chunks, buildings, sea, markers
  src/camera/        RTS camera maths (rts.ts, pure + tested) and input (CameraRig.tsx)
  src/hud/           React HUD: resources, toolbar, minimap, selection, field log
  src/assets/        Model kit loader, chunk merging, LOD
  src/units/         Soldiers: animation baking, instanced rendering, tokens, markers
  src/sim/runner.ts  Runs the game-core sim at 10 Hz in the browser; input becomes commands
  public/assets/     kit.glb (packed models, built by tools/build-assets.mjs)
  e2e/               Playwright tests
packages/game-core/  Pure TypeScript: hex grid, seeded RNG, map, auto-tiling, balance,
                     simulation (tick, units, commands, distance-field pathfinding), AI
packages/chess-core/ Standard chess rules via chess.js (custom rules stay separate)
tools/               Asset packing, atlas tweak, tile-edge measurement, map printout, perf matrix
docs/                Milestone reports, asset licences, architecture notes
```

## Principles

- **The simulation lives outside React.** `game-core` is plain TypeScript that runs the same on the server and in the browser. React only renders menus and the HUD. The camera and per-frame values never go through React state.
- **Standard chess stays standard.** `chess-core` only wraps chess.js. The battlefield effects of chess moves (bonds) will be a separate, documented rules layer (milestone 5).
- **Nothing pretends.** Controls that do not work yet are shown as locked, with the milestone that delivers them. Readouts that are not simulated yet say so.

## Assets

Models are from the KayKit Medieval Hexagon Pack and Adventurers Character Pack by Kay Lousberg, both CC0. See [docs/ASSETS.md](docs/ASSETS.md).
